import { createHash, randomUUID } from "node:crypto";
import {
  createSession,
  resumeSession,
  listModels,
  COMPACTION_TIMEOUT,
  SessionReplacementError,
  TimeoutError as DroidTimeoutError,
  type DroidSession,
  type DroidMcpServerConfig,
  type GetContextStatsResult,
} from "@factory/droid-sdk/node";
import { execCommand } from "@getpaseo/plugin/server";
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderRegistration,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderCatalog,
  type ProviderSessionConfig,
  type ProviderTimelineItem,
  type ProviderPrompt,
  type ProviderMcpServerConfig,
  type ProviderPersistence,
  type ProviderUsage,
  type ProviderCommand,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { createDroidTransport, withDroidDeadline } from "./transport";
import { DroidTimeline } from "./timeline";
import { Permissions } from "./permissions";
import { modeSettings, presentCatalog, configState, reasoning } from "./catalog";
import { preparePrompt, type PreparedPrompt } from "./attachments";
import { createSteeringTransport, SteeringRejectedError } from "./steering";
import { createPermissionCompatibilityTransport } from "./permission-compatibility";
import { updateSessionSettings, DroidSettingsTimeoutError } from "./settings";
import { TimelinePersistence } from "./persistence";
import { FileSnapshotStore, type SnapshotStore } from "./snapshot-store";
import { observeSession, type NativeUpdate, type NativeCompletion } from "./session-events";
import {
  createCommandTransport, presentCommands, selectedCommand, supportsCommands, builtinCommands,
  formatContext, readSessionLimits, type NativeCommand,
} from "./commands";

export const supported = ["prompt.message", "prompt.command", "prompt.image", "prompt.steer", "session.configure", "session.persistence", "permission", "permission.tool_policy"] as const;
const optionsSchema = z.object({
  disableBuiltinSkills: z.boolean().optional(),
  disabledToolIds: z.array(z.string()).optional(),
}).strict();
type OpenInput = Extract<ProviderInput, { type: "session.open" }>;
type Transport = Awaited<ReturnType<typeof createDroidTransport>>;
export interface DroidDependencies {
  createSession: typeof createSession;
  resumeSession: typeof resumeSession;
  listModels: typeof listModels;
  transport: typeof createDroidTransport;
  steering?: typeof createSteeringTransport;
  preparePrompt?: typeof preparePrompt;
  /** Telemetry must never close a healthy session when a stats RPC stalls. */
  contextTimeoutMs?: number;
  settingsTimeoutMs?: number;
  /** Internal test override; bounded startup snapshots require no extra RPC. */
  usageReplayDelaysMs?: readonly number[];
  snapshotStore?: SnapshotStore;
  version?: (launch: ProviderLaunch) => Promise<string | undefined>;
  commands?: typeof createCommandTransport;
  limits?: typeof readSessionLimits;
  commandTimeoutMs?: number;
  compactionTimeoutMs?: number;
}
const defaults: DroidDependencies = { createSession, resumeSession, listModels, transport: createDroidTransport };

export function createDroidProvider(deps: DroidDependencies = defaults): ProviderRegistration {
  return {
    id: "droid-native",
    label: "Droid Native",
    description: "Factory Droid through its direct SDK protocol",
    icon: "icon.svg",
    command: ["droid"],
    async status({ launch }) {
      if (!launch) return { available: false, diagnostic: "Install Droid and run `droid` once to sign in." };
      try {
        const { stdout } = await execCommand(launch.command, [...launch.args, "--version"], { env: launch.env, timeout: 5000, maxBuffer: 8192 });
        const version = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(stdout);
        if (!version) return { available: false, diagnostic: "Droid returned an unrecognized version." };
        return Number(version[1]) > 0 || Number(version[2]) >= 244
          ? { available: true } : { available: false, diagnostic: `Update Droid: found ${version[0]}, need 0.244.0 or later for steering and attachments.` };
      } catch {
        return { available: false, diagnostic: "Cannot launch Droid. Check the provider command and sign in with `droid`." };
      }
    },
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      if (!request.launch) throw new Error("Droid requires a daemon-resolved executable");
      const commandsRequested = request.capabilities.includes("prompt.command");
      let commandsAvailable = false;
      if (commandsRequested) {
        try {
          const version = await (deps.version ?? droidVersion)(request.launch);
          commandsAvailable = supportsCommands(version);
        } catch { /* Version discovery must not disable existing message sessions. */ }
      }
      return connection(request.launch, negotiateProviderCapabilities(request.capabilities,
        commandsAvailable ? supported : supported.filter((value) => value !== "prompt.command")), deps, commandsRequested);
    },
  };
}

type TurnOutcome = { state: "completed" | "failed" | "canceled"; error?: { message: string } };
interface Turn {
  id: string;
  origin: "foreground" | "background";
  nativeId?: string;
  streamDone?: Promise<void>;
  releaseStream?: () => void;
  finished: Promise<void>;
  releaseFinished: () => void;
  outcome?: TurnOutcome;
  finishing?: boolean;
}
interface Slot {
  id: string;
  config: ProviderSessionConfig;
  native?: DroidSession;
  transport?: Transport;
  steering?: ReturnType<typeof createSteeringTransport>;
  commands?: ReturnType<typeof createCommandTransport>;
  commandList: ProviderCommand[];
  customCommands: NativeCommand[];
  skills: Awaited<ReturnType<DroidSession["listSkills"]>>["skills"];
  commandDiscovery?: Promise<void>;
  commandDiscoveryWarning?: boolean;
  commandWork?: Promise<void>;
  commandKind?: string;
  opening?: Promise<void>;
  task?: Promise<void>;
  busy: boolean;
  interrupting: boolean;
  activeTurnId?: string;
  turnInput?: AbortController;
  steerWork: Promise<void>;
  closing: boolean;
  lifetime: AbortController;
  permissions: Permissions;
  timeline: DroidTimeline;
  items: Map<string, ProviderTimelineItem>;
  persistenceBuilder: TimelinePersistence;
  itemRevision: number;
  savedRevision: number;
  savedNativeId?: string;
  catalog: ProviderCatalog;
  usage: ProviderUsage;
  contextRevision: number;
  contextModelId?: string;
  usageReplayTimers: Set<ReturnType<typeof setTimeout>>;
  textFlushTimer?: ReturnType<typeof setTimeout>;
  turn?: Turn;
  nextNativeTurnId?: string;
  completedNativeTurns: Set<string>;
  eventWork: Promise<void>;
  saveWork: Promise<void>;
  lastPersistence?: ProviderPersistence;
  saveWarning: boolean;
  unsubscribe?: () => void;
  failed: boolean;
  releaseEvents: () => void;
}

function connection(launch: ProviderLaunch, capabilities: readonly string[], deps: DroidDependencies, commandsRequested: boolean): ProviderConnection {
  const sessions = new Map<string, Slot>();
  const listeners = new Set<(event: ProviderEvent) => void>();
  // Coalesce overlapping discoveries only. Completed catalogs must not make a
  // later session inherit an old model list or multiplier indefinitely.
  const catalogs = new Map<string, Promise<ProviderCatalog>>();
  const catalogTransports = new Set<Transport>();
  const snapshotStore = deps.snapshotStore ?? new FileSnapshotStore();
  let closed = false;
  function emit(event: ProviderEvent) {
    if (!closed) for (const listener of listeners) listener(event);
  }
  function item(slot: Slot, value: ProviderTimelineItem) {
    if (slot.items.get(value.id) !== value) slot.itemRevision++;
    slot.items.set(value.id, value);
    emit({ type: "timeline.item", sessionId: slot.id, item: value });
  }
  function cancelTextFlush(slot: Slot) {
    if (slot.textFlushTimer) clearTimeout(slot.textFlushTimer);
    slot.textFlushTimer = undefined;
  }
  function flushText(slot: Slot) {
    cancelTextFlush(slot);
    for (const value of slot.timeline.flush()) item(slot, value);
  }
  function scheduleTextFlush(slot: Slot) {
    if (!slot.timeline.hasPendingText) { cancelTextFlush(slot); return; }
    if (slot.textFlushTimer) return;
    slot.textFlushTimer = setTimeout(() => {
      slot.textFlushTimer = undefined;
      if (closed || slot.closing) return;
      flushText(slot);
    }, 50);
  }
  function persistenceWarning(slot: Slot) {
    emit({ type: "session.notice", sessionId: slot.id, notice: {
      id: "droid-persistence-write-failed", severity: "warning", title: "Droid timeline was not saved",
      description: "The previous saved state is retained. Check the local snapshot storage and available disk space; saving will be retried at the next checkpoint.",
    } });
  }
  async function save(slot: Slot, publish = true, required = false): Promise<ProviderPersistence | undefined> {
    if (!slot.native || !slot.config.persist) return;
    const revision = slot.itemRevision;
    if (slot.savedRevision === revision && slot.savedNativeId === slot.native.id) return slot.lastPersistence;
    // Capture immutable row snapshots before waiting for another disk write.
    const snapshot = slot.persistenceBuilder.build(slot.native.id, slot.config.cwd, slot.items);
    const nativeId = slot.native.id;
    let failed = false;
    const work = slot.saveWork.then(async () => {
      if (slot.savedRevision >= revision && slot.savedNativeId === nativeId) return;
      try {
        // A replacement must get a new head. Never change the identity behind an
        // earlier handle that another Paseo instance may still have cached.
        const previousId = (slot.lastPersistence?.data as { nativeSessionId?: string } | undefined)?.nativeSessionId;
        const persistence = await snapshotStore.save(snapshot, previousId === nativeId ? slot.lastPersistence : undefined);
        slot.lastPersistence = persistence;
        slot.savedRevision = revision;
        slot.savedNativeId = nativeId;
        slot.saveWarning = false;
        if (publish) emit({ type: "session.persistence", sessionId: slot.id, persistence });
      } catch {
        failed = true;
        if (!slot.saveWarning) {
          slot.saveWarning = true;
          if (publish) persistenceWarning(slot);
        }
      }
    });
    slot.saveWork = work;
    await work;
    if (required && failed) throw new Error("Droid completed compaction, but the new session state could not be saved. Keep this session open and restore snapshot storage before retrying or reloading.");
    return slot.lastPersistence;
  }

  function enqueue(slot: Slot, work: () => Promise<void> | void): Promise<void> {
    slot.eventWork = slot.eventWork.then(work).catch(async () => {
      await failRuntime(slot, new Error("Droid event processing failed"));
    });
    return slot.eventWork;
  }
  function beginTurn(slot: Slot, origin: Turn["origin"], controller = new AbortController()): Turn {
    let releaseFinished!: () => void;
    const finished = new Promise<void>((resolve) => { releaseFinished = resolve; });
    const turn: Turn = { id: randomUUID(), origin, finished, releaseFinished };
    if (origin === "foreground") {
      turn.streamDone = new Promise<void>((resolve) => { turn.releaseStream = resolve; });
    } else {
      // A native background wakeup can race asynchronous attachment preparation.
      slot.turnInput?.abort(new Error("Droid started background work; retry or steer the active turn."));
      turn.nativeId = slot.nextNativeTurnId;
    }
    slot.nextNativeTurnId = undefined;
    slot.turn = turn;
    slot.turnInput = controller;
    slot.activeTurnId = turn.id;
    slot.busy = true;
    if (origin === "background") emit({ type: "session.turn", sessionId: slot.id, turnId: turn.id, state: "started" });
    return turn;
  }
  function rememberCompletion(slot: Slot, nativeId?: string) {
    if (!nativeId) return;
    slot.completedNativeTurns.add(nativeId);
    if (slot.completedNativeTurns.size > 256) slot.completedNativeTurns.delete(slot.completedNativeTurns.values().next().value!);
  }
  async function finishTurn(slot: Slot, turn: Turn, outcome: TurnOutcome) {
    if (slot.turn !== turn) return;
    turn.finishing = true;
    // SDK iterator cleanup must finish before the host is allowed to send again.
    await turn.streamDone;
    outcome = slot.closing || slot.interrupting ? { state: "canceled" } : turn.outcome ?? outcome;
    flushText(slot);
    for (const value of slot.timeline.finishTools(outcome.state)) item(slot, value);
    slot.permissions.cancelAll();
    slot.turnInput?.abort(new Error("Droid turn ended"));
    await save(slot);
    rememberCompletion(slot, turn.nativeId);
    slot.timeline.release();
    await refreshCommands(slot);
    slot.turn = undefined;
    slot.activeTurnId = undefined;
    slot.busy = false;
    emit({ type: "session.turn", sessionId: slot.id, turnId: turn.id, ...outcome });
    turn.releaseFinished();
    void refreshContext(slot);
  }
  function completionOutcome(completion: NativeCompletion): TurnOutcome {
    if (completion.reason === "completed" || completion.reason === "spec_handoff") return { state: "completed" };
    if (completion.reason === "cancelled" || completion.reason === "permission_rejected") return { state: "canceled" };
    return { state: "failed", error: { message: `Droid turn ended: ${completion.reason}` } };
  }
  async function nativeUpdate(slot: Slot, update: NativeUpdate) {
    if (slot.closing || closed || slot.failed) return;
    if (update.type === "completion") {
      const completion = update.completion;
      if (completion.turnId && slot.completedNativeTurns.has(completion.turnId)) return;
      let turn = slot.turn;
      if (turn?.nativeId && completion.turnId && turn.nativeId !== completion.turnId) return;
      if (!turn) {
        // Empty autonomous turns can complete without a text/tool notification.
        if (!completion.turnId) return;
        slot.nextNativeTurnId = completion.turnId;
        turn = beginTurn(slot, "background");
      }
      turn.nativeId ??= completion.turnId;
      publishUsage(slot, {
        inputTokens: completion.tokenUsage.inputTokens, outputTokens: completion.tokenUsage.outputTokens,
        cachedInputTokens: completion.tokenUsage.cacheReadTokens,
      }, turn.id);
      await finishTurn(slot, turn, completionOutcome(completion));
      return;
    }
    const event = update.message;
    if (event.type === "user" && event.message.content.some((block) => block.type === "text")) {
      if (!slot.turn) slot.nextNativeTurnId = event.message.id;
      else if (slot.turn.origin === "foreground" && !slot.turn.nativeId && event.message.visibility !== "llm_only")
        slot.turn.nativeId = event.message.id;
    }
    const work = event.type === "working_state_changed" ? event.state !== "idle"
      : event.type === "assistant_text_delta" || event.type === "thinking_text_delta" || event.type === "assistant" ||
        event.type === "tool_call" || event.type === "tool_call_delta";
    if (work && !slot.turn) beginTurn(slot, "background");
    for (const value of slot.timeline.handle(event)) item(slot, value);
    scheduleTextFlush(slot);
    if (event.type === "settings_updated") {
      emit({ type: "session.config", sessionId: slot.id, config: configState(slot.native!, slot.catalog) });
      void refreshContext(slot);
    }
    if (event.type === "token_usage_update") publishUsage(slot, {
      inputTokens: event.inputTokens, outputTokens: event.outputTokens, cachedInputTokens: event.cacheReadTokens,
    }, slot.activeTurnId);
  }
  async function failRuntime(slot: Slot, error: Error) {
    if (slot.closing || slot.failed || closed) return;
    slot.failed = true;
    slot.unsubscribe?.();
    slot.unsubscribe = undefined;
    cancelTextFlush(slot);
    cancelUsageReplays(slot);
    slot.permissions.cancelAll();
    slot.turnInput?.abort(error);
    slot.steering?.cancelPending(error);
    await slot.transport?.close();
    if (slot.turn) await finishTurn(slot, slot.turn, { state: "failed", error: { message: error.message } });
    emit({ type: "session.runtime_failed", sessionId: slot.id, error: { message: error.message } });
  }
  function watchTransport(slot: Slot, transport: Transport): Transport {
    return {
      get isConnected() { return transport.isConnected; },
      send: (value) => transport.send(value), onMessage: (handler) => transport.onMessage(handler), close: () => transport.close(),
      onError(handler) { transport.onError((error) => {
        try { handler(error); }
        finally {
          if (!slot.closing && !closed) void enqueue(slot, () => failRuntime(slot, new Error("Droid process connection failed; reopen the session to continue.")));
        }
      }); },
    };
  }
  function publishUsage(slot: Slot, update: ProviderUsage, turnId?: string) {
    // Paseo replaces lastUsage rather than merging patches. Keep context and
    // the latest reported per-turn counters together in every usage event.
    slot.usage = { ...slot.usage, ...update };
    emit({ type: "session.usage", sessionId: slot.id, ...(turnId ? { turnId } : {}), usage: { ...slot.usage } });
  }
  function cancelUsageReplays(slot: Slot) {
    for (const timer of slot.usageReplayTimers) clearTimeout(timer);
    slot.usageReplayTimers.clear();
  }
  function scheduleUsageReplays(slot: Slot) {
    // Paseo's manager subscribes after asynchronous session registration and
    // does not replay the adapter's early usage history. Repeat cached state a
    // bounded number of times, reading the current snapshot at delivery time.
    for (const delay of deps.usageReplayDelaysMs ?? [250, 1000, 3000]) {
      const timer = setTimeout(() => {
        slot.usageReplayTimers.delete(timer);
        if (closed || slot.closing || slot.lifetime.signal.aborted || sessions.get(slot.id) !== slot || !Object.keys(slot.usage).length) return;
        publishUsage(slot, {});
      }, delay);
      slot.usageReplayTimers.add(timer);
    }
    slot.lifetime.signal.addEventListener("abort", () => cancelUsageReplays(slot), { once: true });
    if (slot.lifetime.signal.aborted) cancelUsageReplays(slot);
  }
  async function refreshContext(slot: Slot) {
    if (!slot.native || closed || slot.closing || slot.lifetime.signal.aborted) return;
    const native = slot.native;
    const model = native.settings.modelId;
    if (slot.contextModelId !== model) {
      slot.contextModelId = model;
      // The old model's capacity is not evidence for the new model. Paseo
      // replaces lastUsage, so an omitted context pair explicitly clears its
      // meter while preserving the latest reported per-turn token counters.
      if (slot.usage.contextWindowMaxTokens !== undefined || slot.usage.contextWindowUsedTokens !== undefined) {
        slot.usage = { ...slot.usage };
        delete slot.usage.contextWindowMaxTokens;
        delete slot.usage.contextWindowUsedTokens;
        publishUsage(slot, {});
      }
    }
    const revision = ++slot.contextRevision;
    const stats = await contextStats(native, slot.lifetime.signal, deps.contextTimeoutMs ?? 2000);
    if (!stats || closed || slot.closing || slot.lifetime.signal.aborted || sessions.get(slot.id) !== slot ||
        slot.native !== native || slot.contextRevision !== revision || native.settings.modelId !== model) return;
    if (!Number.isFinite(stats.limit) || stats.limit <= 0 || !Number.isFinite(stats.used) || stats.used < 0) return;
    publishUsage(slot, { contextWindowMaxTokens: stats.limit, contextWindowUsedTokens: stats.used });
  }
  async function catalog(cwd?: string, env: Readonly<Record<string, string>> = {}): Promise<ProviderCatalog> {
    // The launch is fixed for this connection, but session overlays can select
    // another Factory account/configuration. Do not share those discoveries.
    const key = createHash("sha256").update(JSON.stringify([cwd ?? "", Object.entries(env).sort(([a], [b]) => a.localeCompare(b))])).digest("hex");
    let pending = catalogs.get(key);
    if (!pending) {
      pending = (async () => {
        const transport = await deps.transport(launch, { cwd, env });
        catalogTransports.add(transport);
        if (closed) { await transport.close(); catalogTransports.delete(transport); throw new Error("Droid connection is closed"); }
        try { return presentCatalog(await withDroidDeadline(transport, () => deps.listModels({ transport }))); }
        finally { await transport.close(); catalogTransports.delete(transport); }
      })();
      catalogs.set(key, pending);
      const current = pending;
      const retire = () => { if (catalogs.get(key) === current) catalogs.delete(key); };
      void pending.then(retire, retire);
    }
    return pending;
  }
  function subscribeNative(slot: Slot & { native: DroidSession }) {
    slot.unsubscribe?.();
    const native = slot.native;
    slot.unsubscribe = observeSession(native, (update) => {
      void enqueue(slot, () => slot.native === native ? nativeUpdate(slot, update) : undefined);
    });
  }
  async function refreshCommands(slot: Slot): Promise<void> {
    if (!slot.commands || !slot.native || closed || slot.closing || slot.failed) return;
    if (slot.commandDiscovery) return slot.commandDiscovery;
    const native = slot.native;
    const work = (async () => {
      const options = { signal: slot.lifetime.signal, timeoutMs: deps.commandTimeoutMs ?? 5000 };
      const [custom, skills] = await Promise.allSettled([
        slot.commands!.list(options),
        commandWait(() => native.listSkills(), options.signal, options.timeoutMs),
      ]);
      if (slot.native !== native || closed || slot.closing || slot.failed) return;
      if (custom.status === "fulfilled") slot.customCommands = custom.value;
      if (skills.status === "fulfilled") slot.skills = skills.value.skills;
      slot.commandList = presentCommands(slot.customCommands, slot.skills, slot.config.providerOptions?.disableBuiltinSkills === true);
      emit({ type: "session.commands", sessionId: slot.id, commands: slot.commandList });
      if (custom.status === "rejected" || skills.status === "rejected") {
        slot.commandDiscoveryWarning = true;
        emit({ type: "session.notice", sessionId: slot.id, notice: {
          id: "droid-commands-discovery", severity: "warning", title: "Some Droid commands could not be refreshed",
          description: "The last available commands are retained. Discovery will retry after the next turn or when this session reopens.",
        } });
      } else if (slot.commandDiscoveryWarning) {
        slot.commandDiscoveryWarning = false;
        emit({ type: "session.notice", sessionId: slot.id, notice: {
          id: "droid-commands-discovery", severity: "warning", title: "Some Droid commands could not be refreshed", dismissed: true,
        } });
      }
    })();
    slot.commandDiscovery = work;
    try { await work; } finally { if (slot.commandDiscovery === work) slot.commandDiscovery = undefined; }
  }
  async function open(input: OpenInput) {
    if (sessions.has(input.sessionId)) throw new Error("Session already open");
    let releaseEvents!: () => void;
    const opened = new Promise<void>((resolve) => { releaseEvents = resolve; });
    const slot: Slot = {
      id: input.sessionId, config: input.config, busy: false, interrupting: false, steerWork: Promise.resolve(), closing: false, lifetime: new AbortController(),
      permissions: new Permissions(input.sessionId, emit, input.config.toolPolicy),
      timeline: new DroidTimeline(), items: new Map(), catalog: { models: [], modes: [] }, usage: {}, contextRevision: 0, usageReplayTimers: new Set(),
      persistenceBuilder: new TimelinePersistence(), itemRevision: 0, savedRevision: -1,
      commandList: [], customCommands: [], skills: [],
      eventWork: opened, releaseEvents, saveWork: Promise.resolve(), completedNativeTurns: new Set(), saveWarning: false, failed: false,
      lastPersistence: input.persistence,
    };
    sessions.set(slot.id, slot);
    slot.opening = (async () => {
      const options = optionsSchema.parse(input.config.providerOptions ?? {});
      const persistence = input.persistence ? await snapshotStore.load(input.persistence) : undefined;
      if (persistence && persistence.cwd !== input.config.cwd) throw new Error("Resume must use the original Droid working directory");
      // A close cancels only this wait, not another session's shared query.
      let abortCatalog: (() => void) | undefined;
      try {
        slot.catalog = await Promise.race([
          catalog(input.config.cwd, input.config.env),
          new Promise<never>((_resolve, reject) => {
            abortCatalog = () => reject(new Error("Droid session closed while refreshing models."));
            slot.lifetime.signal.addEventListener("abort", abortCatalog, { once: true });
            if (slot.lifetime.signal.aborted) abortCatalog();
          }),
        ]);
      } finally {
        if (abortCatalog) slot.lifetime.signal.removeEventListener("abort", abortCatalog);
      }
      if (closed || slot.closing) throw new Error("Session closed while opening");
      if (input.config.model && !slot.catalog.models.some((model) => model.id === input.config.model || model.aliases?.includes(input.config.model!)))
        throw new Error(`Droid model "${input.config.model}" is unavailable in the refreshed catalog. Choose an available model and retry.`);
      slot.transport = await deps.transport(launch, { cwd: input.config.cwd, env: { ...input.config.env } });
      if (closed || slot.closing) { await slot.transport.close(); throw new Error("Session closed while opening"); }
      slot.transport = watchTransport(slot, slot.transport);
      slot.transport = createPermissionCompatibilityTransport(slot.transport, slot.permissions.scriptPermissionHandler).transport;
      slot.steering = (deps.steering ?? createSteeringTransport)(slot.transport);
      slot.transport = slot.steering.transport;
      if (capabilities.includes("prompt.command")) {
        slot.commands = (deps.commands ?? createCommandTransport)(slot.transport);
        slot.transport = slot.commands.transport;
      }
      const runtime = {
        transport: slot.transport,
        abortSignal: slot.lifetime.signal,
        permissionHandler: slot.permissions.permissionHandler,
        askUserHandler: slot.permissions.askUserHandler,
        mcpServers: mcpServers(input.config.mcpServers),
        ...options,
      };
      try {
        slot.native = await withDroidDeadline(slot.transport, () => persistence
          ? deps.resumeSession(persistence.nativeSessionId, runtime)
          : deps.createSession({ ...runtime, cwd: input.config.cwd, modelId: input.config.model,
            ...modeSettings(input.config.mode), reasoningEffort: reasoning(input.config.thinkingOption),
            systemPrompt: input.config.systemPrompt ? { type: "preset", preset: "droid", append: input.config.systemPrompt } : undefined,
          }));
        if (closed || slot.closing) throw new Error("Session closed while opening");
        subscribeNative(slot as Slot & { native: DroidSession });
        if (persistence) {
          await withDroidDeadline(slot.transport, () => slot.native!.updateSettings({ modelId: input.config.model, reasoningEffort: reasoning(input.config.thinkingOption), ...modeSettings(input.config.mode) }));
          for (const value of persistence.items) slot.items.set(value.id, value);
        }
        if (closed || slot.closing) throw new Error("Session closed while opening");
        // A first empty handle still preserves the native identity if disk is full.
        slot.lastPersistence ??= { version: 1, data: { nativeSessionId: slot.native.id, cwd: slot.native.cwd ?? slot.config.cwd, items: [] } };
        const initialPersistence = await save(slot, false);
        emit({ type: "session.opened", requestId: input.requestId, sessionId: slot.id, capabilities, restoration: "core", cwd: slot.config.cwd,
          ...(slot.config.persist ? { persistence: initialPersistence } : {}) });
        if (input.history === "replay") for (const value of slot.items.values()) emit({ type: "timeline.item", sessionId: slot.id, item: value });
        emit({ type: "session.config", sessionId: slot.id, config: configState(slot.native, slot.catalog) });
        void refreshContext(slot);
        await refreshCommands(slot);
        if (closed || slot.closing) throw new Error("Session closed while discovering commands");
        emit({ type: "session.ready", requestId: input.requestId, sessionId: slot.id });
        if (commandsRequested && !capabilities.includes("prompt.command")) emit({
          type: "session.notice", sessionId: slot.id, notice: { id: "droid-commands-version", severity: "info",
            title: "Native commands require Droid 0.249.0 or later",
            description: "Update Droid, then reload the Droid Native plugin to enable slash commands. Existing message and steering features remain available." },
        });
        if (slot.saveWarning) persistenceWarning(slot);
        scheduleUsageReplays(slot);
      } catch (error) {
        slot.closing = true;
        slot.unsubscribe?.();
        slot.unsubscribe = undefined;
        await slot.transport.close();
        throw error;
      }
    })();
    try { await slot.opening; }
    catch (error) { if (sessions.get(slot.id) === slot) sessions.delete(slot.id); slot.permissions.close(); throw error; }
    finally { slot.releaseEvents(); }
  }
  function get(id: string): Slot & { native: DroidSession } {
    const slot = sessions.get(id);
    if (!slot?.native || slot.closing || slot.failed) throw new Error("Droid session is not ready; reopen it to continue");
    return slot as Slot & { native: DroidSession };
  }
  function assertImageSupport(slot: Slot & { native: DroidSession }, prepared: PreparedPrompt) {
    const selected = slot.catalog.models.find((model) => model.id === slot.native.settings.modelId);
    if (prepared.options.images?.length && selected?.metadata?.noImageSupport === true)
      throw new Error("The selected Droid model does not accept images; choose a model with image support.");
  }
  function assertSteeringToolAdmission(slot: Slot, request: ProviderPrompt) {
    if (request.clearPendingPermissions && slot.permissions.hasPendingTools())
      throw new Error("Resolve the pending Droid tool approval before steering. To abandon that action, stop the turn and send a new message.");
  }
  async function steer(slot: Slot & { native: DroidSession }, request: ProviderPrompt, expectedTurnId: string) {
    if (!slot.busy || slot.activeTurnId !== expectedTurnId || slot.turn?.finishing || slot.interrupting || slot.closing)
      throw new Error("The active Droid turn has ended; send the message again to start a new turn.");
    assertSteeringToolAdmission(slot, request);
    const signal = slot.turnInput!.signal;
    const prepared = await (deps.preparePrompt ?? preparePrompt)(request, { cwd: slot.config.cwd, signal });
    assertImageSupport(slot, prepared);
    signal.throwIfAborted();
    if (!slot.busy || slot.activeTurnId !== expectedTurnId || slot.turn?.finishing || slot.interrupting || slot.closing)
      throw new Error("The active Droid turn ended while preparing this message; send it again.");
    assertSteeringToolAdmission(slot, request);
    // Only an acknowledged update is a sent user message. A missing ACK is
    // different from an explicit native rejection and is labeled separately.
    try { await slot.steering!.steer(prepared.text, { ...prepared.options, messageId: request.clientMessageId, signal }); }
    catch (error) {
      if (!(error instanceof SteeringRejectedError)) {
        item(slot, { type: "notification", id: `paseo:steer-unconfirmed:${request.clientMessageId}`, level: "warning",
          message: `Droid did not acknowledge this steering update. Delivery is unconfirmed; it may already be in native history.\n\n${prepared.timelineText}` });
        await save(slot);
      }
      if (!(error instanceof SteeringRejectedError) && slot.activeTurnId !== expectedTurnId && !slot.interrupting && !slot.closing)
        throw new Error("The Droid turn ended before steering was acknowledged. The message may already be in Droid history; send a new prompt to continue.");
      throw error;
    }
    item(slot, { type: "user_message", id: `paseo:user:${request.clientMessageId}`, clientMessageId: request.clientMessageId, text: prepared.timelineText });
    if (!slot.busy || slot.activeTurnId !== expectedTurnId || slot.turn?.finishing || slot.interrupting || slot.closing) {
      await save(slot);
      throw new Error("The Droid turn ended while sending steering. The message is retained in Droid history; send a new prompt to continue.");
    }
    // A native AskUser cancellation terminates Droid's loop. Answer it with the
    // acknowledged instruction instead; tool approvals still need an explicit choice.
    if (request.clearPendingPermissions) {
      slot.permissions.supersedeQuestions(prepared.text);
      if (slot.permissions.hasPendingTools()) emit({
        type: "session.notice", sessionId: slot.id, notice: {
          id: `droid-steer-tool-approval:${request.clientMessageId}`,
          severity: "warning",
          title: "Resolve the pending Droid tool approval",
          description: "Your steering update was queued, but a tool approval appeared while it was sending. Resolve that approval to continue; denying it may stop the current Droid turn.",
        },
      });
    }
    emit({ type: "session.prompt_result", sessionId: slot.id, clientMessageId: request.clientMessageId, result: { type: "steer", turnId: expectedTurnId } });
    await save(slot);
  }
  async function prompt(slot: Slot & { native: DroidSession }, request: ProviderPrompt) {
    // Drain already received native wakeups before deciding whether a new prompt
    // is admissible. This also closes the foreground/background handoff gap.
    await slot.eventWork;
    if (slot.closing || slot.failed || closed || sessions.get(slot.id) !== slot) throw new Error("Droid session is not ready; reopen it to continue");
    const command = selectedCommand(request, slot.commandList);
    if (command && request.delivery === "steer") throw new Error("Droid slash commands require an idle session. Finish or stop the active turn before running this command.");
    if (request.delivery === "steer") {
      if (!slot.busy || !slot.activeTurnId || slot.interrupting) throw new Error("There is no active Droid turn to steer.");
      const expectedTurnId = slot.activeTurnId;
      const work = slot.steerWork.then(() => steer(slot, request, expectedTurnId));
      slot.steerWork = work.catch(() => {});
      return work;
    }
    if (slot.busy || slot.interrupting) throw new Error("Droid is already working; use Steer or stop the active turn before sending another message");
    if (command) {
      if (slot.permissions.hasPending()) throw new Error("Resolve the pending Droid permission or question before running a command.");
      if (!slot.commands || !slot.commandList.some((entry) => entry.name.toLowerCase() === command.name.toLowerCase()))
        throw new Error(`Unknown or unavailable Droid command: /${command.name}`);
      if (builtinCommands.some((entry) => entry.name === command.name.toLowerCase())) {
        const work = runBuiltin(slot, request, command);
        slot.commandWork = work;
        try { await work; } finally { if (slot.commandWork === work) slot.commandWork = undefined; }
        return;
      }
    }
    slot.busy = true;
    const turnInput = new AbortController();
    slot.turnInput = turnInput;
    let prepared: PreparedPrompt;
    try {
      prepared = command
        ? { text: `/${command.name}${command.arguments ? ` ${command.arguments}` : ""}`,
          timelineText: `/${command.name}${command.arguments ? ` ${command.arguments}` : ""}`, options: {} }
        : await (deps.preparePrompt ?? preparePrompt)(request, { cwd: slot.config.cwd, signal: turnInput.signal });
      turnInput.signal.throwIfAborted();
      if (slot.closing || slot.failed || closed) throw new Error("Droid session closed while preparing the message");
      assertImageSupport(slot, prepared);
    } catch (error) {
      slot.busy = !!slot.turn;
      turnInput.abort();
      throw error;
    }
    turnInput.signal.throwIfAborted();
    if (slot.turn) throw new Error("Droid started background work; steer it or retry after completion.");
    const turn = beginTurn(slot, "foreground", turnInput);
    const turnId = turn.id;
    item(slot, { type: "user_message", id: `paseo:user:${request.clientMessageId}`, clientMessageId: request.clientMessageId, text: prepared.timelineText });
    emit({ type: "session.prompt_result", sessionId: slot.id, clientMessageId: request.clientMessageId, result: { type: "turn", turnId } });
    emit({ type: "session.turn", sessionId: slot.id, turnId, state: "started" });
    let terminal = false;
    slot.task = (async () => {
      try {
        for await (const event of slot.native.stream(prepared.text, { includePartialMessages: true, ...prepared.options })) {
          if (slot.closing || closed) break;
          // Lifetime notifications own the timeline. Folding stream copies too
          // would duplicate deltas and lose events after this iterator ends.
          if (event.type !== "result") continue;
          terminal = true;
          const state = event.success ? "completed" : event.subtype === "interrupted" ? "canceled" : "failed";
          turn.outcome = { state, ...(state === "failed" ? { error: { message: event.error?.message ?? "Droid turn failed" } } : {}) };
          break;
        }
        if (!terminal) throw new Error(slot.closing ? "Droid session closed" : "Droid stream ended without a result");
      } catch (error) {
        if (!terminal) {
          turn.outcome = { state: slot.closing || slot.interrupting ? "canceled" : "failed", error: { message: message(error) } };
        }
      } finally {
        turn.releaseStream!();
        // Handles stream/transport errors without an agent_turn_completed event.
        void enqueue(slot, () => finishTurn(slot, turn, turn.outcome ?? { state: "failed", error: { message: "Droid stream ended without a result" } }));
        await turn.finished;
      }
    })();
    await slot.task;
  }
  async function runBuiltin(slot: Slot & { native: DroidSession }, request: ProviderPrompt, command: { name: string; arguments: string }) {
    const name = command.name.toLowerCase();
    if (name !== "compact" && command.arguments.trim()) throw new Error(`/${name} does not accept arguments.`);
    slot.busy = true;
    slot.commandKind = name;
    const controller = new AbortController();
    slot.turnInput = controller;
    item(slot, { type: "user_message", id: `paseo:user:${request.clientMessageId}`, clientMessageId: request.clientMessageId,
      text: `/${command.name}${command.arguments ? ` ${command.arguments}` : ""}` });
    try {
      let text: string;
      if (name === "compact") {
        await slot.commandDiscovery;
        await slot.saveWork;
        await slot.eventWork;
        controller.signal.throwIfAborted();
        let successor: Awaited<ReturnType<DroidSession["compact"]>>;
        let compactionStarted = false;
        try {
          successor = await commandWait(async () => {
            compactionStarted = true;
            const outcome = await slot.native.compact(command.arguments ? { customInstructions: command.arguments } : undefined);
            if (controller.signal.aborted || slot.closing || slot.failed || closed) {
              await outcome.session.close().catch(() => {});
              throw new Error("Droid session closed during compaction.");
            }
            return outcome;
          }, controller.signal, deps.compactionTimeoutMs ?? COMPACTION_TIMEOUT);
        } catch (error) {
          if (compactionStarted && (error instanceof CommandTimeoutError || error instanceof DroidTimeoutError || controller.signal.aborted ||
              (error instanceof SessionReplacementError && error.rollbackFailed)))
            await failRuntime(slot, new Error("Droid compaction could not be confirmed; reopen the session before continuing."));
          throw error;
        }
        slot.native = successor.session;
        subscribeNative(slot);
        slot.contextRevision++;
        slot.itemRevision++; // Identity changes are a persistence checkpoint too.
        slot.nextNativeTurnId = undefined;
        slot.completedNativeTurns.clear();
        emit({ type: "session.config", sessionId: slot.id, config: configState(slot.native, slot.catalog) });
        await refreshContext(slot);
        await refreshCommands(slot);
        text = `Conversation compacted. Removed ${successor.removedCount} earlier messages.`;
      } else if (name === "context") {
        const value = await slot.commands!.context({ signal: controller.signal, timeoutMs: deps.commandTimeoutMs ?? 5000 });
        text = formatContext(value);
        await refreshContext(slot);
      } else {
        text = await commandWait(() => (deps.limits ?? readSessionLimits)({ ...launch.env, ...slot.config.env }),
          controller.signal, deps.commandTimeoutMs ?? 15_000);
      }
      controller.signal.throwIfAborted();
      if (slot.closing || slot.failed || closed) throw new Error("Droid session closed while running the command.");
      item(slot, { type: "assistant_message", id: `paseo:command:${request.clientMessageId}`, text });
      await save(slot, true, name === "compact");
      controller.signal.throwIfAborted();
      if (slot.closing || slot.failed || closed) throw new Error("Droid session closed while saving the command result.");
      emit({ type: "session.prompt_result", sessionId: slot.id, clientMessageId: request.clientMessageId, result: { type: "completed" } });
    } finally {
      slot.commandKind = undefined;
      slot.busy = !!slot.turn;
      if (slot.turnInput === controller) slot.turnInput = undefined;
    }
  }
  async function closeSlot(slot: Slot) {
    slot.closing = true;
    slot.unsubscribe?.();
    slot.unsubscribe = undefined;
    cancelTextFlush(slot);
    cancelUsageReplays(slot);
    slot.permissions.close();
    slot.turnInput?.abort(new Error("Droid session closed"));
    slot.steering?.cancelPending(new Error("Droid session closed"));
    slot.lifetime.abort(new Error("Droid session closed"));
    // Closing transport also rejects an in-flight init/stream and bounds shutdown.
    await slot.transport?.close();
    await slot.opening?.catch(() => {});
    await slot.native?.close().catch(() => {});
    await slot.task;
    await slot.commandWork?.catch(() => {});
    await enqueue(slot, async () => { if (slot.turn) await finishTurn(slot, slot.turn, { state: "canceled" }); });
    await slot.saveWork;
    if (sessions.get(slot.id) === slot) sessions.delete(slot.id);
  }
  async function dispatch(input: ProviderInput) {
    requireProviderCapabilities(capabilities, input);
    switch (input.type) {
      case "catalog": emit({ type: "catalog", requestId: input.requestId, catalog: await catalog(input.cwd) }); return;
      case "session.open": return open(input);
      case "session.prompt": return prompt(get(input.sessionId), input.prompt);
      case "session.permission": get(input.sessionId).permissions.respond(input.permissionId, input.response); return;
      case "session.interrupt": {
        const slot = get(input.sessionId);
        if (slot.commandWork) {
          const commandWork = slot.commandWork;
          slot.interrupting = true;
          slot.turnInput?.abort(new Error("Droid command interrupted"));
          try {
            if (slot.commandKind === "compact") await failRuntime(slot, new Error("Droid compaction interrupted; reopen the session before continuing."));
            await commandWork.catch(() => {});
          } finally { slot.interrupting = false; }
          break;
        }
        slot.interrupting = true;
        slot.turnInput?.abort(new Error("Droid turn interrupted"));
        slot.steering?.cancelPending(new Error("Droid turn interrupted"));
        slot.permissions.cancelAll();
        try { await withDroidDeadline(slot.transport!, async () => {
          await slot.native.interrupt();
          await slot.task;
          await enqueue(slot, async () => { if (slot.turn) await finishTurn(slot, slot.turn, { state: "canceled" }); });
        }, 10000); }
        finally { slot.interrupting = false; }
        break;
      }
      case "session.configure": {
        const slot = get(input.sessionId);
        if (slot.busy) throw new Error("Stop the active Droid turn before changing settings");
        slot.busy = true;
        try { await updateSessionSettings(slot.native, slot.transport!, input.changes, deps.settingsTimeoutMs); }
        catch (error) {
          if (error instanceof DroidSettingsTimeoutError) {
            await closeSlot(slot);
            emit({ type: "session.runtime_failed", sessionId: slot.id, error: { message: error.message } });
          }
          throw error;
        }
        finally { slot.busy = !!slot.turn; }
        emit({ type: "session.config", sessionId: slot.id, config: configState(slot.native, slot.catalog) });
        void refreshContext(slot);
        await save(slot);
        break;
      }
      case "session.close": {
        const slot = sessions.get(input.sessionId);
        if (slot) await closeSlot(slot);
        emit({ type: "session.closed", sessionId: input.sessionId });
        break;
      }
      default: throw new Error(`Unsupported Droid operation: ${input.type}`);
    }
    if ("requestId" in input) emit({ type: "request.completed", requestId: input.requestId });
  }
  return {
    version: 1, capabilities,
    async send(input) {
      if (closed) throw new Error("Droid connection is closed");
      // Paseo treats a failed steering disposition as permission to replace the
      // active turn. Reject acceptance instead so a refused update surfaces its
      // error while preserving the turn and pending cards. Individual plugin
      // inputs are concurrent, so interrupts/permissions can still arrive while
      // this bounded steering admission waits for its native acknowledgment.
      if (input.type === "session.prompt" && input.prompt.delivery === "steer") {
        await dispatch(input);
        return;
      }
      // Ordinary prompts must stay detached while a model or permission is pending.
      void dispatch(input).catch((error) => {
        if (input.type === "session.prompt") emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "failed", error: { message: message(error) } } });
        else if ("requestId" in input) emit({ type: "request.failed", requestId: input.requestId, error: { message: message(error) } });
        else if ("sessionId" in input) emit({ type: "session.notice", sessionId: input.sessionId, notice: { id: randomUUID(), severity: "error", title: "Droid request failed", description: message(error) } });
      });
    },
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([
        ...[...sessions.values()].map(closeSlot),
        ...[...catalogTransports].map((transport) => transport.close()),
      ]);
      listeners.clear();
    },
  };
}

function message(error: unknown): string { return error instanceof Error ? error.message : "Droid operation failed"; }

async function droidVersion(launch: ProviderLaunch): Promise<string> {
  return (await execCommand(launch.command, [...launch.args, "--version"], { env: launch.env, timeout: 5000, maxBuffer: 8192 })).stdout;
}

class CommandTimeoutError extends Error {
  constructor() { super("Droid command timed out."); }
}
/** Read timeouts leave the session usable; uncertain compaction is handled by its caller. */
async function commandWait<T>(operation: () => Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new CommandTimeoutError()), Math.max(1, timeoutMs));
        abort = () => reject(new Error("Droid command canceled."));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

/** A missing/slow stats endpoint is optional telemetry, never a transport failure. */
async function contextStats(native: DroidSession, signal: AbortSignal, timeoutMs: number): Promise<GetContextStatsResult | undefined> {
  if (signal.aborted) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => signal.aborted ? undefined : native.getContextStats()),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.max(1, timeoutMs));
        aborted = () => resolve(undefined);
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      }),
    ]);
  } catch { return undefined; }
  finally {
    if (timer) clearTimeout(timer);
    if (aborted) signal.removeEventListener("abort", aborted);
  }
}
function mcpServers(servers: Readonly<Record<string, ProviderMcpServerConfig>>): DroidMcpServerConfig[] {
  return Object.entries(servers).map(([name, config]) => config.type === "stdio"
    ? { name, command: config.command, args: config.args ?? [], env: config.env ?? {} }
    : { name, type: config.type, url: config.url, headers: Object.entries(config.headers ?? {}).map(([name, value]) => ({ name, value })) });
}

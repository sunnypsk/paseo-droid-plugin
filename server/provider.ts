import { createHash, randomUUID } from "node:crypto";
import {
  createSession,
  resumeSession,
  listModels,
  type DroidSession,
  type DroidMcpServerConfig,
  type GetContextStatsResult,
} from "@factory/droid-sdk/node";
import { execCommand } from "@getpaseo/plugin/server";
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  ProviderEventSchema,
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
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { createDroidTransport, withDroidDeadline } from "./transport";
import { DroidTimeline } from "./timeline";
import { Permissions } from "./permissions";
import { modeSettings, presentCatalog, configState, reasoning } from "./catalog";
import { preparePrompt, type PreparedPrompt } from "./attachments";
import { createSteeringTransport } from "./steering";
import { createPermissionCompatibilityTransport } from "./permission-compatibility";

export const supported = ["prompt.message", "prompt.image", "prompt.steer", "session.configure", "session.persistence", "permission", "permission.tool_policy"] as const;
const optionsSchema = z.object({
  disableBuiltinSkills: z.boolean().optional(),
  disabledToolIds: z.array(z.string()).optional(),
}).strict();
const timelineItemSchema = z.custom<ProviderTimelineItem>((value) => ProviderEventSchema.safeParse({ type: "timeline.item", sessionId: "restore", item: value }).success);
const persistenceSchema = z.object({ nativeSessionId: z.string().uuid(), cwd: z.string(), items: z.array(timelineItemSchema) });
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
  /** Internal test override; bounded startup snapshots require no extra RPC. */
  usageReplayDelaysMs?: readonly number[];
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
      return connection(request.launch, negotiateProviderCapabilities(request.capabilities, supported), deps);
    },
  };
}

interface Slot {
  id: string;
  config: ProviderSessionConfig;
  native?: DroidSession;
  transport?: Transport;
  steering?: ReturnType<typeof createSteeringTransport>;
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
  catalog: ProviderCatalog;
  usage: ProviderUsage;
  contextRevision: number;
  contextModelId?: string;
  usageReplayTimers: Set<ReturnType<typeof setTimeout>>;
}

function connection(launch: ProviderLaunch, capabilities: readonly string[], deps: DroidDependencies): ProviderConnection {
  const sessions = new Map<string, Slot>();
  const listeners = new Set<(event: ProviderEvent) => void>();
  // Coalesce overlapping discoveries only. Completed catalogs must not make a
  // later session inherit an old model list or multiplier indefinitely.
  const catalogs = new Map<string, Promise<ProviderCatalog>>();
  const catalogTransports = new Set<Transport>();
  let closed = false;
  function emit(event: ProviderEvent) {
    if (!closed) for (const listener of listeners) listener(event);
  }
  function item(slot: Slot, value: ProviderTimelineItem) {
    slot.items.set(value.id, value);
    emit({ type: "timeline.item", sessionId: slot.id, item: value });
  }
  function save(slot: Slot) {
    if (!slot.native || !slot.config.persist) return;
    emit({ type: "session.persistence", sessionId: slot.id, persistence: saved(slot) });
  }
  function saved(slot: Slot): ProviderPersistence {
    return { version: 1, data: z.json().parse(JSON.parse(JSON.stringify({ nativeSessionId: slot.native!.id, cwd: slot.native!.cwd ?? slot.config.cwd, items: [...slot.items.values()] }))) };
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
  async function open(input: OpenInput) {
    if (sessions.has(input.sessionId)) throw new Error("Session already open");
    const slot: Slot = {
      id: input.sessionId, config: input.config, busy: false, interrupting: false, steerWork: Promise.resolve(), closing: false, lifetime: new AbortController(),
      permissions: new Permissions(input.sessionId, emit, input.config.toolPolicy),
      timeline: new DroidTimeline(), items: new Map(), catalog: { models: [], modes: [] }, usage: {}, contextRevision: 0, usageReplayTimers: new Set(),
    };
    sessions.set(slot.id, slot);
    slot.opening = (async () => {
      const options = optionsSchema.parse(input.config.providerOptions ?? {});
      const persistence = input.persistence ? persistenceSchema.parse(input.persistence.data) : undefined;
      if (input.persistence && input.persistence.version !== 1) throw new Error("Unsupported Droid persistence version");
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
      slot.transport = createPermissionCompatibilityTransport(slot.transport, slot.permissions.scriptPermissionHandler).transport;
      slot.steering = (deps.steering ?? createSteeringTransport)(slot.transport);
      slot.transport = slot.steering.transport;
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
        if (persistence) {
          await withDroidDeadline(slot.transport, () => slot.native!.updateSettings({ modelId: input.config.model, reasoningEffort: reasoning(input.config.thinkingOption), ...modeSettings(input.config.mode) }));
          for (const value of persistence.items) slot.items.set(value.id, value);
        }
        if (closed || slot.closing) throw new Error("Session closed while opening");
        emit({ type: "session.opened", requestId: input.requestId, sessionId: slot.id, capabilities, restoration: "core", cwd: slot.native.cwd ?? slot.config.cwd,
          ...(slot.config.persist ? { persistence: saved(slot) } : {}) });
        if (input.history === "replay") for (const value of slot.items.values()) emit({ type: "timeline.item", sessionId: slot.id, item: value });
        emit({ type: "session.config", sessionId: slot.id, config: configState(slot.native, slot.catalog) });
        void refreshContext(slot);
        emit({ type: "session.ready", requestId: input.requestId, sessionId: slot.id });
        scheduleUsageReplays(slot);
      } catch (error) {
        await slot.transport.close();
        throw error;
      }
    })();
    try { await slot.opening; }
    catch (error) { if (sessions.get(slot.id) === slot) sessions.delete(slot.id); slot.permissions.close(); throw error; }
  }
  function get(id: string): Slot & { native: DroidSession } {
    const slot = sessions.get(id);
    if (!slot?.native || slot.closing) throw new Error("Droid session is not ready");
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
    if (!slot.busy || slot.activeTurnId !== expectedTurnId || slot.interrupting || slot.closing)
      throw new Error("The active Droid turn has ended; send the message again to start a new turn.");
    assertSteeringToolAdmission(slot, request);
    const signal = slot.turnInput!.signal;
    const prepared = await (deps.preparePrompt ?? preparePrompt)(request, { cwd: slot.config.cwd, signal });
    assertImageSupport(slot, prepared);
    signal.throwIfAborted();
    if (!slot.busy || slot.activeTurnId !== expectedTurnId || slot.interrupting || slot.closing)
      throw new Error("The active Droid turn ended while preparing this message; send it again.");
    assertSteeringToolAdmission(slot, request);
    // Retain an attempted update even if its ACK races a terminal event. Native
    // skipAgentLoop prevents an extra model turn but can still append history.
    item(slot, { type: "user_message", id: `paseo:user:${request.clientMessageId}`, clientMessageId: request.clientMessageId, text: prepared.timelineText });
    try { await slot.steering!.steer(prepared.text, { ...prepared.options, messageId: request.clientMessageId, signal }); }
    catch (error) {
      save(slot);
      if (slot.activeTurnId !== expectedTurnId && !slot.interrupting && !slot.closing)
        throw new Error("The Droid turn ended before steering was acknowledged. The message may already be in Droid history; send a new prompt to continue.");
      throw error;
    }
    if (!slot.busy || slot.activeTurnId !== expectedTurnId || slot.interrupting || slot.closing)
      throw new Error("The Droid turn ended while sending steering. The message is retained in Droid history; send a new prompt to continue.");
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
    save(slot);
  }
  async function prompt(slot: Slot & { native: DroidSession }, request: ProviderPrompt) {
    if (request.delivery === "steer") {
      if (!slot.busy || !slot.activeTurnId || slot.interrupting) throw new Error("There is no active Droid turn to steer.");
      const expectedTurnId = slot.activeTurnId;
      const work = slot.steerWork.then(() => steer(slot, request, expectedTurnId));
      slot.steerWork = work.catch(() => {});
      return work;
    }
    if (slot.busy || slot.interrupting) throw new Error("Droid is already working; use Steer or stop the active turn before sending another message");
    slot.busy = true;
    const turnInput = new AbortController();
    slot.turnInput = turnInput;
    let prepared: PreparedPrompt;
    try {
      prepared = await (deps.preparePrompt ?? preparePrompt)(request, { cwd: slot.config.cwd, signal: turnInput.signal });
      turnInput.signal.throwIfAborted();
      if (slot.closing || closed) throw new Error("Droid session closed while preparing the message");
      assertImageSupport(slot, prepared);
    } catch (error) {
      slot.busy = false;
      turnInput.abort();
      throw error;
    }
    const turnId = randomUUID();
    slot.activeTurnId = turnId;
    item(slot, { type: "user_message", id: `paseo:user:${request.clientMessageId}`, clientMessageId: request.clientMessageId, text: prepared.timelineText });
    emit({ type: "session.prompt_result", sessionId: slot.id, clientMessageId: request.clientMessageId, result: { type: "turn", turnId } });
    emit({ type: "session.turn", sessionId: slot.id, turnId, state: "started" });
    let terminal = false;
    slot.task = (async () => {
      try {
        for await (const event of slot.native.stream(prepared.text, { includePartialMessages: true, ...prepared.options })) {
          if (slot.closing || closed) break;
          for (const value of slot.timeline.handle(event)) item(slot, value);
          if (event.type === "settings_updated") {
            emit({ type: "session.config", sessionId: slot.id, config: configState(slot.native, slot.catalog) });
            void refreshContext(slot);
          }
          if (event.type !== "result") continue;
          terminal = true;
          const state = event.success ? "completed" : event.subtype === "interrupted" ? "canceled" : "failed";
          for (const value of slot.timeline.finishTools(state === "completed" ? "completed" : state === "canceled" ? "canceled" : "failed")) item(slot, value);
          if (event.tokenUsage) publishUsage(slot, {
            inputTokens: event.tokenUsage.inputTokens, outputTokens: event.tokenUsage.outputTokens,
            cachedInputTokens: event.tokenUsage.cacheReadTokens,
          }, turnId);
          emit({ type: "session.turn", sessionId: slot.id, turnId, state,
            ...(state === "failed" ? { error: { message: event.error?.message ?? "Droid turn failed" } } : {}) });
          break;
        }
        if (!terminal) throw new Error(slot.closing ? "Droid session closed" : "Droid stream ended without a result");
      } catch (error) {
        if (!terminal) {
          for (const value of slot.timeline.finishTools(slot.closing || slot.interrupting ? "canceled" : "failed")) item(slot, value);
          emit({ type: "session.turn", sessionId: slot.id, turnId, state: slot.closing || slot.interrupting ? "canceled" : "failed", error: { message: message(error) } });
        }
      } finally {
        slot.permissions.cancelAll();
        turnInput.abort(new Error("Droid turn ended"));
        slot.activeTurnId = undefined;
        slot.busy = false;
        save(slot);
        void refreshContext(slot);
      }
    })();
    await slot.task;
  }
  async function closeSlot(slot: Slot) {
    slot.closing = true;
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
        slot.interrupting = true;
        slot.turnInput?.abort(new Error("Droid turn interrupted"));
        slot.steering?.cancelPending(new Error("Droid turn interrupted"));
        slot.permissions.cancelAll();
        try { await withDroidDeadline(slot.transport!, async () => { await slot.native.interrupt(); await slot.task; }, 10000); }
        finally { slot.interrupting = false; }
        break;
      }
      case "session.configure": {
        const slot = get(input.sessionId);
        if (slot.busy) throw new Error("Stop the active Droid turn before changing settings");
        if (input.changes.settings && Object.keys(input.changes.settings).length) throw new Error("Unknown Droid setting");
        await withDroidDeadline(slot.transport!, () => slot.native.updateSettings({
          modelId: input.changes.model ?? undefined,
          reasoningEffort: reasoning(input.changes.thinkingOption ?? undefined),
          ...(input.changes.mode ? modeSettings(input.changes.mode) : {}),
        }));
        emit({ type: "session.config", sessionId: slot.id, config: configState(slot.native, slot.catalog) });
        void refreshContext(slot);
        save(slot);
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

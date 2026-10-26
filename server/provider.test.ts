import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AutonomyLevel,
  ContextStatsAccuracy,
  AskUserRequestParamsSchema,
  DroidInteractionMode,
  RequestPermissionRequestParamsSchema,
  ToolConfirmationOutcome,
  TimeoutError as DroidTimeoutError,
  ToolConfirmationType,
  SessionNotificationPayloadSchema,
  type AskUserResult,
  type ClientAskUserHandler,
  type ClientPermissionHandler,
  type DroidSession,
  type MessageOptions,
  type GetContextStatsResult,
  type ModelInfo,
  type ListSkillsResult,
  type CompactSessionRequestParams,
  type StringFramedDroidClientTransport,
} from "@factory/droid-sdk/node";
import type { DroidMessage } from "@factory/droid-sdk";
import {
  ProviderEventSchema,
  type ProviderEvent,
  type ProviderPersistence,
  type ProviderContent,
  type ProviderPrompt,
  type ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import { createDroidProvider, supported, type DroidDependencies } from "./provider";
import { preparePrompt, type PreparedPrompt } from "./attachments";
import { SteeringRejectedError, type SteeringOptions } from "./steering";
import { FileSnapshotStore, type SnapshotStore } from "./snapshot-store";
import { type NativeCommand, type ContextBreakdown } from "./commands";

const cwd = "/tmp/droid-provider-tests";
const nativeId = "68c0cb90-4209-49e2-a7e7-f1d4fc1e49fb";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

class FakeTransport implements StringFramedDroidClientTransport {
  isConnected = true;
  closeCalls = 0;
  readonly onClose = new Set<() => void>();
  async send() {}
  onMessage() {}
  errorHandler?: (error: Error) => void;
  onError(handler: (error: Error) => void) { this.errorHandler = handler; }
  async close() {
    this.closeCalls++;
    if (!this.isConnected) return;
    this.isConnected = false;
    this.errorHandler?.(new Error("Fake Droid transport closed"));
    for (const callback of this.onClose) callback();
  }
}

type Script = (native: FakeNative, text: string) => AsyncGenerator<DroidMessage>;
type NativeOptions = { transport: StringFramedDroidClientTransport; permissionHandler: ClientPermissionHandler; askUserHandler: ClientAskUserHandler };

class FakeNative {
  id: string = nativeId;
  readonly cwd = cwd;
  readonly settings: Record<string, unknown> = {
    modelId: "test-model",
    autonomyLevel: AutonomyLevel.Off,
    interactionMode: DroidInteractionMode.Auto,
  };
  streamCalls = 0;
  interruptCalls = 0;
  closeCalls = 0;
  contextCalls = 0;
  interrupted = false;
  readonly streamInputs: Array<{ text: string; options?: MessageOptions }> = [];
  readonly onInterrupt = new Set<() => void>();
  readonly onShutdown = new Set<() => void>();
  readonly notifications = new Set<(notification: Record<string, unknown>) => void>();
  readonly nativeTurnIds: string[] = [];
  skillHandler?: () => Promise<ListSkillsResult>;
  compactHandler?: (native: FakeNative, params?: CompactSessionRequestParams) => Promise<{ session: FakeNative; removedCount: number }>;
  async listSkills(): Promise<ListSkillsResult> { return this.skillHandler ? this.skillHandler() : { skills: [] }; }
  async compact(params?: CompactSessionRequestParams) {
    if (this.compactHandler) return this.compactHandler(this, params);
    const session = new FakeNative(this.options, this.script, this.context, this.afterSubscribe);
    session.id = randomUUID();
    return { session, removedCount: 2 };
  }
  onNotification(callback: (notification: Record<string, unknown>) => void) {
    this.notifications.add(callback);
    this.afterSubscribe?.(this);
    return () => { this.notifications.delete(callback); };
  }
  notify(payload: unknown) {
    const parsed = SessionNotificationPayloadSchema.safeParse(payload);
    assert.ok(parsed.success, parsed.success ? "" : parsed.error.message);
    for (const callback of this.notifications) callback({ params: { notification: parsed.data } });
  }
  notifyMessage(event: DroidMessage, turnId: string) {
    if (event.type === "result") {
      this.notify({ type: "agent_turn_completed", reason: event.success ? "completed" : "cancelled", turnId,
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0, ...event.tokenUsage } });
    } else if (event.type === "assistant_text_delta" || event.type === "thinking_text_delta") {
      this.notify({ ...event, textDelta: event.text });
    } else if (event.type === "tool_call") {
      this.notify({ type: "tool_call", toolUse: { type: "tool_use", id: event.toolUseId, name: event.name, input: event.input } });
    } else if (event.type === "tool_result") {
      this.notify({ ...event, messageId: randomUUID() });
    } else if (event.type === "assistant" || event.type === "user") {
      this.notify({ type: "create_message", message: { ...event.message, createdAt: event.message.createdAt ?? 0, updatedAt: event.message.updatedAt ?? 0 } });
    } else if (event.type === "tool_progress") {
      this.notify({ type: "tool_progress_update", toolUseId: event.toolUseId, toolName: event.toolName, update: event.update });
    } else if (event.type === "working_state_changed") {
      this.notify({ type: "droid_working_state_changed", newState: event.state });
    } else if (event.type === "token_usage_update") {
      this.notify({ type: "session_token_usage_changed", tokenUsage: { ...event, cacheCreationTokens: event.cacheCreationTokens ?? 0, thinkingTokens: event.thinkingTokens ?? 0 } });
    } else if (event.type === "error") {
      this.notify({ ...event, errorType: "Error" });
    } else this.notify(event);
  }
  constructor(readonly options: NativeOptions, private readonly script: Script, private readonly context?: (native: FakeNative) => Promise<GetContextStatsResult>, private readonly afterSubscribe?: (native: FakeNative) => void) {
    options.transport.onError(() => { for (const callback of this.onShutdown) callback(); });
  }
  async *stream(text: string, options?: MessageOptions) {
    this.streamCalls++;
    this.streamInputs.push({ text, options });
    this.interrupted = false;
    const turnId = randomUUID();
    this.nativeTurnIds.push(turnId);
    this.notify({ type: "create_message", message: { id: turnId, role: "user", content: [{ type: "text", text }], createdAt: 0, updatedAt: 0 } });
    for await (const event of this.script(this, text)) {
      this.notifyMessage(event, turnId);
      yield event;
    }
  }
  async interrupt() {
    this.interruptCalls++;
    this.interrupted = true;
    for (const callback of this.onInterrupt) callback();
  }
  async updateSettings(changes: Record<string, unknown>) {
    Object.assign(this.settings, Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)));
  }
  async getContextStats(): Promise<GetContextStatsResult> {
    this.contextCalls++;
    if (this.context) return this.context(this);
    const used = 1000 + this.streamCalls * 100;
    const limit = this.settings.modelId === "large-model" ? 500000 : 128000;
    return { used, remaining: limit - used, limit, accuracy: ContextStatsAccuracy.Estimated, updatedAt: "2026-10-17T00:00:00.000Z" };
  }
  async close() { this.closeCalls++; }
}

function result(success = true): DroidMessage {
  return { type: "result", success, subtype: success ? "success" : "interrupted" } as DroidMessage;
}

async function* successful(_native: FakeNative, text: string): AsyncGenerator<DroidMessage> {
  yield { type: "assistant_text_delta", messageId: `answer:${text}`, blockIndex: 0, text: "Hello " } as DroidMessage;
  yield { type: "assistant_text_delta", messageId: `answer:${text}`, blockIndex: 0, text: "from Droid" } as DroidMessage;
  yield result();
}

async function* needsPermission(native: FakeNative): AsyncGenerator<DroidMessage> {
  yield { type: "tool_call", toolUseId: "create-1", name: "Create", input: { file_path: `${cwd}/hello.txt`, content: "hello" } } as DroidMessage;
  const answer = await native.options.permissionHandler(RequestPermissionRequestParamsSchema.parse({
    toolUses: [{
      toolUse: { type: "tool_use", id: "create-1", name: "Create", input: { file_path: `${cwd}/hello.txt`, content: "hello" } },
      confirmationType: ToolConfirmationType.Create,
      details: { type: ToolConfirmationType.Create, filePath: `${cwd}/hello.txt`, fileName: "hello.txt", content: "hello" },
    }],
    options: [
      { label: "Create once", value: ToolConfirmationOutcome.ProceedOnce },
      { label: "Cancel", value: ToolConfirmationOutcome.Cancel },
    ],
  }));
  if (answer === ToolConfirmationOutcome.Cancel) {
    yield result(false);
    return;
  }
  yield { type: "tool_result", toolUseId: "create-1", toolName: "Create", content: "Created hello.txt", isError: false } as DroidMessage;
  yield result();
}

interface SetupOptions {
  version?: string;
  commands?: () => Promise<NativeCommand[]>;
  skills?: () => Promise<ListSkillsResult>;
  contextBreakdown?: () => Promise<ContextBreakdown>;
  limits?: DroidDependencies["limits"];
  commandTimeoutMs?: number;
  compactionTimeoutMs?: number;
  compact?: FakeNative["compactHandler"];
  create?: ReturnType<typeof deferred<void>>;
  models?: ReturnType<typeof deferred<void>>;
  steer?: (text: string, options?: SteeringOptions) => Promise<void>;
  prepare?: typeof preparePrompt;
  noImageSupport?: boolean;
  context?: (native: FakeNative) => Promise<GetContextStatsResult>;
  contextTimeoutMs?: number;
  settingsTimeoutMs?: number;
  usageReplayDelaysMs?: readonly number[];
  snapshotStore?: SnapshotStore;
  afterSubscribe?: (native: FakeNative) => void;
  catalog?: (call: number, env: Readonly<Record<string, string>>, cwd?: string) => Promise<ModelInfo[]>;
}

async function setup(script: Script = successful, gates: SetupOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "droid-provider-state-"));
  const snapshotStore = gates.snapshotStore ?? new FileSnapshotStore(directory);
  const transports: FakeTransport[] = [];
  const transportOptions = new Map<FakeTransport, { cwd?: string; env?: Readonly<Record<string, string>> }>();
  let catalogCalls = 0;
  const natives: FakeNative[] = [];
  const resumed: string[] = [];
  const createStarted = deferred<void>();
  const modelsStarted = deferred<void>();
  const steerCalls: Array<{ text: string; options?: SteeringOptions }> = [];
  const steerStarted = deferred<void>();
  const steerCancellations: Array<Error | undefined> = [];
  const sends = new Map<string, Promise<void>>();
  const deps = {
    snapshotStore,
    version: async () => gates.version ?? "0.249.0",
    commands(transport: StringFramedDroidClientTransport) {
      return { transport, list: gates.commands ?? (async () => []), context: gates.contextBreakdown ?? (async () => ({
        modelId: "test-model", modelDisplayName: "Test model", contextBudget: 128000, usedTokens: 1000, freeTokens: 127000,
        categories: [{ name: "Messages", tokens: 1000 }],
      })) };
    },
    limits: gates.limits,
    commandTimeoutMs: gates.commandTimeoutMs,
    compactionTimeoutMs: gates.compactionTimeoutMs,
    async transport(_launch: unknown, options: { cwd?: string; env?: Readonly<Record<string, string>> } = {}) {
      const transport = new FakeTransport();
      transports.push(transport);
      transportOptions.set(transport, options);
      return transport;
    },
    async listModels({ transport }: { transport: FakeTransport }) {
      const call = ++catalogCalls;
      modelsStarted.resolve();
      if (gates.models) {
        transport.onClose.add(() => gates.models!.reject(new Error("Catalog transport closed")));
        await gates.models.promise;
      }
      if (gates.catalog) {
        const options = transportOptions.get(transport)!;
        return gates.catalog(call, options.env ?? {}, options.cwd);
      }
      return [{ id: "test-model", displayName: "Test model", supportedReasoningEfforts: [], disabled: false, noImageSupport: gates.noImageSupport ?? false }];
    },
    async createSession(options: NativeOptions) {
      createStarted.resolve();
      if (gates.create) {
        options.transport.onError(() => gates.create!.reject(new Error("Initialization transport closed")));
        await gates.create.promise;
      }
      const native = new FakeNative(options, script, gates.context, gates.afterSubscribe);
      native.skillHandler = gates.skills;
      native.compactHandler = gates.compact;
      natives.push(native);
      return native as unknown as DroidSession;
    },
    async resumeSession(id: string, options: NativeOptions) {
      resumed.push(id);
      const native = new FakeNative(options, script, gates.context, gates.afterSubscribe);
      native.id = id;
      native.skillHandler = gates.skills;
      native.compactHandler = gates.compact;
      natives.push(native);
      return native as unknown as DroidSession;
    },
    steering(transport: StringFramedDroidClientTransport) {
      return {
        transport,
        async steer(text: string, options?: SteeringOptions) {
          steerCalls.push({ text, options });
          steerStarted.resolve();
          await gates.steer?.(text, options);
        },
        cancelPending(error?: Error) { steerCancellations.push(error); },
      };
    },
    ...(gates.prepare ? { preparePrompt: gates.prepare } : {}),
    ...(gates.contextTimeoutMs === undefined ? {} : { contextTimeoutMs: gates.contextTimeoutMs }),
    ...(gates.settingsTimeoutMs === undefined ? {} : { settingsTimeoutMs: gates.settingsTimeoutMs }),
    ...(gates.usageReplayDelaysMs ? { usageReplayDelaysMs: gates.usageReplayDelaysMs } : {}),
  } as unknown as DroidDependencies;
  const connection = await createDroidProvider(deps).connect({
    versions: [1], capabilities: supported,
    launch: { command: "fake-droid", args: [], env: {} },
  });
  const events: ProviderEvent[] = [];
  const invalid: string[] = [];
  const waiters = new Set<() => void>();
  connection.onEvent((event) => {
    const parsed = ProviderEventSchema.safeParse(event);
    if (!parsed.success) invalid.push(`${event.type}: ${parsed.error.message}`);
    events.push(event);
    for (const check of [...waiters]) check();
  });
  async function waitFor<T extends ProviderEvent["type"]>(
    type: T,
    predicate: (event: Extract<ProviderEvent, { type: T }>) => boolean = () => true,
    after = 0,
  ): Promise<Extract<ProviderEvent, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`Timed out waiting for ${type}; received ${events.map((event) => event.type === "session.turn" ? `${event.type}:${event.state}:${event.error?.message ?? ""}` : event.type).join(", ")}`));
      }, 1500);
      const check = () => {
        const event = events.slice(after).find((candidate) => candidate.type === type && predicate(candidate as Extract<ProviderEvent, { type: T }>));
        if (!event) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(event as Extract<ProviderEvent, { type: T }>);
      };
      waiters.add(check);
      check();
    });
  }
  const config: ProviderSessionConfig = { cwd, env: {}, mcpServers: {}, settings: {}, persist: true, model: "test-model", mode: "ask" };
  async function open(id = "session", persistence?: ProviderPersistence) {
    await connection.send({ type: "session.open", requestId: `open:${id}`, sessionId: id, config, persistence, history: "replay" });
    await waitFor("session.ready", (event) => event.sessionId === id);
  }
  async function prompt(clientMessageId = "message-1", sessionId = "session") {
    await connection.send({ type: "session.prompt", sessionId, prompt: {
      clientMessageId, delivery: "auto", input: { type: "message", content: [{ type: "text", text: clientMessageId }] },
    } });
  }
  async function sendPrompt(clientMessageId: string, content: ProviderContent[], delivery: ProviderPrompt["delivery"] = "auto", sessionId = "session", clearPendingPermissions?: boolean) {
    // Track the acceptance promise without blocking controlled ACK/preparation
    // gates in the test driver. Unlike ordinary prompts, steer acceptance waits.
    const pending = connection.send({ type: "session.prompt", sessionId, prompt: {
      clientMessageId, delivery, input: { type: "message", content },
      ...(clearPendingPermissions === undefined ? {} : { clearPendingPermissions }),
    } });
    sends.set(clientMessageId, pending);
    void pending.catch(() => {});
  }
  function sent(clientMessageId: string): Promise<void> {
    const pending = sends.get(clientMessageId);
    assert.ok(pending, `No send recorded for ${clientMessageId}`);
    return pending;
  }
  async function rejectedSteer(clientMessageId: string, expected?: RegExp) {
    if (expected) await assert.rejects(sent(clientMessageId), expected);
    else await assert.rejects(sent(clientMessageId));
    assert.equal(events.filter((event) => event.type === "session.prompt_result" && event.clientMessageId === clientMessageId).length, 0,
      "Rejected steering must not emit a failed disposition that triggers Paseo's replacement fallback");
  }
  function terminalTurns(id = "session") {
    return events.filter((event) => event.type === "session.turn" && event.sessionId === id && event.state !== "started");
  }
  async function cleanup() {
    await connection.close();
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(invalid, [], "Every emitted event must satisfy the Paseo provider protocol");
  }
  return { connection, events, waitFor, config, open, prompt, sendPrompt, sent, rejectedSteer, terminalTurns, cleanup, transports, natives, resumed, snapshotStore, createStarted, modelsStarted, steerCalls, steerStarted, steerCancellations, catalogCalls: () => catalogCalls };
}

function catalogModel(tokenMultiplier: number, id = "test-model"): ModelInfo {
  return { id, displayName: id === "test-model" ? "Test model" : id, supportedReasoningEfforts: [], disabled: false, tokenMultiplier } as unknown as ModelInfo;
}

async function runCommand(h: Awaited<ReturnType<typeof setup>>, name: string, args = "", clientMessageId: string = randomUUID()) {
  await h.connection.send({ type: "session.prompt", sessionId: "session", prompt: {
    clientMessageId, delivery: "auto", input: { type: "command", name, arguments: args },
  } });
  return h.waitFor("session.prompt_result", (event) => event.clientMessageId === clientMessageId);
}

test("commands are published before ready, refreshed after turns, and rediscovered on resume", async () => {
  let custom = [{ name: "review", description: "Review", argumentHint: "<branch>" }];
  const h = await setup(successful, { commands: async () => custom });
  try {
    await h.open();
    const commands = await h.waitFor("session.commands");
    assert.ok(commands.commands.some((command) => command.name === "review"));
    assert.ok(h.events.indexOf(commands) < h.events.findIndex((event) => event.type === "session.ready"));
    custom = [{ name: "changed", description: "Changed", argumentHint: "" }];
    await h.prompt();
    await h.waitFor("session.turn", (event) => event.state === "completed");
    assert.ok(h.events.findLast((event) => event.type === "session.commands")?.commands.some((command) => command.name === "changed"));
    const saved = await h.waitFor("session.persistence");
    await h.connection.send({ type: "session.close", requestId: "close-commands", sessionId: "session" });
    await h.waitFor("session.closed");
    custom = [{ name: "on-resume", description: "Resumed", argumentHint: "" }];
    await h.open("resumed-commands", saved.persistence);
    const resumed = await h.waitFor("session.commands", (event) => event.sessionId === "resumed-commands");
    assert.ok(resumed.commands.some((command) => command.name === "on-resume"));
  } finally { await h.cleanup(); }
});

test("native custom commands receive unexpanded quoted arguments and retain their composer text", async () => {
  const h = await setup(successful, { commands: async () => [{ name: "review", description: "Review" }] });
  try {
    await h.open();
    const args = '"feature/a b"\n$ARGUMENTS --literal  ';
    const receipt = await runCommand(h, "review", args, "custom-command");
    assert.equal(receipt.result.type, "turn");
    await h.waitFor("session.turn", (event) => event.state === "completed");
    assert.equal(h.natives[0].streamInputs[0].text, `/review ${args}`);
    const row = await h.waitFor("timeline.item", (event) => event.item.type === "user_message" && event.item.clientMessageId === "custom-command");
    assert.equal(row.item.type === "user_message" && row.item.text, `/review ${args}`);
  } finally { await h.cleanup(); }
});

test("failed discovery retains builtins, and an old CLI retains message sessions without command capability", async () => {
  let unavailable = true;
  const h = await setup(successful, { commands: async () => {
    if (unavailable) throw new Error("private-error");
    return [{ name: "recovered", description: "Recovered command" }];
  } });
  try {
    await h.open();
    assert.deepEqual((await h.waitFor("session.commands")).commands.map((command) => command.name), ["compact", "context", "limits"]);
    await h.waitFor("session.notice", (event) => event.notice.id === "droid-commands-discovery");
    assert.equal((await runCommand(h, "context")).result.type, "completed");
    assert.equal(h.natives[0].streamCalls, 0);
    unavailable = false;
    await h.prompt();
    await h.waitFor("session.turn", (event) => event.state === "completed");
    await h.waitFor("session.notice", (event) => event.notice.id === "droid-commands-discovery" && event.notice.dismissed === true);
    assert.ok(h.events.findLast((event) => event.type === "session.commands")?.commands.some((command) => command.name === "recovered"));
  } finally { await h.cleanup(); }
  const old = await setup(successful, { version: "0.245.0", commands: async () => { throw new Error("Must not discover"); } });
  try {
    await old.open();
    assert.equal(old.connection.capabilities.includes("prompt.command"), false);
    await old.waitFor("session.notice", (event) => event.notice.id === "droid-commands-version");
    await old.prompt();
    await old.waitFor("session.turn", (event) => event.state === "completed");
    assert.equal(old.events.some((event) => event.type === "session.commands"), false);
  } finally { await old.cleanup(); }
});

test("command steering and concurrent commands preserve the original turn without a failed steering disposition", async () => {
  const gate = deferred<void>();
  const h = await setup(async function* () { await gate.promise; yield result(); });
  try {
    await h.open(); await h.prompt("original");
    await h.waitFor("session.turn", (event) => event.state === "started");
    await assert.rejects(h.connection.send({ type: "session.prompt", sessionId: "session", prompt: {
      clientMessageId: "steered-command", delivery: "steer", input: { type: "message", content: [{ type: "text", text: "/compact retain details" }] },
    } }), /idle session/);
    const refused = await runCommand(h, "context");
    assert.equal(refused.result.type, "failed");
    assert.equal(h.events.some((event) => event.type === "session.prompt_result" && event.clientMessageId === "steered-command"), false);
    assert.equal(h.natives[0].interruptCalls, 0);
    assert.equal(h.steerCalls.length, 0);
    gate.resolve();
    await h.waitFor("session.turn", (event) => event.state === "completed");
  } finally { gate.resolve(); await h.cleanup(); }
});

test("context and limits complete without model work and limits receives the session environment", async () => {
  let env: Readonly<Record<string, string>> | undefined;
  const h = await setup(successful, { limits: async (value) => { env = value; return "Factory: 80% remaining"; } });
  try {
    h.config.env = { FACTORY_HOME_OVERRIDE: "/isolated/factory", FACTORY_API_KEY: "synthetic-key" };
    await h.open();
    for (const name of ["context", "limits"]) assert.equal((await runCommand(h, name, "", name)).result.type, "completed");
    assert.deepEqual(env, h.config.env);
    assert.equal(h.natives[0].streamCalls, 0);
    assert.equal(h.events.filter((event) => event.type === "session.turn").length, 0);
    const context = await h.waitFor("timeline.item", (event) => event.item.type === "assistant_message" && event.item.id === "paseo:command:context");
    assert.match(context.item.type === "assistant_message" ? context.item.text : "", /Used: 1,000 \/ 128,000/);
    const completedIndex = h.events.findIndex((event) => event.type === "session.prompt_result" && event.clientMessageId === "limits");
    assert.ok(h.events.slice(0, completedIndex).findLast((event) => event.type === "session.persistence"));
  } finally { await h.cleanup(); }
});

test("unknown commands and invalid builtin arguments fail before running a model", async () => {
  const h = await setup();
  try {
    await h.open();
    assert.equal((await runCommand(h, "missing")).result.type, "failed");
    assert.equal((await runCommand(h, "context", "unexpected")).result.type, "failed");
    assert.equal(h.natives[0].streamCalls, 0);
    await h.sendPrompt("path-text", [{ type: "text", text: "/tmp/file" }]);
    await h.waitFor("session.turn", (event) => event.state === "completed");
    assert.equal(h.natives[0].streamInputs[0].text, "/tmp/file");
  } finally { await h.cleanup(); }
});

test("compact replaces the native handle, rebinds events and saves a fresh reference before completion", async () => {
  const h = await setup();
  try {
    await h.open();
    const initial = await h.waitFor("session.opened");
    const oldSnapshot = await h.snapshotStore.load(initial.persistence!);
    const original = h.natives[0];
    let successor: FakeNative | undefined;
    original.compactHandler = async (native, params) => {
      assert.equal(params?.customInstructions, "Keep the important decisions");
      successor = new FakeNative(native.options, successful);
      successor.id = randomUUID();
      return { session: successor, removedCount: 4 };
    };
    const receipt = await runCommand(h, "compact", "Keep the important decisions", "compaction");
    assert.equal(receipt.result.type, "completed");
    const saved = h.events.findLast((event) => event.type === "session.persistence");
    assert.ok(saved?.type === "session.persistence");
    assert.equal((saved.persistence.data as { nativeSessionId: string }).nativeSessionId, successor!.id);
    assert.notEqual((saved.persistence.data as { snapshotKey: string }).snapshotKey, (initial.persistence!.data as { snapshotKey: string }).snapshotKey);
    assert.deepEqual(await h.snapshotStore.load(initial.persistence!), oldSnapshot);
    assert.equal(original.notifications.size, 0);
    assert.equal(successor!.notifications.size, 1);
    assert.ok(h.events.indexOf(saved) < h.events.indexOf(receipt));
    await h.prompt("after-compaction");
    await h.waitFor("session.turn", (event) => event.state === "completed");
    assert.equal(original.streamCalls, 0);
    assert.equal(successor!.streamCalls, 1);
    await h.connection.send({ type: "session.close", requestId: "close-compact", sessionId: "session" });
    await h.waitFor("session.closed");
    await h.open("compacted-resume", saved.persistence);
    assert.equal(h.resumed[0], successor!.id);
  } finally { await h.cleanup(); }
});

test("a rejected compact is recoverable, while an uncertain timeout invalidates the native session", async () => {
  const h = await setup(successful, { compact: async () => { throw new Error("Nothing to compact"); } });
  try {
    await h.open();
    assert.equal((await runCommand(h, "compact")).result.type, "failed");
    assert.equal(h.natives[0].notifications.size, 1);
    await h.prompt(); await h.waitFor("session.turn", (event) => event.state === "completed");
  } finally { await h.cleanup(); }
  const timedOut = await setup(successful, { compactionTimeoutMs: 5, compact: () => new Promise(() => {}) });
  try {
    await timedOut.open();
    assert.equal((await runCommand(timedOut, "compact")).result.type, "failed");
    await timedOut.waitFor("session.runtime_failed");
    await timedOut.prompt("after-timeout");
    const refused = await timedOut.waitFor("session.prompt_result", (event) => event.clientMessageId === "after-timeout");
    assert.equal(refused.result.type, "failed");
    assert.equal(timedOut.natives[0].streamCalls, 0);
  } finally { await timedOut.cleanup(); }
});

test("a failed compact checkpoint cannot report completion or overwrite the prior session head", async () => {
  const h = await setup();
  try {
    await h.open();
    const initial = await h.waitFor("session.opened");
    const before = await h.snapshotStore.load(initial.persistence!);
    const save = h.snapshotStore.save.bind(h.snapshotStore);
    h.snapshotStore.save = async () => { throw new Error("Synthetic disk full"); };
    const receipt = await runCommand(h, "compact");
    assert.equal(receipt.result.type, "failed");
    assert.deepEqual(await h.snapshotStore.load(initial.persistence!), before);
    assert.equal(h.events.some((event) => event.type === "session.runtime_failed"), false);
    h.snapshotStore.save = save;
    assert.equal((await runCommand(h, "context")).result.type, "completed");
    const saved = h.events.findLast((event) => event.type === "session.persistence");
    assert.ok(saved?.type === "session.persistence");
    assert.notEqual((saved.persistence.data as { nativeSessionId: string }).nativeSessionId, nativeId);
  } finally { await h.cleanup(); }
});

test("Stop cancels an in-flight compaction and requires reopening before further work", async () => {
  const started = deferred<void>();
  const h = await setup(successful, { compact: async () => { started.resolve(); return new Promise(() => {}); } });
  try {
    await h.open();
    const receipt = runCommand(h, "compact", "", "stop-compaction");
    await started.promise;
    await h.connection.send({ type: "session.interrupt", requestId: "stop-compact", sessionId: "session" });
    await h.waitFor("request.completed", (event) => event.requestId === "stop-compact");
    assert.equal((await receipt).result.type, "failed");
    await h.waitFor("session.runtime_failed");
    assert.equal(h.natives[0].streamCalls, 0);
  } finally { await h.cleanup(); }
});

test("closing a session cancels a pending read command without publishing a late successful result", async () => {
  const started = deferred<void>();
  const value = deferred<string>();
  const h = await setup(successful, { limits: async () => { started.resolve(); return value.promise; } });
  try {
    await h.open();
    const receipt = runCommand(h, "limits", "", "close-limits");
    await started.promise;
    await h.connection.send({ type: "session.close", requestId: "close-read", sessionId: "session" });
    await h.waitFor("session.closed");
    assert.equal((await receipt).result.type, "failed");
    const after = h.events.length;
    value.resolve("Late quota response");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.events.slice(after).some((event) => event.type === "session.prompt_result" || event.type === "timeline.item"), false);
  } finally { value.resolve("Stopped"); await h.cleanup(); }
});

test("same-ID compaction replaces its observer and nonpersistent sessions never write snapshots", async () => {
  const h = await setup(successful, { compact: async (native) => ({ session: new FakeNative(native.options, successful), removedCount: 1 }) });
  try {
    h.config.persist = false;
    h.snapshotStore.save = async () => { throw new Error("Nonpersistent sessions must not save"); };
    await h.open();
    assert.equal((await runCommand(h, "compact")).result.type, "completed");
    assert.equal(h.natives[0].notifications.size, 0);
    assert.equal(h.events.some((event) => event.type === "session.persistence"), false);
    await h.prompt();
    await h.waitFor("session.turn", (event) => event.state === "completed");
    assert.equal(h.natives[0].streamCalls, 0);
  } finally { await h.cleanup(); }
});

test("an idle permission card blocks commands until it is explicitly resolved", async () => {
  const h = await setup();
  try {
    await h.open();
    const permission = Promise.resolve(h.natives[0].options.permissionHandler(RequestPermissionRequestParamsSchema.parse({
      toolUses: [{ toolUse: { type: "tool_use", id: "idle-execute", name: "Execute", input: { command: "echo synthetic" } },
        confirmationType: "exec", details: { type: "exec", command: "echo", fullCommand: "echo synthetic" } }],
      options: [{ label: "Once", value: ToolConfirmationOutcome.ProceedOnce }, { label: "Cancel", value: ToolConfirmationOutcome.Cancel }],
    })));
    const card = await h.waitFor("session.permission");
    const receipt = await runCommand(h, "context");
    assert.equal(receipt.result.type, "failed");
    if (receipt.result.type === "failed") assert.match(receipt.result.error.message, /pending Droid permission/);
    await h.connection.send({ type: "session.permission", sessionId: "session", permissionId: card.request.id, response: { behavior: "deny" } });
    await permission;
    assert.equal((await runCommand(h, "context")).result.type, "completed");
  } finally { await h.cleanup(); }
});

test("a background wakeup during compact admission cancels only the command before its RPC starts", async () => {
  let compactCalls = 0;
  const h = await setup(successful, { compact: async () => { compactCalls++; throw new Error("Must not compact active background work"); } });
  try {
    await h.open();
    const unlisten = h.connection.onEvent((event) => {
      if (event.type === "timeline.item" && event.item.type === "user_message" && event.item.clientMessageId === "racing-compact")
        backgroundStart(h.natives[0], "background-before-compact");
    });
    assert.equal((await runCommand(h, "compact", "", "racing-compact")).result.type, "failed");
    unlisten();
    await h.waitFor("session.turn", (event) => event.state === "started");
    assert.equal(compactCalls, 0);
    assert.equal(h.events.some((event) => event.type === "session.runtime_failed"), false);
    backgroundComplete(h.natives[0], "background-before-compact");
    await h.waitFor("session.turn", (event) => event.state === "completed");
  } finally { await h.cleanup(); }
});

test("a quota read timeout releases command admission without closing the healthy session", async () => {
  const h = await setup(successful, { commandTimeoutMs: 5, limits: () => new Promise(() => {}) });
  try {
    await h.open();
    const receipt = await runCommand(h, "limits");
    assert.equal(receipt.result.type, "failed");
    assert.equal(h.events.some((event) => event.type === "session.runtime_failed"), false);
    await h.prompt();
    await h.waitFor("session.turn", (event) => event.state === "completed");
  } finally { await h.cleanup(); }
});

test("an SDK compaction timeout also invalidates its uncertain session", async () => {
  const h = await setup(successful, { compact: async () => { throw new DroidTimeoutError("Native request timed out"); } });
  try {
    await h.open();
    assert.equal((await runCommand(h, "compact")).result.type, "failed");
    await h.waitFor("session.runtime_failed");
    assert.equal(h.natives[0].notifications.size, 0);
  } finally { await h.cleanup(); }
});

test("each sequential new session sees current models and multipliers in the same directory", async () => {
  const h = await setup(successful, { catalog: async (call) => call === 1 ? [catalogModel(0.8)] : [catalogModel(1.2), catalogModel(0.04, "new-model")] });
  try {
    await h.open("first"); await h.open("second");
    const first = await h.waitFor("session.config", (e) => e.sessionId === "first");
    const second = await h.waitFor("session.config", (e) => e.sessionId === "second");
    assert.equal(first.config.models[0].label, "Test model · 0.8×");
    assert.equal(second.config.models[0].label, "Test model · 1.2×");
    assert.deepEqual(second.config.models.map((m) => m.id), ["test-model", "new-model"]);
    assert.equal(h.catalogCalls(), 2);
    assert.equal(h.natives.reduce((n, s) => n + s.streamCalls, 0), 0);
  } finally { await h.cleanup(); }
});

test("resuming a closed session refreshes its catalog without discarding native persistence", async () => {
  const h = await setup(successful, { catalog: async (call) => [catalogModel(call)] });
  try {
    await h.open(); const saved = await h.waitFor("session.opened");
    assert(saved.persistence);
    await h.connection.send({ type: "session.close", requestId: "close-refresh", sessionId: "session" });
    await h.waitFor("request.completed", (e) => e.requestId === "close-refresh");
    await h.open("resumed-refresh", saved.persistence);
    const state = await h.waitFor("session.config", (e) => e.sessionId === "resumed-refresh");
    assert.equal(state.config.models[0].label, "Test model · 2×");
    assert.deepEqual(h.resumed, [nativeId]); assert.equal(h.catalogCalls(), 2);
  } finally { await h.cleanup(); }
});

test("overlapping picker/open discoveries share one request, but a completed picker query is not a permanent cache", async () => {
  const gate = deferred<void>();
  const h = await setup(successful, { models: gate });
  try {
    await h.connection.send({ type: "catalog", requestId: "picker-overlap", cwd });
    await h.modelsStarted.promise;
    const a = h.open("parallel-a"), b = h.open("parallel-b");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.catalogCalls(), 1); gate.resolve();
    await Promise.all([a, b]); await h.waitFor("catalog", (e) => e.requestId === "picker-overlap");
    await h.connection.send({ type: "catalog", requestId: "picker-later", cwd });
    await h.waitFor("catalog", (e) => e.requestId === "picker-later");
    assert.equal(h.catalogCalls(), 2);
  } finally { gate.resolve(); await h.cleanup(); }
});

test("concurrent session catalogs use their own launch overlays and never share different account results", async () => {
  const gate = deferred<void>();
  const h = await setup(successful, { catalog: async (_call, env) => { await gate.promise; return [catalogModel(env.FACTORY_HOME_OVERRIDE === "/account-a" ? 1 : 2)]; } });
  try {
    for (const [id, home] of [["account-a", "/account-a"], ["account-b", "/account-b"]])
      await h.connection.send({ type: "session.open", requestId: `open:${id}`, sessionId: id, config: { ...h.config, env: { FACTORY_HOME_OVERRIDE: home } }, history: "skip" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.catalogCalls(), 2); gate.resolve();
    await h.waitFor("session.ready", (e) => e.sessionId === "account-b");
    const a = await h.waitFor("session.config", (e) => e.sessionId === "account-a");
    const b = await h.waitFor("session.config", (e) => e.sessionId === "account-b");
    assert.equal(a.config.models[0].label, "Test model · 1×"); assert.equal(b.config.models[0].label, "Test model · 2×");
  } finally { gate.resolve(); await h.cleanup(); }
});

test("a failed refresh does not reuse stale pricing or stop existing sessions, and retry discovers again", async () => {
  const h = await setup(successful, { catalog: async (call) => { if (call === 2) throw new Error("Catalog temporarily unavailable"); return [catalogModel(call)]; } });
  try {
    await h.open("existing");
    await h.connection.send({ type: "session.open", requestId: "bad-refresh", sessionId: "failed", config: h.config, history: "skip" });
    const failure = await h.waitFor("request.failed", (e) => e.requestId === "bad-refresh");
    assert.match(failure.error.message, /Catalog temporarily unavailable/);
    assert.equal(h.natives.length, 1);
    await h.prompt("existing-still-works", "existing");
    await h.waitFor("session.turn", (e) => e.sessionId === "existing" && e.state === "completed");
    await h.open("retry");
    const state = await h.waitFor("session.config", (e) => e.sessionId === "retry");
    assert.equal(state.config.models[0].label, "Test model · 3×");
    assert.equal(h.catalogCalls(), 3);
  } finally { await h.cleanup(); }
});

test("a selected model removed from the fresh catalog fails before native creation instead of silently switching", async () => {
  const h = await setup(successful, { catalog: async (call) => [catalogModel(1, call === 1 ? "test-model" : "replacement-model")] });
  try {
    await h.open("old");
    await h.connection.send({ type: "session.open", requestId: "removed-model", sessionId: "new", config: h.config, history: "skip" });
    const failure = await h.waitFor("request.failed", (e) => e.requestId === "removed-model");
    assert.match(failure.error.message, /test-model.*unavailable.*refreshed catalog/);
    assert.equal(h.natives.length, 1);
    assert.equal(h.events.filter((e) => e.type === "session.ready" && e.sessionId === "new").length, 0);
  } finally { await h.cleanup(); }
});

test("closing one session waiting for a shared refresh returns promptly and leaves the other waiter intact", async () => {
  const gate = deferred<void>();
  const h = await setup(successful, { models: gate });
  try {
    await h.connection.send({ type: "session.open", requestId: "closing-open", sessionId: "closing", config: h.config, history: "skip" });
    const survivor = h.open("survivor");
    await h.modelsStarted.promise;
    await h.connection.send({ type: "session.close", requestId: "cancel-catalog-wait", sessionId: "closing" });
    await h.waitFor("request.completed", (e) => e.requestId === "cancel-catalog-wait");
    assert.equal(h.transports[0].isConnected, true);
    assert.equal(h.natives.length, 0); assert.equal(h.catalogCalls(), 1);
    gate.resolve(); await survivor;
    assert.equal(h.natives.length, 1);
    assert.equal(h.events.filter((e) => e.type === "session.ready" && e.sessionId === "closing").length, 0);
  } finally { gate.resolve(); await h.cleanup(); }
});

function stats(used: number, limit: number): GetContextStatsResult {
  return { used, remaining: Math.max(0, limit - used), limit, accuracy: ContextStatsAccuracy.Estimated, updatedAt: "2026-10-17T00:00:00.000Z" };
}

test("native context stats populate open/configure usage and every update retains the other usage fields", async () => {
  const h = await setup(async function* () {
    yield { ...result(), tokenUsage: { inputTokens: 8000, outputTokens: 900, cacheReadTokens: 7000 } } as DroidMessage;
  });
  try {
    await h.open();
    const initial = await h.waitFor("session.usage", (event) => event.usage.contextWindowMaxTokens === 128000);
    assert.deepEqual(initial.usage, { contextWindowMaxTokens: 128000, contextWindowUsedTokens: 1000 });
    await h.prompt();
    const tokens = await h.waitFor("session.usage", (event) => event.usage.inputTokens === 8000);
    assert.deepEqual(tokens.usage, {
      contextWindowMaxTokens: 128000, contextWindowUsedTokens: 1000,
      inputTokens: 8000, outputTokens: 900, cachedInputTokens: 7000,
    });
    const afterTurn = await h.waitFor("session.usage", (event) => event.usage.contextWindowUsedTokens === 1100);
    assert.equal(afterTurn.usage.inputTokens, 8000);
    assert.equal(afterTurn.usage.outputTokens, 900);
    assert.equal(afterTurn.usage.cachedInputTokens, 7000);
    assert.notEqual(afterTurn.usage.contextWindowUsedTokens, afterTurn.usage.inputTokens,
      "Committed input tokens are not current context occupancy");
    const after = h.events.length;
    await h.connection.send({ type: "session.configure", requestId: "large-context", sessionId: "session", changes: { model: "large-model" } });
    await h.waitFor("request.completed", (event) => event.requestId === "large-context");
    const changed = await h.waitFor("session.usage", (event) => event.usage.contextWindowMaxTokens === 500000, after);
    assert.deepEqual(changed.usage, {
      contextWindowMaxTokens: 500000, contextWindowUsedTokens: 1100,
      inputTokens: 8000, outputTokens: 900, cachedInputTokens: 7000,
    });
    assert.equal(h.natives[0].contextCalls, 3);
  } finally { await h.cleanup(); }
});

test("resume reads context from the resumed native session rather than reconstructing it from prompt token counts", async () => {
  let nativeUsed = 4300;
  const h = await setup(async function* () { nativeUsed = 7600; yield result(); }, {
    context: async () => stats(nativeUsed, 200000),
  });
  try {
    await h.open();
    await h.waitFor("session.usage", (event) => event.usage.contextWindowUsedTokens === 4300);
    await h.prompt();
    const saved = await h.waitFor("session.persistence");
    await h.waitFor("session.usage", (event) => event.usage.contextWindowUsedTokens === 7600);
    await h.connection.send({ type: "session.close", requestId: "close-context", sessionId: "session" });
    await h.waitFor("request.completed", (event) => event.requestId === "close-context");
    const after = h.events.length;
    await h.open("resumed-context", saved.persistence);
    const resumed = await h.waitFor("session.usage", (event) => event.sessionId === "resumed-context", after);
    assert.deepEqual(resumed.usage, { contextWindowMaxTokens: 200000, contextWindowUsedTokens: 7600 });
    assert.equal(h.natives[1].contextCalls, 1);
  } finally { await h.cleanup(); }
});

test("native settings changes refresh the context limit during the active turn", async () => {
  const release = deferred<void>();
  const h = await setup(async function* (native) {
    native.settings.modelId = "large-model";
    yield { type: "settings_updated", settings: native.settings } as DroidMessage;
    await release.promise;
    yield result();
  });
  try {
    await h.open();
    await h.waitFor("session.usage", (event) => event.usage.contextWindowMaxTokens === 128000);
    await h.prompt();
    const updated = await h.waitFor("session.usage", (event) => event.usage.contextWindowMaxTokens === 500000);
    assert.equal(updated.usage.contextWindowUsedTokens, 1100);
    assert.equal(h.terminalTurns().length, 0);
    release.resolve();
    await h.waitFor("session.persistence");
  } finally { release.resolve(); await h.cleanup(); }
});

test("a late context response from the old model cannot overwrite the new model's meter", async () => {
  const old = deferred<GetContextStatsResult>();
  const h = await setup(successful, {
    context: async (native) => native.settings.modelId === "test-model" ? old.promise : stats(4200, 500000),
  });
  try {
    await h.open();
    await h.connection.send({ type: "session.configure", requestId: "change-before-stats", sessionId: "session", changes: { model: "large-model" } });
    await h.waitFor("session.usage", (event) => event.usage.contextWindowMaxTokens === 500000);
    const after = h.events.length;
    old.resolve(stats(1200, 128000));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.events.slice(after).filter((event) => event.type === "session.usage").length, 0);
  } finally { old.resolve(stats(1200, 128000)); await h.cleanup(); }
});

test("a model change clears the prior capacity when new-model stats fail and later recovers without losing token counters", async () => {
  let failure = false;
  const h = await setup(async function* () {
    yield { ...result(), tokenUsage: { inputTokens: 6400, outputTokens: 320, cacheReadTokens: 6000 } } as DroidMessage;
  }, {
    context: async (native) => {
      if (failure) throw new Error("Context unavailable");
      return native.settings.modelId === "large-model" ? stats(2700, 500000) : stats(1200, 128000);
    },
  });
  try {
    await h.open();
    await h.waitFor("session.usage", (event) => event.usage.contextWindowMaxTokens === 128000);
    await h.prompt();
    await h.waitFor("session.persistence");
    await h.waitFor("session.usage", (event) => event.usage.inputTokens === 6400);
    // Allow the same-model post-turn context query to finish before failing the
    // next model's query, matching an idle model-switch in the composer.
    await new Promise<void>((resolve) => setImmediate(resolve));
    failure = true;
    const afterChange = h.events.length;
    await h.connection.send({ type: "session.configure", requestId: "new-model-stats-fail", sessionId: "session", changes: { model: "large-model" } });
    await h.waitFor("request.completed", (event) => event.requestId === "new-model-stats-fail");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const cleared = h.events.slice(afterChange).findLast((event) => event.type === "session.usage") as Extract<ProviderEvent, { type: "session.usage" }>;
    assert.deepEqual(cleared.usage, { inputTokens: 6400, outputTokens: 320, cachedInputTokens: 6000 });
    assert.equal(Object.hasOwn(cleared.usage, "contextWindowMaxTokens"), false);
    assert.equal(Object.hasOwn(cleared.usage, "contextWindowUsedTokens"), false);

    failure = false;
    const afterRetry = h.events.length;
    await h.connection.send({ type: "session.configure", requestId: "new-model-stats-recover", sessionId: "session", changes: { mode: "spec" } });
    const recovered = await h.waitFor("session.usage", (event) => event.usage.contextWindowMaxTokens === 500000, afterRetry);
    assert.deepEqual(recovered.usage, {
      inputTokens: 6400, outputTokens: 320, cachedInputTokens: 6000,
      contextWindowMaxTokens: 500000, contextWindowUsedTokens: 2700,
    });

    failure = true;
    const afterTransient = h.events.length;
    await h.connection.send({ type: "session.configure", requestId: "same-model-stats-fail", sessionId: "session", changes: { mode: "ask" } });
    await h.waitFor("request.completed", (event) => event.requestId === "same-model-stats-fail");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.events.slice(afterTransient).filter((event) => event.type === "session.usage").length, 0,
      "Same-model telemetry failures retain the last valid context instead of clearing it");
  } finally { await h.cleanup(); }
});

test("failed, invalid and timed-out context telemetry never fails a turn or closes its transport", async () => {
  for (const mode of ["failed", "invalid", "timeout"] as const) {
    const pending = deferred<GetContextStatsResult>();
    const h = await setup(async function* () {
      yield { ...result(), tokenUsage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 2 } } as DroidMessage;
    }, {
      contextTimeoutMs: 10,
      context: async () => {
        if (mode === "failed") throw new Error("private context diagnostic");
        if (mode === "invalid") return stats(NaN, Infinity);
        return pending.promise;
      },
    });
    try {
      await h.open();
      await h.prompt();
      await h.waitFor("session.persistence");
      await h.waitFor("session.turn", (event) => event.state === "completed");
      await h.connection.send({ type: "session.configure", requestId: `configure:${mode}`, sessionId: "session", changes: { mode: "spec" } });
      await h.waitFor("request.completed", (event) => event.requestId === `configure:${mode}`);
      if (mode === "timeout") await new Promise<void>((resolve) => setTimeout(resolve, 25));
      assert.equal((h.terminalTurns()[0] as Extract<ProviderEvent, { type: "session.turn" }>).state, "completed");
      assert.equal(h.events.filter((event) => event.type === "request.failed" || event.type === "session.notice").length, 0);
      assert.ok(h.events.filter((event) => event.type === "session.usage").every((event) => event.usage.contextWindowMaxTokens === undefined));
      assert.equal(h.transports.at(-1)?.isConnected, true, "Optional context timeout must not close a working transport");
      const latest = h.events.findLast((event) => event.type === "session.usage") as Extract<ProviderEvent, { type: "session.usage" }>;
      assert.deepEqual(latest.usage, { inputTokens: 12, outputTokens: 4, cachedInputTokens: 2 });
    } finally { pending.resolve(stats(99, 200000)); await h.cleanup(); }
  }
});

test("closing a session cancels an in-flight context wait and suppresses a late usage event", async () => {
  const pending = deferred<GetContextStatsResult>();
  const started = deferred<void>();
  const h = await setup(successful, { context: async () => { started.resolve(); return pending.promise; } });
  try {
    await h.open();
    await started.promise;
    await h.connection.send({ type: "session.close", requestId: "close-with-stats", sessionId: "session" });
    await h.waitFor("request.completed", (event) => event.requestId === "close-with-stats");
    const after = h.events.length;
    pending.resolve(stats(4000, 200000));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.events.slice(after).filter((event) => event.type === "session.usage").length, 0);
    assert.ok(h.transports.every((transport) => !transport.isConnected));
  } finally { pending.resolve(stats(4000, 200000)); await h.cleanup(); }
});

test("a late usage observer receives bounded cached startup snapshots without additional context RPCs", async () => {
  const h = await setup(async function* () {
    yield { ...result(), tokenUsage: { inputTokens: 500, outputTokens: 90, cacheReadTokens: 400 } } as DroidMessage;
  }, { usageReplayDelaysMs: [25, 50, 75] });
  const late: Array<Extract<ProviderEvent, { type: "session.usage" }>> = [];
  try {
    await h.open();
    await h.waitFor("session.usage", (event) => event.usage.contextWindowMaxTokens === 128000);
    await h.prompt();
    await h.waitFor("session.usage", (event) => event.usage.contextWindowUsedTokens === 1100);
    // Simulate Paseo subscribing only after asynchronous registration, missing
    // both the native context response and the first turn's usage events.
    h.connection.onEvent((event) => { if (event.type === "session.usage") late.push(event); });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.ok(late.length > 0 && late.length <= 3, "A late subscriber receives only the startup deliveries that remain");
    assert.equal(h.events.filter((event) => event.type === "session.usage" && event.turnId === undefined).length, 5,
      "Two context snapshots plus exactly three startup replays, independent of disk timing");
    assert.ok(late.every((event) => event.turnId === undefined));
    assert.ok(late.every((event) => JSON.stringify(event.usage) === JSON.stringify({
      contextWindowMaxTokens: 128000, contextWindowUsedTokens: 1100,
      inputTokens: 500, outputTokens: 90, cachedInputTokens: 400,
    })));
    assert.equal(h.natives[0].contextCalls, 2, "Cached replay must not request context again");
  } finally { await h.cleanup(); }
});

test("startup usage replays read the current model snapshot instead of restoring the old model's capacity", async () => {
  const h = await setup(successful, { usageReplayDelaysMs: [20, 40] });
  const late: Array<Extract<ProviderEvent, { type: "session.usage" }>> = [];
  try {
    await h.open();
    await h.waitFor("session.usage", (event) => event.usage.contextWindowMaxTokens === 128000);
    await h.connection.send({ type: "session.configure", requestId: "model-before-replay", sessionId: "session", changes: { model: "large-model" } });
    await h.waitFor("session.usage", (event) => event.usage.contextWindowMaxTokens === 500000);
    h.connection.onEvent((event) => { if (event.type === "session.usage") late.push(event); });
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    assert.equal(late.length, 2);
    assert.ok(late.every((event) => event.usage.contextWindowMaxTokens === 500000 && event.usage.contextWindowUsedTokens === 1000));
    assert.equal(h.natives[0].contextCalls, 2);
  } finally { await h.cleanup(); }
});

test("closing before startup replay cancels its deliveries and empty usage is never replayed", async () => {
  const closed = await setup(successful, { usageReplayDelaysMs: [10, 20] });
  try {
    await closed.open();
    await closed.waitFor("session.usage", (event) => event.usage.contextWindowMaxTokens === 128000);
    await closed.connection.send({ type: "session.close", requestId: "close-before-usage-replay", sessionId: "session" });
    await closed.waitFor("request.completed", (event) => event.requestId === "close-before-usage-replay");
    const after = closed.events.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    assert.equal(closed.events.slice(after).filter((event) => event.type === "session.usage").length, 0);
  } finally { await closed.cleanup(); }

  const empty = await setup(successful, { usageReplayDelaysMs: [10, 20], context: async () => { throw new Error("No native context data"); } });
  try {
    await empty.open();
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    assert.equal(empty.events.filter((event) => event.type === "session.usage").length, 0);
    assert.equal(empty.natives[0].contextCalls, 1);
  } finally { await empty.cleanup(); }
});

test("native permission cards unblock the active turn and a concurrent prompt is rejected once", async () => {
  const h = await setup(needsPermission);
  try {
    await h.open();
    await h.prompt();
    const permission = await h.waitFor("session.permission");
    assert.equal(h.terminalTurns().length, 0, "Turn must remain active while permission is pending");
    await h.prompt("concurrent-message");
    const refused = await h.waitFor("session.prompt_result", (event) => event.clientMessageId === "concurrent-message");
    assert.equal(refused.result.type, "failed");
    await h.connection.send({ type: "session.permission", sessionId: "session", permissionId: permission.request.id,
      response: { behavior: "allow", selectedActionId: ToolConfirmationOutcome.ProceedOnce } });
    await h.waitFor("session.persistence");
    await h.waitFor("session.turn", (event) => event.state === "completed");
    assert.equal(h.terminalTurns().length, 1);
    assert.equal((h.terminalTurns()[0] as Extract<ProviderEvent, { type: "session.turn" }>).state, "completed");
    assert.equal(h.events.filter((event) => event.type === "session.prompt_result" && event.clientMessageId === "message-1").length, 1);
    assert.equal(h.events.filter((event) => event.type === "session.prompt_result" && event.clientMessageId === "concurrent-message").length, 1);
    const tools = h.events.filter((event) => event.type === "timeline.item" && event.item.type === "tool_call");
    assert.equal((tools.at(-1) as Extract<ProviderEvent, { type: "timeline.item" }>).item.type, "tool_call");
    assert.equal(h.natives[0].streamCalls, 1);
  } finally { await h.cleanup(); }
});

test("interrupt settles a pending permission and emits one canceled terminal without a second prompt result", async () => {
  const h = await setup(needsPermission);
  try {
    await h.open();
    await h.prompt();
    const permission = await h.waitFor("session.permission");
    await h.connection.send({ type: "session.interrupt", requestId: "interrupt", sessionId: "session" });
    await h.waitFor("request.completed", (event) => event.requestId === "interrupt");
    assert.equal(h.natives[0].interruptCalls, 1);
    assert.equal(h.terminalTurns().length, 1);
    assert.equal((h.terminalTurns()[0] as Extract<ProviderEvent, { type: "session.turn" }>).state, "canceled");
    assert.equal(h.events.filter((event) => event.type === "session.prompt_result").length, 1);
    assert.equal(h.events.filter((event) => event.type === "session.permission_resolved" && event.permissionId === permission.request.id).length, 1);
    const tool = h.events.findLast((event) => event.type === "timeline.item" && event.item.type === "tool_call") as Extract<ProviderEvent, { type: "timeline.item" }>;
    assert.equal(tool.item.type === "tool_call" && tool.item.status, "canceled");

    const after = h.events.length;
    await h.prompt("message-after-interrupt");
    const next = await h.waitFor("session.permission", () => true, after);
    await h.connection.send({ type: "session.permission", sessionId: "session", permissionId: next.request.id, response: { behavior: "allow" } });
    await h.waitFor("session.persistence", () => true, after);
    await h.waitFor("session.turn", (event) => event.state === "completed", after);
    assert.equal(h.terminalTurns().length, 2);
  } finally { await h.cleanup(); }
});

test("stream errors after acceptance produce one failed terminal, and post-result errors do not duplicate completion", async () => {
  for (const afterResult of [false, true]) {
    const h = await setup(async function* () {
      if (afterResult) yield result();
      throw new Error("native stream failed");
    });
    try {
      await h.open();
      await h.prompt();
      await h.waitFor("session.persistence");
      await h.waitFor("session.turn", (event) => event.state !== "started");
      assert.equal(h.events.filter((event) => event.type === "session.prompt_result").length, 1);
      assert.equal(h.terminalTurns().length, 1);
      assert.equal((h.terminalTurns()[0] as Extract<ProviderEvent, { type: "session.turn" }>).state, afterResult ? "completed" : "failed");
    } finally { await h.cleanup(); }
  }
});

test("completed-turn persistence restores final snapshots after close and reopen without rerunning the model", async () => {
  const h = await setup();
  try {
    await h.open();
    await h.prompt();
    const saved = await h.waitFor("session.persistence");
    const snapshots = (await h.snapshotStore.load(saved.persistence)).items;
    assert.equal(snapshots.length, 2, "Persistence contains one user row and one final assistant row");
    assert.equal((snapshots[1] as { text: string }).text, "Hello from Droid");
    await h.connection.send({ type: "session.close", requestId: "close", sessionId: "session" });
    await h.waitFor("request.completed", (event) => event.requestId === "close");
    assert.ok(h.natives[0].closeCalls > 0);
    const after = h.events.length;
    await h.open("resumed", saved.persistence);
    const replayed = h.events.slice(after).filter((event) => event.type === "timeline.item").map((event) => (event as Extract<ProviderEvent, { type: "timeline.item" }>).item);
    assert.deepEqual(replayed, snapshots);
    assert.deepEqual(h.resumed, [nativeId]);
    assert.equal(h.natives[0].streamCalls, 1);
    assert.equal(h.natives[1].streamCalls, 0);
    assert.ok(h.transports.every((transport, index) => index === h.transports.length - 1 || !transport.isConnected));
  } finally { await h.cleanup(); }
});

test("session close during native initialization closes its transport and never publishes a ready session", async () => {
  const gate = deferred<void>();
  const h = await setup(successful, { create: gate });
  try {
    await h.connection.send({ type: "session.open", requestId: "opening", sessionId: "session", config: h.config, history: "skip" });
    await h.createStarted.promise;
    await h.connection.send({ type: "session.close", requestId: "close-opening", sessionId: "session" });
    await h.waitFor("request.completed", (event) => event.requestId === "close-opening");
    assert.equal(h.events.filter((event) => event.type === "session.opened" || event.type === "session.ready").length, 0);
    assert.ok(h.transports.every((transport) => !transport.isConnected));
    assert.equal(h.natives.length, 0);
    await h.waitFor("request.failed", (event) => event.requestId === "opening");
  } finally { gate.resolve(); await h.cleanup(); }
});

test("connection close releases a pending catalog immediately instead of waiting for initialization timeout", async () => {
  const gate = deferred<void>();
  const h = await setup(successful, { models: gate });
  let closing: Promise<void> | undefined;
  try {
    await h.connection.send({ type: "session.open", requestId: "opening", sessionId: "session", config: h.config, history: "skip" });
    await h.modelsStarted.promise;
    closing = h.connection.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.transports[0].isConnected, false, "Closing the connection must cancel the catalog transport while session.open is waiting for it");
    await closing;
    assert.equal(h.events.filter((event) => event.type === "session.opened" || event.type === "session.ready").length, 0);
  } finally { gate.resolve(); await closing; await h.cleanup(); }
});

function heldTurn() {
  const started = deferred<void>();
  const release = deferred<void>();
  const script: Script = async function* (native) {
    const done = () => release.resolve();
    native.onInterrupt.add(done);
    native.onShutdown.add(done);
    started.resolve();
    try {
      yield { type: "assistant_text_delta", messageId: "held-answer", blockIndex: 0, text: "Working" };
      await release.promise;
      yield result(!native.interrupted);
    } finally {
      native.onInterrupt.delete(done);
      native.onShutdown.delete(done);
    }
  };
  return { script, started, release };
}

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5nQAAAAASUVORK5CYII=";
const picture: ProviderContent = { type: "image", data: pngBase64, mimeType: "image/png" };
const privateDocument = "PRIVATE_DOCUMENT_BODY_droid_provider_integration";
const contextDocument: ProviderContent = { type: "text", mimeType: "text/plain", title: "brief.txt", text: privateDocument };
const nextTask = () => new Promise<void>((resolve) => setImmediate(resolve));

test("active steering acknowledges the original turn in order without interrupting or opening another stream", async () => {
  const turn = heldTurn();
  const firstAck = deferred<void>();
  const h = await setup(turn.script, {
    steer: async (text) => { if (text === "First steering update") await firstAck.promise; },
  });
  try {
    await h.open();
    await h.prompt();
    await turn.started.promise;
    const original = await h.waitFor("session.prompt_result", (event) => event.clientMessageId === "message-1");
    assert.equal(original.result.type, "turn");
    if (original.result.type !== "turn") throw new Error("Expected original turn disposition");

    await h.sendPrompt("steer-1", [{ type: "text", text: "First steering update" }], "steer");
    await h.steerStarted.promise;
    let firstSendSettled = false;
    void h.sent("steer-1").then(() => { firstSendSettled = true; });
    await h.sendPrompt("steer-2", [{ type: "text", text: "Second steering update" }], "steer");
    await nextTask();
    assert.deepEqual(h.steerCalls.map((call) => call.text), ["First steering update"], "Second steering input must wait for the first acknowledgment");
    assert.equal(h.events.filter((event) => event.type === "session.prompt_result" && event.clientMessageId.startsWith("steer-")).length, 0);
    assert.equal(firstSendSettled, false, "The host must still be awaiting steering acceptance until the native ACK");

    firstAck.resolve();
    const first = await h.waitFor("session.prompt_result", (event) => event.clientMessageId === "steer-1");
    const second = await h.waitFor("session.prompt_result", (event) => event.clientMessageId === "steer-2");
    await Promise.all([h.sent("steer-1"), h.sent("steer-2")]);
    assert.deepEqual(first.result, { type: "steer", turnId: original.result.turnId });
    assert.deepEqual(second.result, { type: "steer", turnId: original.result.turnId });
    assert.deepEqual(h.steerCalls.map((call) => call.text), ["First steering update", "Second steering update"]);
    assert.deepEqual(h.steerCalls.map((call) => call.options?.messageId), ["steer-1", "steer-2"]);
    assert.equal(h.events.filter((event) => event.type === "session.turn" && event.state === "started").length, 1);
    assert.equal(h.terminalTurns().length, 0, "Steering must leave the original turn active");
    assert.equal(h.natives[0].streamCalls, 1);
    assert.equal(h.natives[0].interruptCalls, 0);
    assert.equal(h.natives.length, 1);
    for (const id of ["steer-1", "steer-2"]) {
      assert.equal(h.events.filter((event) => event.type === "timeline.item" && event.item.type === "user_message" && event.item.clientMessageId === id).length, 1);
      assert.equal(h.events.filter((event) => event.type === "session.prompt_result" && event.clientMessageId === id).length, 1);
    }
    turn.release.resolve();
    const terminal = await h.waitFor("session.turn", (event) => event.state === "completed");
    assert.equal(terminal.turnId, original.result.turnId);
    assert.equal(h.terminalTurns().length, 1);
  } finally { firstAck.resolve(); turn.release.resolve(); await h.cleanup(); }
});

test("native image and document options reach initial stream and steering while persistence contains markers only", async () => {
  const turn = heldTurn();
  const h = await setup(turn.script);
  try {
    await h.open();
    await h.sendPrompt("initial-attachments", [{ type: "text", text: "Inspect these" }, picture, contextDocument]);
    await turn.started.promise;
    const input = h.natives[0].streamInputs[0];
    assert.equal(input.options?.includePartialMessages, true);
    assert.deepEqual(input.options?.images, [{ type: "base64", mediaType: "image/png", data: pngBase64 }]);
    assert.deepEqual(input.options?.files, [{ type: "text", mediaType: "text/plain", name: "brief.txt", data: privateDocument }]);
    assert.match(input.text, /native image 1/);
    assert.match(input.text, /brief\.txt/);

    await h.sendPrompt("steer-attachments", [picture, contextDocument], "steer");
    const steered = await h.waitFor("session.prompt_result", (event) => event.clientMessageId === "steer-attachments");
    assert.equal(steered.result.type, "steer");
    assert.deepEqual(h.steerCalls[0].options?.images, input.options?.images);
    assert.deepEqual(h.steerCalls[0].options?.files, input.options?.files);
    assert.equal(h.natives[0].streamCalls, 1);
    const persisted = await h.waitFor("session.persistence");
    const rendered = JSON.stringify(await h.snapshotStore.load(persisted.persistence));
    assert.match(rendered, /Attachment 1: image 1/);
    assert.match(rendered, /brief\.txt/);
    assert.ok(!rendered.includes(pngBase64), "Binary image data must stay out of persisted timeline rows");
    assert.ok(!rendered.includes(privateDocument), "Document bodies must stay out of persisted user rows");
  } finally { turn.release.resolve(); await h.cleanup(); }
});

test("invalid and missing attachments fail before prompt acceptance and do not leave the session busy", async () => {
  const h = await setup();
  try {
    await h.open();
    const invalid: ProviderContent[] = [
      { type: "image", mimeType: "image/png", data: "%%%invalid-base64%%%" },
      { type: "uploaded_file", id: "missing", fileName: "missing.txt", mimeType: "text/plain", size: 10, path: `/tmp/droid-provider-missing-${process.pid}/missing.txt` },
    ];
    for (const [index, attachment] of invalid.entries()) {
      const id = `invalid-attachment-${index}`;
      await h.sendPrompt(id, [attachment]);
      const refused = await h.waitFor("session.prompt_result", (event) => event.clientMessageId === id);
      assert.equal(refused.result.type, "failed");
      assert.equal(h.events.filter((event) => event.type === "session.prompt_result" && event.clientMessageId === id).length, 1);
      assert.equal(h.events.filter((event) => event.type === "timeline.item" && event.item.type === "user_message" && event.item.clientMessageId === id).length, 0);
    }
    assert.equal(h.natives[0].streamCalls, 0);
    assert.equal(h.events.filter((event) => event.type === "session.turn").length, 0);
    await h.prompt("valid-after-invalid");
    await h.waitFor("session.turn", (event) => event.state === "completed");
    assert.equal(h.natives[0].streamCalls, 1);
  } finally { await h.cleanup(); }
});

test("models that reject images fail before acceptance and still accept a later text prompt", async () => {
  const h = await setup(successful, { noImageSupport: true });
  try {
    await h.open();
    await h.sendPrompt("unsupported-image", [picture]);
    const refused = await h.waitFor("session.prompt_result", (event) => event.clientMessageId === "unsupported-image");
    assert.equal(refused.result.type, "failed");
    if (refused.result.type === "failed") assert.match(refused.result.error.message, /does not accept images/);
    assert.equal(h.natives[0].streamCalls, 0);
    assert.equal(h.events.filter((event) => event.type === "session.turn").length, 0);
    await h.prompt("text-after-rejected-image");
    await h.waitFor("session.turn", (event) => event.state === "completed");
    assert.equal(h.natives[0].streamCalls, 1);
  } finally { await h.cleanup(); }
});

test("asynchronous attachment preparation reserves the session before another auto prompt can race it", async () => {
  const preparing = deferred<void>();
  const prepared = deferred<PreparedPrompt>();
  const h = await setup(successful, {
    prepare: async (request, options) => {
      if (request.clientMessageId !== "slow-preparation") return preparePrompt(request, options);
      preparing.resolve();
      return prepared.promise;
    },
  });
  try {
    await h.open();
    await h.prompt("slow-preparation");
    await preparing.promise;
    await h.prompt("racing-auto");
    const refused = await h.waitFor("session.prompt_result", (event) => event.clientMessageId === "racing-auto");
    assert.equal(refused.result.type, "failed");
    assert.equal(h.natives[0].streamCalls, 0);
    prepared.resolve({ text: "prepared input", timelineText: "prepared marker", options: {} });
    await h.waitFor("session.turn", (event) => event.state === "completed");
    assert.equal(h.natives[0].streamCalls, 1);
    assert.equal(h.events.filter((event) => event.type === "session.prompt_result" && event.clientMessageId === "slow-preparation").length, 1);
  } finally { prepared.resolve({ text: "cleanup", timelineText: "cleanup", options: {} }); await h.cleanup(); }
});

test("stop during asynchronous preparation prevents a late model start and permits a clean retry", async () => {
  const preparing = deferred<void>();
  const prepared = deferred<PreparedPrompt>();
  let signal: AbortSignal | undefined;
  const h = await setup(successful, {
    prepare: async (request, options) => {
      if (request.clientMessageId !== "stop-during-prep") return preparePrompt(request, options);
      signal = options?.signal;
      preparing.resolve();
      return prepared.promise;
    },
  });
  try {
    await h.open();
    await h.prompt("stop-during-prep");
    await preparing.promise;
    await h.connection.send({ type: "session.interrupt", requestId: "stop-prep", sessionId: "session" });
    await h.waitFor("request.completed", (event) => event.requestId === "stop-prep");
    assert.equal(signal?.aborted, true);
    prepared.resolve({ text: "must never reach the model", timelineText: "canceled marker", options: {} });
    const refused = await h.waitFor("session.prompt_result", (event) => event.clientMessageId === "stop-during-prep");
    assert.equal(refused.result.type, "failed");
    assert.equal(h.natives[0].streamCalls, 0);
    assert.equal(h.events.filter((event) => event.type === "session.turn").length, 0);
    await h.prompt("after-stopped-prep");
    await h.waitFor("session.turn", (event) => event.state === "completed");
    assert.equal(h.natives[0].streamCalls, 1);
  } finally { prepared.resolve({ text: "cleanup", timelineText: "cleanup", options: {} }); await h.cleanup(); }
});

test("late steering acknowledgments cannot falsely succeed after the original turn ended or was interrupted", async () => {
  for (const interrupted of [false, true]) {
    const turn = heldTurn();
    const ack = deferred<void>();
    const h = await setup(turn.script, { steer: async () => ack.promise });
    try {
      await h.open();
      await h.prompt();
      await turn.started.promise;
      await h.sendPrompt("late-steer", [{ type: "text", text: "Update while working" }], "steer");
      await h.steerStarted.promise;
      if (interrupted) {
        await h.connection.send({ type: "session.interrupt", requestId: "stop-late-steer", sessionId: "session" });
        await h.waitFor("request.completed", (event) => event.requestId === "stop-late-steer");
      } else {
        turn.release.resolve();
        await h.waitFor("session.turn", (event) => event.state === "completed");
        await h.waitFor("session.persistence");
      }
      assert.equal(h.steerCalls[0].options?.signal?.aborted, true);
      ack.resolve();
      await h.rejectedSteer("late-steer", /turn ended/);
      assert.equal(h.events.filter((event) => event.type === "timeline.item" && event.item.type === "user_message" && event.item.clientMessageId === "late-steer").length, 1, "An attempted native update remains visible even when its late acknowledgment cannot count as successful steering");
      assert.equal(h.terminalTurns().length, 1);
      assert.equal(h.natives[0].streamCalls, 1);
      assert.equal(h.natives[0].interruptCalls, interrupted ? 1 : 0);
    } finally { ack.resolve(); turn.release.resolve(); await h.cleanup(); }
  }
});

test("interrupt during steering preparation cancels it and queued updates before either reaches Droid", async () => {
  const turn = heldTurn();
  const preparing = deferred<void>();
  const prepared = deferred<PreparedPrompt>();
  const preparedIds: string[] = [];
  const h = await setup(turn.script, {
    prepare: async (request, options) => {
      preparedIds.push(request.clientMessageId);
      if (request.clientMessageId !== "preparing-steer") return preparePrompt(request, options);
      preparing.resolve();
      return prepared.promise;
    },
  });
  try {
    await h.open();
    await h.prompt();
    await turn.started.promise;
    await h.sendPrompt("preparing-steer", [{ type: "text", text: "Slow attachment preparation" }], "steer");
    await preparing.promise;
    await h.sendPrompt("queued-steer", [{ type: "text", text: "Must not overtake" }], "steer");
    await h.connection.send({ type: "session.interrupt", requestId: "stop-preparing-steer", sessionId: "session" });
    await h.waitFor("request.completed", (event) => event.requestId === "stop-preparing-steer");
    prepared.resolve({ text: "canceled input", timelineText: "canceled marker", options: {} });
    for (const id of ["preparing-steer", "queued-steer"]) {
      await h.rejectedSteer(id);
      assert.equal(h.events.filter((event) => event.type === "timeline.item" && event.item.type === "user_message" && event.item.clientMessageId === id).length, 0);
    }
    assert.deepEqual(preparedIds, ["message-1", "preparing-steer"], "Canceled queued steering must be rejected before loading its attachments");
    assert.equal(h.steerCalls.length, 0);
    assert.equal(h.natives[0].streamCalls, 1);
    assert.equal(h.natives[0].interruptCalls, 1);
    assert.equal(h.terminalTurns().length, 1);
  } finally { prepared.resolve({ text: "cleanup", timelineText: "cleanup", options: {} }); turn.release.resolve(); await h.cleanup(); }
});

test("an unsupported steering image is rejected without disturbing the active text turn", async () => {
  const turn = heldTurn();
  const h = await setup(turn.script, { noImageSupport: true });
  try {
    await h.open();
    await h.prompt();
    await turn.started.promise;
    await h.sendPrompt("unsupported-steer-image", [picture], "steer");
    await h.rejectedSteer("unsupported-steer-image", /does not accept images/);
    assert.equal(h.steerCalls.length, 0);
    assert.equal(h.natives[0].streamCalls, 1);
    assert.equal(h.natives[0].interruptCalls, 0);
    assert.equal(h.terminalTurns().length, 0);
    await h.sendPrompt("text-steer-after-image", [{ type: "text", text: "Continue using text" }], "steer");
    const accepted = await h.waitFor("session.prompt_result", (event) => event.clientMessageId === "text-steer-after-image");
    assert.equal(accepted.result.type, "steer");
    assert.equal(h.steerCalls.length, 1);
  } finally { turn.release.resolve(); await h.cleanup(); }
});

function questionTurn() {
  const answers: AskUserResult[] = [];
  const script: Script = async function* (native, text) {
    const answer = await native.options.askUserHandler(AskUserRequestParamsSchema.parse({
      toolCallId: `question:${text}`,
      questions: [{ index: 0, topic: "Direction", question: "Which direction should I take?", options: ["Proceed", "Review"] }],
    }));
    answers.push(answer);
    if (answer.cancelled) {
      // Droid treats AskUser's cancelled sentinel as a canceled agent loop,
      // even when an additional user update was already queued.
      yield result(false);
      return;
    }
    yield { type: "assistant_text_delta", messageId: `question-answer:${text}`, blockIndex: 0, text: "Continuing the original turn" };
    yield result();
  };
  return { script, answers };
}

test("acknowledged composer steering answers pending AskUser with the new instruction and preserves the native loop", async () => {
  const turn = questionTurn();
  const ack = deferred<void>();
  const h = await setup(turn.script, { steer: async () => ack.promise });
  try {
    await h.open();
    await h.prompt();
    const question = await h.waitFor("session.permission", (event) => event.request.kind === "question");
    const original = await h.waitFor("session.prompt_result", (event) => event.clientMessageId === "message-1");
    assert.equal(original.result.type, "turn");
    if (original.result.type !== "turn") throw new Error("Expected an original turn");
    await h.sendPrompt("answer-with-steer", [{ type: "text", text: "Use this new direction instead" }], "steer", "session", true);
    await h.steerStarted.promise;
    assert.equal(turn.answers.length, 0, "The existing question remains pending until Droid acknowledges steering");
    assert.equal(h.events.filter((event) => event.type === "session.permission_resolved").length, 0);
    ack.resolve();
    const accepted = await h.waitFor("session.prompt_result", (event) => event.clientMessageId === "answer-with-steer");
    assert.deepEqual(accepted.result, { type: "steer", turnId: original.result.turnId });
    const completed = await h.waitFor("session.turn", (event) => event.state === "completed");
    assert.equal(completed.turnId, original.result.turnId);
    assert.deepEqual(turn.answers, [{ answers: [{ index: 0, question: "Which direction should I take?", answer: "Use this new direction instead" }] }]);
    assert.notEqual(turn.answers[0]?.cancelled, true, "Using the cancelled sentinel would abort Droid before it consumes the steering update");
    const resolved = h.events.findIndex((event) => event.type === "session.permission_resolved" && event.permissionId === question.request.id);
    const disposition = h.events.indexOf(accepted);
    const terminal = h.events.indexOf(completed);
    assert.ok(resolved >= 0 && resolved < disposition && disposition < terminal, "Answer the old card after native ACK and acknowledge steering before the original turn finishes");
    assert.equal(h.events.filter((event) => event.type === "session.permission_resolved" && event.permissionId === question.request.id).length, 1);
    assert.equal(h.terminalTurns().length, 1);
    assert.equal(h.natives[0].streamCalls, 1);
    assert.equal(h.natives[0].interruptCalls, 0);
  } finally { ack.resolve(); await h.cleanup(); }
});

test("a rejected steering update retains the pending AskUser even when clearing was requested", async () => {
  const turn = questionTurn();
  const ack = deferred<void>();
  const h = await setup(turn.script, { steer: async () => ack.promise });
  try {
    await h.open();
    await h.prompt();
    const question = await h.waitFor("session.permission", (event) => event.request.kind === "question");
    await h.sendPrompt("failed-clearing-steer", [{ type: "text", text: "Supersede the question" }], "steer", "session", true);
    await h.steerStarted.promise;
    assert.equal(h.events.filter((event) => event.type === "timeline.item" && event.item.type === "user_message" && event.item.clientMessageId === "failed-clearing-steer").length, 0,
      "An update awaiting acknowledgment is not a sent user row");
    ack.reject(new SteeringRejectedError(-32602));
    await h.rejectedSteer("failed-clearing-steer", /Droid rejected steering/);
    assert.equal(turn.answers.length, 0);
    assert.equal(h.events.filter((event) => event.type === "session.permission_resolved").length, 0);
    assert.equal(h.terminalTurns().length, 0);
    await h.connection.send({ type: "session.permission", sessionId: "session", permissionId: question.request.id,
      response: { behavior: "allow", updatedInput: { answers: { Direction: "Review" } } } });
    await h.waitFor("session.turn", (event) => event.state === "completed");
    const saved = await h.waitFor("session.persistence");
    assert.ok(!JSON.stringify(await h.snapshotStore.load(saved.persistence)).includes("Supersede the question"), "A definitively rejected message must not be persisted as delivered or uncertain");
    assert.equal(h.events.filter((event) => event.type === "timeline.item" && event.item.type === "user_message" && event.item.clientMessageId === "failed-clearing-steer").length, 0);
    assert.equal(turn.answers[0]?.answers[0]?.answer, "Review", "The original card must remain answerable after steering fails");
    assert.notEqual(turn.answers[0]?.cancelled, true);
    assert.equal(h.events.filter((event) => event.type === "session.prompt_result" && event.clientMessageId === "failed-clearing-steer").length, 0);
    assert.equal(h.natives[0].streamCalls, 1);
    assert.equal(h.natives[0].interruptCalls, 0);
  } finally { ack.resolve(); await h.cleanup(); }
});

test("normal steering without clearPendingPermissions retains an independently pending question", async () => {
  const turn = questionTurn();
  const h = await setup(turn.script);
  try {
    await h.open();
    await h.prompt();
    const question = await h.waitFor("session.permission", (event) => event.request.kind === "question");
    await h.sendPrompt("non-clearing-steer", [{ type: "text", text: "Additional context; keep the question" }], "steer");
    const accepted = await h.waitFor("session.prompt_result", (event) => event.clientMessageId === "non-clearing-steer");
    assert.equal(accepted.result.type, "steer");
    assert.equal(turn.answers.length, 0);
    assert.equal(h.events.filter((event) => event.type === "session.permission_resolved").length, 0);
    assert.equal(h.terminalTurns().length, 0);
    await h.connection.send({ type: "session.permission", sessionId: "session", permissionId: question.request.id,
      response: { behavior: "allow", updatedInput: { answers: { Direction: "Proceed" } } } });
    await h.waitFor("session.turn", (event) => event.state === "completed");
    assert.equal(turn.answers[0]?.answers[0]?.answer, "Proceed");
    assert.notEqual(turn.answers[0]?.cancelled, true);
    assert.equal(h.natives[0].streamCalls, 1);
    assert.equal(h.natives[0].interruptCalls, 0);
  } finally { await h.cleanup(); }
});

test("an old steering ACK cannot clear a question created by a replacement turn", async () => {
  const finishFirst = deferred<void>();
  const ack = deferred<void>();
  let calls = 0;
  const script: Script = async function* (native) {
    const question = native.options.askUserHandler(AskUserRequestParamsSchema.parse({
      toolCallId: `question:${++calls}`,
      questions: [{ index: 0, topic: "Direction", question: `Question for turn ${calls}`, options: ["Proceed"] }],
    }));
    if (calls === 1) await Promise.race([question, finishFirst.promise]);
    else await question;
    yield result();
  };
  const h = await setup(script, { steer: async () => ack.promise });
  try {
    await h.open();
    await h.prompt();
    const originalQuestion = await h.waitFor("session.permission");
    await h.sendPrompt("old-clearing-steer", [{ type: "text", text: "Original turn update" }], "steer", "session", true);
    await h.steerStarted.promise;
    finishFirst.resolve();
    await h.waitFor("session.persistence");
    await h.waitFor("session.turn", (event) => event.state === "completed");
    const after = h.events.length;
    await h.prompt("replacement-turn");
    const replacementQuestion = await h.waitFor("session.permission", () => true, after);
    assert.notEqual(replacementQuestion.request.id, originalQuestion.request.id);
    ack.resolve();
    await h.rejectedSteer("old-clearing-steer", /turn ended/);
    assert.equal(h.events.filter((event) => event.type === "session.permission_resolved" && event.permissionId === replacementQuestion.request.id).length, 0, "Late old ACK must not cancel a question belonging to the newer active turn");
    await h.connection.send({ type: "session.permission", sessionId: "session", permissionId: replacementQuestion.request.id,
      response: { behavior: "allow", updatedInput: { answers: { Direction: "Proceed" } } } });
    await h.waitFor("session.turn", (event) => event.state === "completed", after);
    assert.equal(h.terminalTurns().length, 2);
    assert.equal(h.natives[0].streamCalls, 2);
    assert.equal(h.natives[0].interruptCalls, 0);
  } finally { finishFirst.resolve(); ack.resolve(); await h.cleanup(); }
});

function requestToolApproval(native: FakeNative, id: string) {
  return native.options.permissionHandler(RequestPermissionRequestParamsSchema.parse({
    toolUses: [{
      toolUse: { type: "tool_use", id, name: "Execute", input: { command: "printf approval" } },
      confirmationType: ToolConfirmationType.Execute,
      details: { type: ToolConfirmationType.Execute, command: "printf", fullCommand: "printf approval" },
    }],
    options: [
      { label: "Run once", value: ToolConfirmationOutcome.ProceedOnce },
      { label: "Cancel", value: ToolConfirmationOutcome.Cancel },
    ],
  }));
}

test("composer steering rejects an already pending tool approval without forwarding or recording the update", async () => {
  const h = await setup(needsPermission);
  try {
    await h.open();
    await h.prompt();
    const tool = await h.waitFor("session.permission", (event) => event.request.kind === "tool");
    await h.sendPrompt("steer-past-tool", [{ type: "text", text: "Change direction instead" }], "steer", "session", true);
    await h.rejectedSteer("steer-past-tool", /pending Droid tool approval/);
    assert.equal(h.steerCalls.length, 0);
    assert.equal(h.events.filter((event) => event.type === "timeline.item" && event.item.type === "user_message" && event.item.clientMessageId === "steer-past-tool").length, 0);
    assert.equal(h.events.filter((event) => event.type === "session.permission_resolved").length, 0);
    assert.equal(h.terminalTurns().length, 0, "Refusing unsafe admission must leave the existing native loop and approval intact");
    await h.connection.send({ type: "session.permission", sessionId: "session", permissionId: tool.request.id,
      response: { behavior: "allow", selectedActionId: ToolConfirmationOutcome.ProceedOnce } });
    await h.waitFor("session.turn", (event) => event.state === "completed");
    assert.equal(h.natives[0].streamCalls, 1);
    assert.equal(h.natives[0].interruptCalls, 0);
  } finally { await h.cleanup(); }
});

test("a tool approval arriving during attachment preparation blocks steering before the native send", async () => {
  const turn = heldTurn();
  const preparing = deferred<void>();
  const prepared = deferred<PreparedPrompt>();
  const h = await setup(turn.script, {
    prepare: async (request, options) => {
      if (request.clientMessageId !== "preparing-before-tool") return preparePrompt(request, options);
      preparing.resolve();
      return prepared.promise;
    },
  });
  try {
    await h.open();
    await h.prompt();
    await turn.started.promise;
    await h.sendPrompt("preparing-before-tool", [{ type: "text", text: "Preparation is still in flight" }], "steer", "session", true);
    await preparing.promise;
    const nativeAnswer = requestToolApproval(h.natives[0], "during-preparation");
    const tool = await h.waitFor("session.permission", (event) => event.request.kind === "tool");
    prepared.resolve({ text: "prepared update", timelineText: "prepared marker", options: {} });
    await h.rejectedSteer("preparing-before-tool", /pending Droid tool approval/);
    assert.equal(h.steerCalls.length, 0);
    assert.equal(h.events.filter((event) => event.type === "timeline.item" && event.item.type === "user_message" && event.item.clientMessageId === "preparing-before-tool").length, 0);
    assert.equal(h.events.filter((event) => event.type === "session.permission_resolved").length, 0);
    await h.connection.send({ type: "session.permission", sessionId: "session", permissionId: tool.request.id,
      response: { behavior: "allow", selectedActionId: ToolConfirmationOutcome.ProceedOnce } });
    assert.equal(await nativeAnswer, ToolConfirmationOutcome.ProceedOnce);
    turn.release.resolve();
    await h.waitFor("session.turn", (event) => event.state === "completed");
    assert.equal(h.natives[0].interruptCalls, 0);
  } finally { prepared.resolve({ text: "cleanup", timelineText: "cleanup", options: {} }); turn.release.resolve(); await h.cleanup(); }
});

test("a tool approval arriving during steering ACK stays pending with an explicit queued-update notice", async () => {
  const turn = heldTurn();
  const ack = deferred<void>();
  const h = await setup(turn.script, { steer: async () => ack.promise });
  try {
    await h.open();
    await h.prompt();
    await turn.started.promise;
    const original = await h.waitFor("session.prompt_result", (event) => event.clientMessageId === "message-1");
    assert.equal(original.result.type, "turn");
    if (original.result.type !== "turn") throw new Error("Expected an original turn");
    await h.sendPrompt("tool-during-ack", [{ type: "text", text: "Keep this update queued" }], "steer", "session", true);
    await h.steerStarted.promise;
    let nativeSettled = false;
    const nativeAnswer = requestToolApproval(h.natives[0], "during-ack");
    void Promise.resolve(nativeAnswer).then(() => { nativeSettled = true; });
    const tool = await h.waitFor("session.permission", (event) => event.request.kind === "tool");
    ack.resolve();
    const accepted = await h.waitFor("session.prompt_result", (event) => event.clientMessageId === "tool-during-ack");
    assert.deepEqual(accepted.result, { type: "steer", turnId: original.result.turnId });
    const notice = await h.waitFor("session.notice", (event) => event.notice.id === "droid-steer-tool-approval:tool-during-ack");
    assert.match(notice.notice.description ?? "", /update was queued/);
    assert.match(notice.notice.title, /tool approval/);
    assert.equal(nativeSettled, false, "A tool approval must never be implicitly denied or approved to release steering");
    assert.equal(h.events.filter((event) => event.type === "session.permission_resolved" && event.permissionId === tool.request.id).length, 0);
    assert.equal(h.terminalTurns().length, 0);
    await h.connection.send({ type: "session.permission", sessionId: "session", permissionId: tool.request.id,
      response: { behavior: "allow", selectedActionId: ToolConfirmationOutcome.ProceedOnce } });
    assert.equal(await nativeAnswer, ToolConfirmationOutcome.ProceedOnce);
    turn.release.resolve();
    await h.waitFor("session.turn", (event) => event.state === "completed");
    assert.equal(h.steerCalls.length, 1);
    assert.equal(h.natives[0].streamCalls, 1);
    assert.equal(h.natives[0].interruptCalls, 0);
  } finally { ack.resolve(); turn.release.resolve(); await h.cleanup(); }
});

test("invalid steering attachments reject acceptance and leave the original turn available for a valid update", async () => {
  const turn = heldTurn();
  const h = await setup(turn.script);
  try {
    await h.open();
    await h.prompt();
    await turn.started.promise;
    for (const [index, attachment] of [
      { type: "image", mimeType: "image/png", data: "%%%invalid-base64%%%" },
      { type: "uploaded_file", id: "missing-steer", fileName: "missing.txt", mimeType: "text/plain", size: 1, path: `/tmp/droid-provider-missing-${process.pid}/steer.txt` },
    ].entries()) {
      const id = `invalid-steer-${index}`;
      await h.sendPrompt(id, [attachment as ProviderContent], "steer");
      await h.rejectedSteer(id, /Attachment/);
      assert.equal(h.events.filter((event) => event.type === "timeline.item" && event.item.type === "user_message" && event.item.clientMessageId === id).length, 0);
    }
    assert.equal(h.steerCalls.length, 0);
    assert.equal(h.terminalTurns().length, 0);
    assert.equal(h.natives[0].streamCalls, 1);
    assert.equal(h.natives[0].interruptCalls, 0);
    await h.sendPrompt("valid-steer-after-invalid", [{ type: "text", text: "Continue the original task" }], "steer");
    await h.sent("valid-steer-after-invalid");
    assert.equal(h.steerCalls.length, 1);
    assert.equal(h.natives[0].streamCalls, 1);
  } finally { turn.release.resolve(); await h.cleanup(); }
});

test("session close remains independent of an awaiting steering acceptance promise", async () => {
  const turn = heldTurn();
  const ack = deferred<void>();
  const h = await setup(turn.script, { steer: async () => ack.promise });
  try {
    await h.open();
    await h.prompt();
    await turn.started.promise;
    await h.sendPrompt("steer-before-close", [{ type: "text", text: "Pending acknowledgment" }], "steer");
    await h.steerStarted.promise;
    await h.connection.send({ type: "session.close", requestId: "close-during-steer", sessionId: "session" });
    await h.waitFor("request.completed", (event) => event.requestId === "close-during-steer");
    assert.equal(h.terminalTurns().length, 1);
    assert.equal(h.steerCalls[0].options?.signal?.aborted, true);
    ack.resolve();
    await h.rejectedSteer("steer-before-close", /turn ended/);
    assert.equal(h.natives[0].streamCalls, 1);
  } finally { ack.resolve(); turn.release.resolve(); await h.cleanup(); }
});

test("rejected settings preserve the connection for another prompt and a corrected setting", async () => {
  const h = await setup();
  try {
    await h.open();
    const native = h.natives[0];
    const update = native.updateSettings.bind(native);
    let rejectNext = true;
    native.updateSettings = async (changes) => {
      if (rejectNext) { rejectNext = false; throw new Error("Model setting rejected"); }
      await update(changes);
    };
    await h.connection.send({ type: "session.configure", requestId: "rejected-setting", sessionId: "session", changes: { model: "disabled-model" } });
    await h.waitFor("request.failed", (event) => event.requestId === "rejected-setting");
    assert.equal(h.transports.at(-1)?.isConnected, true);
    assert.equal(h.transports.at(-1)?.closeCalls, 0);
    assert.equal(h.events.filter((event) => event.type === "session.runtime_failed").length, 0);
    await h.prompt("after-rejected-setting");
    await h.waitFor("session.turn", (event) => event.state === "completed");
    await h.connection.send({ type: "session.configure", requestId: "corrected-setting", sessionId: "session", changes: { mode: "auto-low" } });
    await h.waitFor("request.completed", (event) => event.requestId === "corrected-setting");
    assert.equal(native.settings.autonomyLevel, AutonomyLevel.Low);
    assert.equal(native.streamCalls, 1);
    assert.equal(h.transports.at(-1)?.isConnected, true);
  } finally { await h.cleanup(); }
});

test("an uncertain steering ACK is persisted as a warning rather than a sent message", async () => {
  const turn = heldTurn();
  const h = await setup(turn.script, { steer: async () => { throw new Error("Acknowledgment unavailable"); } });
  try {
    await h.open();
    await h.prompt();
    await turn.started.promise;
    await h.sendPrompt("uncertain-steer", [{ type: "text", text: "Potentially delivered requirement" }], "steer");
    await h.rejectedSteer("uncertain-steer", /Acknowledgment unavailable/);
    const notice = h.events.find((event) => event.type === "timeline.item" && event.item.type === "notification" && event.item.id === "paseo:steer-unconfirmed:uncertain-steer");
    assert.ok(notice);
    assert.equal(h.events.filter((event) => event.type === "timeline.item" && event.item.type === "user_message" && event.item.clientMessageId === "uncertain-steer").length, 0);
    const saved = await h.waitFor("session.persistence");
    assert.match(JSON.stringify(await h.snapshotStore.load(saved.persistence)), /Delivery is unconfirmed/);
    assert.equal(h.natives[0].interruptCalls, 0);
  } finally { turn.release.resolve(); await h.cleanup(); }
});

test("a quiet stream flushes buffered text while active and ends with one final snapshot", async () => {
  const gate = deferred<void>();
  const h = await setup(async function* () {
    yield { type: "assistant_text_delta", messageId: "quiet", blockIndex: 0, text: "Visible before completion" } as DroidMessage;
    await gate.promise;
    yield { type: "assistant_text_delta", messageId: "quiet", blockIndex: 0, text: "; final tail" } as DroidMessage;
    yield result();
  });
  try {
    await h.open();
    await h.prompt();
    const streamed = await h.waitFor("timeline.item", (event) => event.item.type === "assistant_message");
    assert.equal((streamed.item as { text: string }).text, "Visible before completion");
    assert.equal(h.terminalTurns().length, 0);
    gate.resolve();
    const saved = await h.waitFor("session.persistence");
    const items = (await h.snapshotStore.load(saved.persistence)).items;
    assert.equal(items.find((item) => item.type === "assistant_message")?.text, "Visible before completion; final tail");
    const terminal = await h.waitFor("session.turn", (event) => event.state === "completed");
    assert.ok(h.events.indexOf(saved) < h.events.indexOf(terminal), "Persist the complete snapshot before the host captures a terminal session handle");
  } finally { gate.resolve(); await h.cleanup(); }
});

test("closing a buffered stream cancels its presentation timer", async () => {
  const started = deferred<void>();
  const h = await setup(async function* (native) {
    yield { type: "assistant_text_delta", messageId: "close-buffer", blockIndex: 0, text: "Pending text" } as DroidMessage;
    started.resolve();
    await new Promise<void>((resolve) => native.onShutdown.add(resolve));
    yield result(false);
  });
  try {
    await h.open();
    await h.prompt();
    await started.promise;
    await h.connection.send({ type: "session.close", requestId: "close-buffer", sessionId: "session" });
    await h.waitFor("request.completed", (event) => event.requestId === "close-buffer");
    const after = h.events.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 70));
    assert.equal(h.events.slice(after).filter((event) => event.type === "timeline.item").length, 0);
  } finally { await h.cleanup(); }
});

test("a timed-out settings update invalidates the closed session instead of accepting more work", async () => {
  const pending = deferred<void>();
  const h = await setup(successful, { settingsTimeoutMs: 10 });
  try {
    await h.open();
    h.natives[0].updateSettings = async () => pending.promise;
    await h.connection.send({ type: "session.configure", requestId: "stalled-settings", sessionId: "session", changes: { mode: "auto-low" } });
    await h.waitFor("session.runtime_failed");
    await h.waitFor("request.failed", (event) => event.requestId === "stalled-settings");
    assert.equal(h.transports.at(-1)?.isConnected, false);
    await h.prompt("after-settings-timeout");
    const rejected = await h.waitFor("session.prompt_result", (event) => event.clientMessageId === "after-settings-timeout");
    assert.equal(rejected.result.type, "failed");
    assert.equal(h.natives[0].streamCalls, 0);
  } finally { pending.resolve(); await h.cleanup(); }
});

test("withdrawn text is cleared in persistence and is not republished on provider restore", async () => {
  const gate = deferred<void>();
  const withdrawn = "withdrawn-private-answer-sentinel";
  const h = await setup(async function* () {
    yield { type: "assistant_text_delta", messageId: "withdrawn-answer", blockIndex: 0, text: withdrawn } as DroidMessage;
    await gate.promise;
    yield { type: "assistant_message_retracted", messageId: "withdrawn-answer" } as DroidMessage;
    yield result();
  });
  try {
    await h.open();
    await h.prompt();
    await h.waitFor("timeline.item", (event) => event.item.type === "assistant_message" && event.item.text === withdrawn);
    gate.resolve();
    const saved = await h.waitFor("session.persistence");
    assert.equal(JSON.stringify(await h.snapshotStore.load(saved.persistence)).includes(withdrawn), false);
    const notice = h.events.find((event) => event.type === "timeline.item" && event.item.type === "notification" && event.item.id === "droid:retracted:withdrawn-answer");
    assert.ok(notice, "Warn explicitly because Paseo 0.11.4 ignores empty text snapshots");
    await h.connection.send({ type: "session.close", requestId: "close-withdrawn", sessionId: "session" });
    await h.waitFor("request.completed", (event) => event.requestId === "close-withdrawn");
    const after = h.events.length;
    await h.open("restored-withdrawn", saved.persistence);
    const replay = h.events.slice(after).filter((event) => event.type === "timeline.item");
    assert.equal(JSON.stringify(replay).includes(withdrawn), false);
    assert.ok(replay.some((event) => event.type === "timeline.item" && event.item.type === "assistant_message" && event.item.text === ""));
    assert.equal(h.natives[1].streamCalls, 0);
  } finally { gate.resolve(); await h.cleanup(); }
});

function backgroundStart(native: FakeNative, id = "execute-completion:background-test") {
  native.notify({ type: "create_message", message: {
    id, role: "user", visibility: "llm_only", content: [{ type: "text", text: "Background command finished" }], createdAt: 0, updatedAt: 0,
  } });
  native.notify({ type: "droid_working_state_changed", newState: "thinking" });
}
function backgroundComplete(native: FakeNative, id = "execute-completion:background-test", reason = "completed") {
  native.notify({ type: "agent_turn_completed", turnId: id, reason,
    tokenUsage: { inputTokens: 123, outputTokens: 45, cacheReadTokens: 100, cacheCreationTokens: 0, thinkingTokens: 5 } });
}

test("a background wakeup delivers 39 tool calls, Tasks and its full report without another prompt", async () => {
  const h = await setup();
  try {
    await h.open(); await h.prompt();
    await h.waitFor("session.turn", (e) => e.state === "completed");
    const after = h.events.length;
    const native = h.natives[0];
    backgroundStart(native);
    for (let i = 0; i < 39; i++) {
      native.notify({ type: "tool_call", toolUse: { type: "tool_use", id: `background-tool:${i}`, name: i === 0 ? "TodoWrite" : "Read",
        input: i === 0 ? { todos: "1. [completed] Review captured results" } : { file_path: `/test/result-${i}.txt` } } });
      native.notify({ type: "tool_result", messageId: `tool-message:${i}`, toolUseId: `background-tool:${i}`, content: "Done", isError: false });
    }
    native.notify({ type: "assistant_text_delta", messageId: "background-report", blockIndex: 0, textDelta: "The complete " });
    native.notify({ type: "assistant_text_delta", messageId: "background-report", blockIndex: 0, textDelta: "background review." });
    native.notify({ type: "create_message", message: { id: "background-report", role: "assistant", content: [{ type: "text", text: "The complete background review." }], createdAt: 0, updatedAt: 0 } });
    backgroundComplete(native);
    backgroundComplete(native);
    await h.waitFor("session.turn", (e) => e.state === "completed", after);
    const started = h.events.slice(after).filter((e) => e.type === "session.turn" && e.state === "started");
    assert.equal(started.length, 1);
    assert.equal(h.terminalTurns().length, 2, "Duplicate native completion must not manufacture another turn");
    assert.equal(native.streamCalls, 1);
    assert.equal(h.events.slice(after).filter((e) => e.type === "session.prompt_result").length, 0);
    assert.equal(h.events.slice(after).filter((e) => e.type === "timeline.item" && e.item.type === "user_message").length, 0);
    const saved = await h.waitFor("session.persistence", () => true, after);
    const snapshot = await h.snapshotStore.load(saved.persistence);
    assert.equal(snapshot.items.filter((i) => i.type === "tool_call" && i.callId.startsWith("background-tool:")).length, 39);
    assert.equal(snapshot.items.find((i) => i.id === "droid:todo")?.type, "todo");
    assert.equal(snapshot.items.filter((i) => i.type === "assistant_message" && i.text === "The complete background review.").length, 1);
    assert.ok(h.events.indexOf(saved) < h.events.findIndex((e, i) => i >= after && e.type === "session.turn" && e.state === "completed"));
  } finally { await h.cleanup(); }
});

test("unrelated and duplicate native completions cannot finish a foreground turn", async () => {
  const held = heldTurn();
  const h = await setup(held.script);
  try {
    await h.open(); await h.prompt(); await held.started.promise;
    backgroundComplete(h.natives[0], "unrelated-native-turn");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.terminalTurns().length, 0);
    held.release.resolve();
    await h.waitFor("session.turn", (e) => e.state === "completed");
    backgroundComplete(h.natives[0], h.natives[0].nativeTurnIds[0]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.terminalTurns().length, 1);
  } finally { held.release.resolve(); await h.cleanup(); }
});

test("background approvals and steering keep one native turn and preserve pending cards", async () => {
  const h = await setup();
  try {
    await h.open();
    backgroundStart(h.natives[0]);
    await h.waitFor("session.turn", (e) => e.state === "started");
    const answer = requestToolApproval(h.natives[0], "background-approval");
    const permission = await h.waitFor("session.permission");
    await h.sendPrompt("background-steer", [{ type: "text", text: "Use the updated requirement" }], "steer");
    await h.sent("background-steer");
    const accepted = await h.waitFor("session.prompt_result");
    assert.equal(accepted.result.type, "steer");
    assert.equal(h.events.filter((e) => e.type === "session.permission_resolved").length, 0);
    await h.connection.send({ type: "session.permission", sessionId: "session", permissionId: permission.request.id,
      response: { behavior: "allow", selectedActionId: ToolConfirmationOutcome.ProceedOnce } });
    assert.equal(await answer, ToolConfirmationOutcome.ProceedOnce);
    backgroundComplete(h.natives[0]);
    await h.waitFor("session.turn", (e) => e.state === "completed");
    assert.equal(h.natives[0].streamCalls, 0);
    assert.equal(h.steerCalls.length, 1);
    assert.equal(h.terminalTurns().length, 1);
  } finally { await h.cleanup(); }
});

test("Stop cancels an autonomous AskUser turn and closing removes its observer", async () => {
  const h = await setup();
  try {
    await h.open(); backgroundStart(h.natives[0]);
    await h.waitFor("session.turn", (e) => e.state === "started");
    const question = h.natives[0].options.askUserHandler(AskUserRequestParamsSchema.parse({ toolCallId: "background-question",
      questions: [{ index: 0, topic: "Next step", question: "Continue?", options: ["Yes"] }] }));
    await h.waitFor("session.permission");
    await h.connection.send({ type: "session.interrupt", requestId: "stop-background", sessionId: "session" });
    await h.waitFor("request.completed", (e) => e.requestId === "stop-background");
    await question;
    assert.equal(h.terminalTurns().length, 1);
    assert.equal((h.terminalTurns()[0] as Extract<ProviderEvent, { type: "session.turn" }>).state, "canceled");
    const captured = [...h.natives[0].notifications];
    await h.connection.send({ type: "session.close", requestId: "close-background", sessionId: "session" });
    await h.waitFor("request.completed", (e) => e.requestId === "close-background");
    assert.equal(h.natives[0].notifications.size, 0);
    const after = h.events.length;
    for (const callback of captured) callback({ params: { notification: { type: "assistant_text_delta", messageId: "late", blockIndex: 0, textDelta: "Must stay closed" } } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.events.length, after);
    assert.equal(h.natives[0].streamCalls, 0);
  } finally { await h.cleanup(); }
});

test("an idle/background transport failure fails its turn once and removes the observer", async () => {
  const h = await setup();
  try {
    await h.open(); backgroundStart(h.natives[0]);
    await h.waitFor("session.turn", (e) => e.state === "started");
    h.natives[0].notify({ type: "tool_call", toolUse: { type: "tool_use", id: "failed-background-read", name: "Read", input: { file_path: "/test/file.txt" } } });
    await h.transports.at(-1)!.close();
    await h.waitFor("session.runtime_failed");
    assert.equal(h.terminalTurns().length, 1);
    assert.equal((h.terminalTurns()[0] as Extract<ProviderEvent, { type: "session.turn" }>).state, "failed");
    assert.equal(h.natives[0].notifications.size, 0);
    await h.prompt("after-background-failure");
    const refused = await h.waitFor("session.prompt_result");
    assert.equal(refused.result.type, "failed");
    assert.equal(h.natives[0].streamCalls, 0);
  } finally { await h.cleanup(); }
});

test("checkpoint write failures retain the prior handle, warn once, complete the turn and recover", async () => {
  const directory = await mkdtemp(join(tmpdir(), "droid-provider-disk-failure-"));
  const store = new FileSnapshotStore(directory);
  let fail = false;
  const h = await setup(successful, { snapshotStore: {
    load: (value) => store.load(value),
    save: async (value, previous) => { if (fail) throw Object.assign(new Error("Disk full"), { code: "ENOSPC" }); return store.save(value, previous); },
  } });
  try {
    await h.open();
    const opened = await h.waitFor("session.opened");
    assert.ok(opened.persistence);
    fail = true;
    await h.prompt();
    await h.waitFor("session.turn", (e) => e.state === "completed");
    assert.equal(h.events.filter((e) => e.type === "session.persistence").length, 0);
    assert.equal(h.events.filter((e) => e.type === "session.notice" && e.notice.id === "droid-persistence-write-failed").length, 1);
    assert.deepEqual((await store.load(opened.persistence)).items, []);
    fail = false;
    const after = h.events.length;
    await h.prompt("recovered-disk");
    await h.waitFor("session.turn", (e) => e.state === "completed", after);
    const saved = await h.waitFor("session.persistence", () => true, after);
    assert.equal((await store.load(saved.persistence)).items.length, 4);
    assert.equal(h.natives[0].notifications.size, 1);
  } finally { await h.cleanup(); await rm(directory, { recursive: true, force: true }); }
});

test("foreground completion, background wakeup and a racing prompt retain lifecycle order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "droid-handoff-"));
  const store = new FileSnapshotStore(directory);
  const saving = deferred<void>(); const release = deferred<void>();
  let saves = 0;
  const h = await setup(successful, { snapshotStore: { load: (value) => store.load(value), save: async (value, previous) => {
    if (++saves === 2) { saving.resolve(); await release.promise; }
    return store.save(value, previous);
  } } });
  try {
    await h.open(); await h.prompt(); await saving.promise;
    const foreground = h.events.find((e) => e.type === "session.turn" && e.state === "started")!;
    backgroundStart(h.natives[0]);
    await h.prompt("handoff-race");
    release.resolve();
    const refused = await h.waitFor("session.prompt_result", (e) => e.clientMessageId === "handoff-race");
    assert.equal(refused.result.type, "failed");
    assert.equal(h.natives[0].streamCalls, 1);
    const turns = h.events.filter((e): e is Extract<ProviderEvent, { type: "session.turn" }> => e.type === "session.turn");
    assert.deepEqual(turns.map((e) => e.state), ["started", "completed", "started"]);
    assert.equal(turns[0], foreground);
    assert.equal(turns[0].turnId, turns[1].turnId);
    assert.notEqual(turns[1].turnId, turns[2].turnId);
    backgroundComplete(h.natives[0]);
    await h.waitFor("session.turn", (e) => e.turnId === turns[2].turnId && e.state === "completed");
  } finally { release.resolve(); await h.cleanup(); await rm(directory, { recursive: true, force: true }); }
});

test("a native background wakeup cancels prompt preparation without clearing background busy state", async () => {
  const preparing = deferred<void>(); const prepared = deferred<PreparedPrompt>();
  const h = await setup(successful, { prepare: async () => { preparing.resolve(); return prepared.promise; } });
  try {
    await h.open(); await h.prompt(); await preparing.promise;
    backgroundStart(h.natives[0]);
    await h.waitFor("session.turn", (e) => e.state === "started");
    prepared.resolve({ text: "Pending prompt", timelineText: "Pending prompt", options: {} });
    const refused = await h.waitFor("session.prompt_result");
    assert.equal(refused.result.type, "failed");
    await h.prompt("still-background-busy");
    const stillBusy = await h.waitFor("session.prompt_result", (e) => e.clientMessageId === "still-background-busy");
    assert.equal(stillBusy.result.type, "failed");
    assert.equal(h.natives[0].streamCalls, 0);
    assert.equal(h.terminalTurns().length, 0);
    backgroundComplete(h.natives[0]);
    await h.waitFor("session.turn", (e) => e.state === "completed");
  } finally { prepared.resolve({ text: "Cleanup", timelineText: "Cleanup", options: {} }); await h.cleanup(); }
});

test("legacy empty snapshots migrate without filling history and missing v2 state never creates a new native session", async () => {
  const h = await setup();
  try {
    await h.open("legacy", { version: 1, data: { nativeSessionId: nativeId, cwd, items: [] } });
    const opened = await h.waitFor("session.opened");
    assert.equal(opened.persistence?.version, 2);
    assert.deepEqual((await h.snapshotStore.load(opened.persistence!)).items, []);
    assert.equal(h.events.filter((e) => e.type === "timeline.item").length, 0);
    const before = h.natives.length;
    await h.connection.send({ type: "session.open", requestId: "missing-state", sessionId: "missing", history: "replay", config: h.config,
      persistence: { version: 2, data: { nativeSessionId: nativeId, cwd, snapshotKey: "0".repeat(64) } } });
    const rejected = await h.waitFor("request.failed", (e) => e.requestId === "missing-state");
    assert.match(rejected.error.message, /missing, damaged/);
    assert.equal(h.natives.length, before, "Do not silently create or resume a replacement native conversation");
    assert.equal(h.natives[0].streamCalls, 0);
  } finally { await h.cleanup(); }
});

test("native wakeups received while opening are published after ready and preserve restored Tasks", async () => {
  const h = await setup(successful, { afterSubscribe: (native) => {
    backgroundStart(native);
    native.notify({ type: "tool_call", toolUse: { type: "tool_use", id: "opening-todo", name: "TodoWrite", input: { todos: "1. [completed] New observed task" } } });
    native.notify({ type: "tool_result", messageId: "opening-result", toolUseId: "opening-todo", content: "Done", isError: false });
    backgroundComplete(native);
  } });
  try {
    await h.open("session", { version: 1, data: { nativeSessionId: nativeId, cwd, items: [
      { type: "todo", id: "droid:todo", items: [{ text: "Already saved old task", completed: false, status: "pending" }] },
    ] } });
    await h.waitFor("session.turn", (e) => e.state === "completed");
    const ready = h.events.findIndex((e) => e.type === "session.ready");
    const start = h.events.findIndex((e) => e.type === "session.turn" && e.state === "started");
    assert.ok(start > ready);
    const saved = await h.waitFor("session.persistence");
    const tasks = (await h.snapshotStore.load(saved.persistence)).items.find((i) => i.type === "todo");
    assert.ok(tasks?.type === "todo");
    assert.equal(tasks.items[0].text, "New observed task");
    assert.equal(h.natives[0].streamCalls, 0);
  } finally { await h.cleanup(); }
});

test("a prompt racing transport failure is refused before invoking the native stream", async () => {
  const h = await setup();
  try {
    await h.open();
    const failed = h.transports.at(-1)!.close();
    await h.prompt("failure-race");
    await failed;
    const rejected = await h.waitFor("session.prompt_result");
    assert.equal(rejected.result.type, "failed");
    assert.equal(h.natives[0].streamCalls, 0);
    assert.equal(h.terminalTurns().length, 0);
  } finally { await h.cleanup(); }
});

test("steering ACK during a delayed terminal checkpoint cannot falsely acknowledge active steering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "droid-finishing-steer-"));
  const store = new FileSnapshotStore(directory);
  const held = heldTurn(); const ack = deferred<void>(); const saving = deferred<void>(); const release = deferred<void>();
  let saves = 0;
  const h = await setup(held.script, { steer: async () => ack.promise, snapshotStore: {
    load: (value) => store.load(value), save: async (value, previous) => {
      if (++saves === 2) { saving.resolve(); await release.promise; }
      return store.save(value, previous);
    },
  } });
  try {
    await h.open(); await h.prompt(); await held.started.promise;
    await h.sendPrompt("finishing-steer", [{ type: "text", text: "An acknowledged native update" }], "steer");
    await h.steerStarted.promise;
    held.release.resolve(); await saving.promise;
    ack.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.events.filter((e) => e.type === "session.prompt_result" && e.clientMessageId === "finishing-steer").length, 0);
    release.resolve();
    await h.rejectedSteer("finishing-steer", /turn ended/);
    await h.waitFor("session.turn", (e) => e.state === "completed");
    assert.equal(h.terminalTurns().length, 1);
    assert.equal(h.natives[0].streamCalls, 1);
  } finally { held.release.resolve(); ack.resolve(); release.resolve(); await h.cleanup(); await rm(directory, { recursive: true, force: true }); }
});

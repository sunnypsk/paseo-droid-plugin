import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AutonomyLevel,
  ContextStatsAccuracy,
  AskUserRequestParamsSchema,
  DroidInteractionMode,
  RequestPermissionRequestParamsSchema,
  ToolConfirmationOutcome,
  ToolConfirmationType,
  type AskUserResult,
  type ClientAskUserHandler,
  type ClientPermissionHandler,
  type DroidSession,
  type MessageOptions,
  type GetContextStatsResult,
  type ModelInfo,
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
import type { SteeringOptions } from "./steering";

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
  onError() {}
  async close() {
    this.closeCalls++;
    if (!this.isConnected) return;
    this.isConnected = false;
    for (const callback of this.onClose) callback();
  }
}

type Script = (native: FakeNative, text: string) => AsyncGenerator<DroidMessage>;
type NativeOptions = { transport: StringFramedDroidClientTransport; permissionHandler: ClientPermissionHandler; askUserHandler: ClientAskUserHandler };

class FakeNative {
  readonly id = nativeId;
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
  constructor(readonly options: NativeOptions, private readonly script: Script, private readonly context?: (native: FakeNative) => Promise<GetContextStatsResult>) {
    options.transport.onError(() => { for (const callback of this.onShutdown) callback(); });
  }
  async *stream(text: string, options?: MessageOptions) {
    this.streamCalls++;
    this.streamInputs.push({ text, options });
    this.interrupted = false;
    yield* this.script(this, text);
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
  create?: ReturnType<typeof deferred<void>>;
  models?: ReturnType<typeof deferred<void>>;
  steer?: (text: string, options?: SteeringOptions) => Promise<void>;
  prepare?: typeof preparePrompt;
  noImageSupport?: boolean;
  context?: (native: FakeNative) => Promise<GetContextStatsResult>;
  contextTimeoutMs?: number;
  usageReplayDelaysMs?: readonly number[];
  catalog?: (call: number, env: Readonly<Record<string, string>>, cwd?: string) => Promise<ModelInfo[]>;
}

async function setup(script: Script = successful, gates: SetupOptions = {}) {
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
      const native = new FakeNative(options, script, gates.context);
      natives.push(native);
      return native as unknown as DroidSession;
    },
    async resumeSession(id: string, options: NativeOptions) {
      resumed.push(id);
      const native = new FakeNative(options, script, gates.context);
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
        reject(new Error(`Timed out waiting for ${type}; received ${events.map((event) => event.type).join(", ")}`));
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
    assert.deepEqual(invalid, [], "Every emitted event must satisfy the Paseo provider protocol");
  }
  return { connection, events, waitFor, config, open, prompt, sendPrompt, sent, rejectedSteer, terminalTurns, cleanup, transports, natives, resumed, createStarted, modelsStarted, steerCalls, steerStarted, steerCancellations, catalogCalls: () => catalogCalls };
}

function catalogModel(tokenMultiplier: number, id = "test-model"): ModelInfo {
  return { id, displayName: id === "test-model" ? "Test model" : id, supportedReasoningEfforts: [], disabled: false, tokenMultiplier } as unknown as ModelInfo;
}

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
    assert.equal(late.length, 3, "Replay must stop after the bounded startup deliveries");
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
    const snapshots = (saved.persistence.data as { items: unknown[] }).items;
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
    const rendered = JSON.stringify(persisted.persistence.data);
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
    ack.reject(new Error("Droid rejected the steering update"));
    await h.rejectedSteer("failed-clearing-steer", /Droid rejected the steering update/);
    assert.equal(turn.answers.length, 0);
    assert.equal(h.events.filter((event) => event.type === "session.permission_resolved").length, 0);
    assert.equal(h.terminalTurns().length, 0);
    await h.connection.send({ type: "session.permission", sessionId: "session", permissionId: question.request.id,
      response: { behavior: "allow", updatedInput: { answers: { Direction: "Review" } } } });
    await h.waitFor("session.turn", (event) => event.state === "completed");
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

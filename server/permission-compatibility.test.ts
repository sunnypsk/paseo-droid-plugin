import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  DroidClient,
  FACTORY_PROTOCOL_VERSION,
  LEGACY_FACTORY_API_VERSION,
  RequestPermissionRequestSchema,
  RequestPermissionResponseSchema,
  ToolConfirmationOutcome as Outcome,
  type RequestPermissionHandlerResult,
  type StringFramedDroidClientTransport,
} from "@factory/droid-sdk/node";
import {
  createPermissionCompatibilityTransport,
  scriptPermissionParamsSchema,
  type ScriptPermissionParams,
} from "./permission-compatibility";
import { createSteeringTransport } from "./steering";
import { Permissions } from "./permissions";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";

function fake() {
  let message: ((frame: string) => void) | undefined;
  let error: ((error: Error) => void) | undefined;
  let connected = true;
  let closeCount = 0;
  let rejectSend = false;
  const sent: string[] = [];
  const base: StringFramedDroidClientTransport = {
    get isConnected() { return connected; },
    async send(frame) {
      if (rejectSend) throw new Error("private-transport-error");
      sent.push(frame);
    },
    onMessage(handler) { message = handler; },
    onError(handler) { error = handler; },
    async close() { closeCount++; connected = false; error?.(new Error("Base closed")); },
  };
  return {
    base, sent,
    receive: (frame: string | object) => message?.(typeof frame === "string" ? frame : JSON.stringify(frame)),
    fail: () => error?.(new Error("Process failed")),
    rejectSend: () => { rejectSend = true; },
    closed: () => closeCount,
    responses: () => sent.map((frame) => JSON.parse(frame)),
  };
}

function deferred<T = RequestPermissionHandlerResult>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function knownTool() {
  return {
    toolUse: { type: "tool_use", id: "execute-1", name: "Execute", input: { command: "echo ordinary" } },
    confirmationType: "exec", details: { type: "exec", command: "echo", fullCommand: "echo ordinary" },
  };
}

function request(id = "script-1", protocol = "1.269.0") {
  return {
    jsonrpc: "2.0", factoryApiVersion: LEGACY_FACTORY_API_VERSION,
    // Native revisions differ from SDK 0.9.1's 1.201.1.
    factoryProtocolVersion: protocol,
    type: "request", id, method: "droid.request_permission",
    params: {
      toolUses: [{
        toolUse: {
          type: "tool_use", id: `tool-${id}`, name: "Script",
          thoughtSignature: "private-signature",
          input: { script: 'await tools.paseo.send_agent_prompt({agentId:"child", prompt:"Continue"})' },
        },
        confirmationType: "script",
        details: {
          type: "script", impactLevel: "high",
          calls: [{
            toolName: "paseo___send_agent_prompt", line: 1, column: 7,
            toolInput: { agentId: "child", prompt: "Continue" }, alwaysAsk: true,
            confirmation: { type: "mcp_tool", toolName: "paseo___send_agent_prompt", serverName: "paseo", actualToolName: "send_agent_prompt", impactLevel: "high" },
          }],
        },
      }],
      options: [
        { label: "Once", value: Outcome.ProceedOnce, selectedColor: "#d78700" },
        { label: "Always", value: Outcome.ProceedAlways, selectedColor: "#d78700" },
        { label: "Cancel", value: Outcome.Cancel, selectedColor: "#d75f5f", selectedPrefix: "✕ " },
      ] as { label: string; value: Outcome; selectedColor?: string; selectedPrefix?: string }[],
      associatedSessionIds: ["native-session"],
    },
  };
}

test("SDK-supported requests and all unrelated frames keep their original bytes, including startup frames", async () => {
  const f = fake();
  let calls = 0;
  const bridge = createPermissionCompatibilityTransport(f.base, () => { calls++; return Outcome.Cancel; });
  const known = { ...request("known"), params: { toolUses: [knownTool()], options: [{ label: "Once", value: Outcome.ProceedOnce }] } };
  assert.equal(RequestPermissionRequestSchema.safeParse(known).success, true);
  const original = JSON.stringify(known, null, 2);
  f.receive(original);
  f.receive("not-json");
  const forwarded: string[] = [];
  bridge.transport.onMessage((frame) => forwarded.push(frame));
  const response = '{ "id": "sdk-response", "type": "response", "result": {} }';
  f.receive(response);
  assert.deepEqual(forwarded, [original, "not-json", response]);
  await bridge.transport.send("sdk-outbound-byte-preserved");
  assert.deepEqual(f.sent, ["sdk-outbound-byte-preserved"]);
  assert.equal(calls, 0);
  await bridge.transport.close();
});

for (const protocol of ["1.269.0", "1.272.0", "1.275.0"]) {
  test(`Script ${protocol} remains pending until explicit Once/Cancel and responds with the native ID and protocol`, async () => {
    for (const decision of [Outcome.ProceedOnce, Outcome.Cancel] as const) {
      const f = fake();
      const choice = deferred();
      let received: ScriptPermissionParams | undefined;
      const bridge = createPermissionCompatibilityTransport(f.base, (params) => { received = params; return choice.promise; });
      const forwarded: string[] = [];
      bridge.transport.onMessage((frame) => forwarded.push(frame));
      const input = request(`manual-${decision}`, protocol);
      assert.equal(RequestPermissionRequestSchema.safeParse(input).success, false, "Fixture must reproduce SDK 0.9.1 incompatibility");
      f.receive(input);
      await tick();
      assert.deepEqual(received, input.params);
      assert.deepEqual(f.sent, []);
      choice.resolve(decision);
      await tick();
      assert.deepEqual(f.responses(), [{
        jsonrpc: "2.0", factoryApiVersion: LEGACY_FACTORY_API_VERSION, factoryProtocolVersion: input.factoryProtocolVersion,
        type: "response", id: input.id, result: { selectedOption: decision },
      }]);
      assert.equal(RequestPermissionResponseSchema.safeParse(f.responses()[0]).success, true);
      assert.deepEqual(forwarded, []);
      await bridge.transport.close();
    }
  });
}

test("real Droid 0.249 Script fixture retains its full review content and native reply protocol", async () => {
  const input = JSON.parse(await readFile(new URL("./fixtures/droid-0.249-script-permission.json", import.meta.url), "utf8"));
  assert.equal(input.factoryProtocolVersion, "1.275.0");
  assert.equal(scriptPermissionParamsSchema.safeParse(input.params).success, true);
  assert.equal(RequestPermissionRequestSchema.safeParse(input).success, false);
  const f = fake();
  let reviewed: ScriptPermissionParams | undefined;
  const bridge = createPermissionCompatibilityTransport(f.base, (params) => { reviewed = params; return Outcome.Cancel; });
  f.receive(input);
  await tick();
  assert.deepEqual(reviewed, input.params);
  assert.deepEqual(f.responses(), [{
    jsonrpc: "2.0", factoryApiVersion: "1.0.0", factoryProtocolVersion: "1.275.0",
    type: "response", id: input.id, result: { selectedOption: Outcome.Cancel },
  }]);
  await bridge.transport.close();
});

test("mixed Script and SDK-known tool batches retain every input and accept known trace metadata", async () => {
  const f = fake();
  let received: ScriptPermissionParams | undefined;
  const bridge = createPermissionCompatibilityTransport(f.base, (params) => { received = params; return Outcome.Cancel; });
  const input = request();
  const mixed = { ...input, _meta: { traceparent: "00-01234567890123456789012345678901-0123456789012345-01" }, params: { ...input.params, toolUses: [...input.params.toolUses, knownTool()] } };
  f.receive(mixed);
  await tick();
  assert.deepEqual(received, mixed.params);
  assert.equal(received?.toolUses.length, 2);
  assert.equal(f.responses()[0]?.result.selectedOption, Outcome.Cancel);
  assert.equal(scriptPermissionParamsSchema.safeParse({ ...mixed.params, toolUses: [knownTool()] }).success, false);
  await bridge.transport.close();
});

test("future versions, unsupported fields, nested new confirmations and malformed calls fail closed before handler", async () => {
  const f = fake();
  let calls = 0;
  const bridge = createPermissionCompatibilityTransport(f.base, () => { calls++; return Outcome.ProceedOnce; });
  const forwarded: string[] = [];
  bridge.transport.onMessage((frame) => forwarded.push(frame));
  const mutations: ((input: any) => void)[] = [
    (input) => { input.factoryProtocolVersion = "1.future"; },
    (input) => { input.factoryProtocolVersion = "1.271.0"; },
    (input) => { input.factoryProtocolVersion = "1.273.0"; },
    (input) => { input.factoryProtocolVersion = FACTORY_PROTOCOL_VERSION; },
    (input) => { delete input.factoryProtocolVersion; },
    (input) => { input.factoryApiVersion = "2.0.0"; },
    (input) => { input.futureEnvelope = true; },
    (input) => { input._meta = { unreviewed: "private-sentinel" }; },
    (input) => { input.params.future = true; },
    (input) => { input.params.options[0].selectedColor = { color: "#d78700" }; },
    (input) => { input.params.options[2].selectedPrefix = false; },
    (input) => { input.params.options[0].future = true; },
    (input) => { input.params.toolUses[0].future = true; },
    (input) => { input.params.toolUses[0].toolUse.future = true; },
    (input) => { input.params.toolUses[0].details.future = true; },
    (input) => { input.params.toolUses[0].details.calls[0].future = true; },
    (input) => { input.params.toolUses[0].details.calls[0].confirmation.future = true; },
    (input) => { input.params.toolUses[0].details.calls[0].confirmation = { type: "recommend_mission", reason: "private-sentinel" }; },
    (input) => { input.params.toolUses[0].details.calls[0].confirmation = { type: "script", impactLevel: "low", calls: [] }; },
    (input) => { delete input.params.toolUses[0].details.calls[0].toolInput; },
    (input) => { input.params.toolUses[0].details.calls[0].line = -1; },
    (input) => { input.params.toolUses[0].details.calls[0].column = 1.5; },
    (input) => { input.params.toolUses[0].details.calls = []; },
    (input) => { input.params.toolUses.push({ ...knownTool(), unexpected: "private-sentinel" }); },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const input = request(`invalid-${index}`);
    mutate(input);
    f.receive(input);
  }
  await tick();
  assert.equal(calls, 0);
  assert.equal(f.sent.length, mutations.length);
  for (const response of f.responses()) {
    assert.equal(RequestPermissionResponseSchema.safeParse(response).success, true);
    assert.equal(response.error?.code, -32602);
    assert.equal(response.result, undefined);
  }
  assert.equal(f.sent.join("").includes("private-sentinel"), false);
  assert.deepEqual(forwarded, []);
  await bridge.transport.close();
});

test("handler failures, unsupported outcomes, unoffered choices and injected fields never approve", async () => {
  for (const decision of [Outcome.ProceedAlways, Outcome.ProceedAutoRunHigh, Outcome.ProceedEdit,
    { selectedOption: Outcome.ProceedOnce, clientStartsHandoffSession: true }, { selectedOption: "future" }, null]) {
    const f = fake();
    const bridge = createPermissionCompatibilityTransport(f.base, () => decision as RequestPermissionHandlerResult);
    f.receive(request());
    await tick();
    assert.deepEqual(f.responses()[0].result, { selectedOption: Outcome.Cancel });
    await bridge.transport.close();
  }
  const f = fake();
  const bridge = createPermissionCompatibilityTransport(f.base, () => { throw new Error("private-handler-error"); });
  const input = request();
  input.params.options = [{ label: "Once", value: Outcome.ProceedOnce }];
  f.receive(input);
  await tick();
  assert.equal(f.responses()[0].error.code, -32602, "No unoffered Cancel/Once is synthesized");
  assert.equal(f.sent[0].includes("private-handler-error"), false);
  await bridge.transport.close();
});

test("Once must be offered and invalid selection falls back only to an offered Cancel", async () => {
  const f = fake();
  const bridge = createPermissionCompatibilityTransport(f.base, () => Outcome.ProceedOnce);
  const input = request("cancel-only", "1.272.0");
  input.params.options = [{ label: "Cancel", value: Outcome.Cancel }];
  f.receive(input);
  await tick();
  assert.deepEqual(f.responses()[0].result, { selectedOption: Outcome.Cancel });
  assert.equal(f.responses()[0].factoryProtocolVersion, "1.272.0");
  await bridge.transport.close();
});

test("concurrent requests settle independently, duplicate IDs never reopen, and changed-ID contents fail closed", async () => {
  const f = fake();
  const choices = [deferred(), deferred()];
  let calls = 0;
  const bridge = createPermissionCompatibilityTransport(f.base, () => choices[calls++].promise);
  const first = request("first"), second = request("second", "1.272.0");
  f.receive(first); f.receive(first); f.receive(second);
  await tick();
  assert.equal(calls, 2);
  choices[1].resolve(Outcome.Cancel);
  choices[0].resolve({ selectedOption: Outcome.ProceedOnce, comment: "Reviewed manually" });
  await tick();
  assert.deepEqual(f.responses().map((response) => [response.id, response.result.selectedOption]), [["second", Outcome.Cancel], ["first", Outcome.ProceedOnce]]);
  assert.deepEqual(f.responses().map((response) => response.factoryProtocolVersion), ["1.272.0", "1.269.0"]);
  f.receive(first); f.receive(second);
  await tick();
  assert.equal(calls, 2);
  assert.equal(f.sent.length, 2);
  let error: Error | undefined;
  bridge.transport.onError((failure) => { error = failure; });
  f.receive({ ...first, params: { ...first.params, associatedSessionIds: ["different"] } });
  await tick();
  assert.match(error?.message ?? "", /reused.*different contents/);
  assert.equal(f.closed(), 1);
  assert.equal(f.sent.length, 2);
});

test("interrupt cancels each pending permission once and ignores late user decisions without blocking later work", async () => {
  const f = fake();
  const choices = [deferred(), deferred()];
  let calls = 0;
  const bridge = createPermissionCompatibilityTransport(f.base, () => choices[calls++].promise);
  f.receive(request("interrupted"));
  await tick();
  const interrupt = JSON.stringify({ type: "request", method: "droid.interrupt_session", id: "interrupt" });
  await bridge.transport.send(interrupt);
  assert.deepEqual(f.responses()[0].result, { selectedOption: Outcome.Cancel });
  assert.equal(f.sent[1], interrupt);
  bridge.cancelPending();
  choices[0].resolve(Outcome.ProceedOnce);
  f.receive(request("interrupted"));
  await tick();
  assert.equal(f.sent.length, 2);
  f.receive(request("after-interrupt"));
  await tick();
  choices[1].resolve(Outcome.ProceedOnce);
  await tick();
  assert.equal(f.responses()[2].id, "after-interrupt");
  assert.equal(f.responses()[2].result.selectedOption, Outcome.ProceedOnce);
  await bridge.transport.close();
});

test("close is idempotent, prevents callbacks before dispatch and safely ignores late resolution", async () => {
  const f = fake();
  const choice = deferred();
  let calls = 0;
  const bridge = createPermissionCompatibilityTransport(f.base, () => { calls++; return choice.promise; });
  let errors = 0;
  bridge.transport.onError(() => { errors++; void bridge.transport.close(); });
  f.receive(request("waiting"));
  await tick();
  f.receive(request("not-yet-dispatched"));
  const closing = bridge.transport.close();
  assert.equal(bridge.transport.close(), closing);
  await closing;
  choice.resolve(Outcome.ProceedOnce);
  f.receive(request("after-close"));
  await tick();
  assert.equal(calls, 1);
  assert.equal(errors, 1);
  assert.equal(f.closed(), 1);
  assert.equal(f.sent.length, 2);
  assert.ok(f.responses().every((response) => response.result.selectedOption === Outcome.Cancel));
  await assert.rejects(bridge.transport.send("late"), /closed/);
});

test("process/send failures retire pending decisions with a single sanitized terminal error", async () => {
  for (const mode of ["process", "send"]) {
    const f = fake();
    const choice = deferred();
    const bridge = createPermissionCompatibilityTransport(f.base, () => choice.promise);
    const errors: Error[] = [];
    bridge.transport.onError((error) => errors.push(error));
    f.receive(request());
    await tick();
    if (mode === "process") f.fail();
    else f.rejectSend();
    choice.resolve(Outcome.ProceedOnce);
    await tick();
    if (mode === "send") assert.equal(f.closed(), 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message.includes("private-transport-error"), false);
    assert.equal(bridge.transport.isConnected, false);
    assert.deepEqual(f.sent, []);
    await bridge.transport.close();
    assert.equal(errors.length, 1);
  }
});

test("Script compatibility composes with native steering without intercepting either SDK or steering responses", async () => {
  const f = fake();
  const choice = deferred();
  const compatibility = createPermissionCompatibilityTransport(f.base, () => choice.promise);
  const steering = createSteeringTransport(compatibility.transport);
  const forwarded: string[] = [];
  steering.transport.onMessage((frame) => forwarded.push(frame));
  f.receive(request());
  await tick();
  const pending = steering.steer("A new instruction");
  const nativeSteer = f.responses()[0];
  f.receive({ jsonrpc: "2.0", factoryApiVersion: LEGACY_FACTORY_API_VERSION, factoryProtocolVersion: FACTORY_PROTOCOL_VERSION, type: "response", id: nativeSteer.id, result: {} });
  await pending;
  choice.resolve(Outcome.Cancel);
  await tick();
  f.receive('{"id":"sdk-response","result":{}}');
  assert.deepEqual(forwarded, ['{"id":"sdk-response","result":{}}']);
  assert.equal(f.responses()[1].id, "script-1");
  assert.equal(f.responses()[1].result.selectedOption, Outcome.Cancel);
  await steering.transport.close();
});

test("actual SDK parser and real Permissions bridge route Script to a manual card while ordinary permissions retain SDK ownership", async () => {
  const f = fake();
  const events: ProviderEvent[] = [];
  const permissions = new Permissions("paseo-session", (event) => events.push(event));
  const compatibility = createPermissionCompatibilityTransport(f.base, permissions.scriptPermissionHandler);
  const client = new DroidClient({ transport: compatibility.transport });
  let knownCalls = 0;
  client.setPermissionHandler(async () => { knownCalls++; return Outcome.ProceedOnce; });
  f.receive(request("native-script-id"));
  await tick();
  const card = events.find((event) => event.type === "session.permission");
  assert.equal(card?.type, "session.permission");
  if (card?.type !== "session.permission") throw new Error("Missing native Script card");
  assert.equal(knownCalls, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(JSON.stringify(card).includes("private-signature"), false);
  permissions.respond(card.request.id, { behavior: "allow", selectedActionId: Outcome.ProceedOnce });
  await tick();
  assert.deepEqual(f.responses()[0].result, { selectedOption: Outcome.ProceedOnce });
  f.receive({ ...request("ordinary-sdk-id"), params: { toolUses: [knownTool()], options: [{ label: "Once", value: Outcome.ProceedOnce }] } });
  await tick();
  assert.equal(knownCalls, 1);
  assert.equal(events.filter((event) => event.type === "session.permission").length, 1);
  assert.equal(f.responses()[1].id, "ordinary-sdk-id");
  assert.deepEqual(f.responses()[1].result, { selectedOption: Outcome.ProceedOnce });
  await client.close();
  permissions.close();
});

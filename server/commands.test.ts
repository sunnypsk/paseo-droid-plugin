import assert from "node:assert/strict";
import { test } from "node:test";
import { SkillInfoSchema, type StringFramedDroidClientTransport } from "@factory/droid-sdk/node";
import {
  createCommandTransport, presentCommands, selectedCommand, supportsCommands, formatContext, formatLimits, readSessionLimits,
} from "./commands";

function fake() {
  let receive = (_frame: string) => {};
  let fail = (_error: Error) => {};
  let closed = false;
  const sent: Array<{ id: string; method: string; params: unknown }> = [];
  const transport: StringFramedDroidClientTransport = {
    get isConnected() { return !closed; }, async send(frame) { sent.push(JSON.parse(frame)); },
    onMessage(handler) { receive = handler; }, onError(handler) { fail = handler; },
    async close() { closed = true; fail(new Error("Process closed")); },
  };
  return { transport, sent, receive: (frame: string) => receive(frame), fail: (error: Error) => fail(error),
    reply(id: string, fields: object) { receive(JSON.stringify({ jsonrpc: "2.0", type: "response", id,
      factoryApiVersion: "1.0.0", factoryProtocolVersion: "1.275.0", ...fields })); } };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const breakdown = { modelId: "model", modelDisplayName: "Example", contextBudget: 100000, usedTokens: 2000, freeTokens: 98000,
  categories: [{ name: "Messages", tokens: 2000 }] };

test("command RPCs share the SDK transport without consuming other replies or permissions", async () => {
  const f = fake();
  const bridge = createCommandTransport(f.transport);
  const frames: string[] = [];
  const early = '{"type":"notification","params":{"startup":true}}';
  f.receive(early);
  bridge.transport.onMessage((frame) => frames.push(frame));
  const list = bridge.list();
  const context = bridge.context();
  await tick();
  assert.deepEqual(f.sent.map((request) => request.method), ["droid.list_commands", "droid.get_context_breakdown"]);
  assert.deepEqual(f.sent.map((request) => request.params), [{}, {}]);
  f.receive('{"id":"sdk-owned","result":{}}');
  f.receive('{"type":"request","method":"droid.request_permission","id":"permission"}');
  f.reply(f.sent[1].id, { result: breakdown });
  f.reply(f.sent[0].id, { result: { commands: [{ name: "review", description: "Review", isExecutable: true, argumentHint: "<branch>" }] } });
  assert.equal((await list)[0].isExecutable, true);
  assert.deepEqual(await context, breakdown);
  assert.deepEqual(frames, [early, '{"id":"sdk-owned","result":{}}', '{"type":"request","method":"droid.request_permission","id":"permission"}']);
  await bridge.transport.close();
});

test("read timeout and native rejection preserve the SDK session and swallow late replies", async () => {
  const f = fake();
  const bridge = createCommandTransport(f.transport);
  const frames: string[] = [];
  bridge.transport.onMessage((frame) => frames.push(frame));
  await assert.rejects(bridge.list({ timeoutMs: 5 }), /timed out/);
  f.reply(f.sent[0].id, { result: { commands: [] } });
  const next = bridge.list();
  await tick();
  f.reply(f.sent[1].id, { error: { code: -32601, message: "private-native-error" } });
  await assert.rejects(next, (error: Error) => /-32601/.test(error.message) && !error.message.includes("private-native-error"));
  const invalid = bridge.context();
  await tick();
  f.reply(f.sent[2].id, { result: { ...breakdown, usedTokens: -1 } });
  await assert.rejects(invalid);
  assert.equal(bridge.transport.isConnected, true);
  assert.deepEqual(frames, []);
  await bridge.transport.close();
});

test("abort and process shutdown release all owned reads", async () => {
  const f = fake();
  const bridge = createCommandTransport(f.transport);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(bridge.list({ signal: aborted.signal }));
  assert.equal(f.sent.length, 0);
  const controller = new AbortController();
  const pending = bridge.list({ signal: controller.signal });
  const rejected = assert.rejects(pending, /canceled/);
  controller.abort();
  await rejected;
  const first = bridge.list();
  const second = bridge.context();
  const failures = [assert.rejects(first, /closed/), assert.rejects(second, /closed/)];
  await bridge.transport.close();
  await Promise.all(failures);
});

test("native precedence, disabled skills, and builtin-skill policy control the composer list", () => {
  const skill = (name: string, extra: object = {}) => SkillInfoSchema.parse({ name, location: "project", filePath: `/skills/${name}/SKILL.md`, ...extra });
  const commands = presentCommands([
    { name: "compact", description: "Must not replace the builtin" },
    { name: "REVIEW", description: "Custom wins", argumentHint: "<branch>" },
  ], [skill("review"), skill("active"), skill("disabled", { enabled: false }), skill("hidden", { userInvocable: false }),
    skill("builtin", { location: "builtin" })], true);
  assert.deepEqual(commands.map((command) => command.name), ["active", "compact", "context", "limits", "REVIEW"]);
  assert.equal(commands.find((command) => command.name === "REVIEW")?.description, "Custom wins");
  assert.equal(commands.find((command) => command.name === "compact")?.description, "Summarize the conversation");
});

test("text steering recognizes known commands while retaining quoted and multiline arguments", () => {
  const request = { clientMessageId: "id", delivery: "steer" as const,
    input: { type: "message" as const, content: [{ type: "text" as const, text: '/review "feature/a b"\nkeep this  ' }] } };
  assert.deepEqual(selectedCommand(request, [{ name: "review", description: "" }]), { name: "review", arguments: '"feature/a b"\nkeep this  ' });
  assert.equal(selectedCommand({ ...request, input: { type: "message", content: [{ type: "text", text: "/tmp/file" }] } }, []), undefined);
  assert.equal(selectedCommand({ ...request, input: { ...request.input, content: [...request.input.content, { type: "text", text: "context" }] } }, [{ name: "review", description: "" }]), undefined);
});

test("version gating keeps older and unrecognized CLIs out of native command handling", () => {
  for (const version of ["0.244.0", "0.248.9", "unknown", undefined]) assert.equal(supportsCommands(version), false);
  for (const version of ["Droid 0.249.0", "0.250.1", "1.0.0"]) assert.equal(supportsCommands(version), true);
});

test("context and quota reports use native occupancy and explicitly report missing login data", () => {
  assert.match(formatContext(breakdown), /Used: 2,000 \/ 100,000 tokens/);
  assert.match(formatLimits({ status: "unavailable", problem: { kind: "expired", expiresAt: "2020-01-01" } }), /access token has expired/);
  const quota = formatLimits({ status: "available", windows: [{ id: "standard", label: "Standard", usedPct: 20, remainingPct: 80 }] });
  assert.match(quota, /Standard · 20% used · 80% remaining/);
});

test("limits stays scoped to the launch's Windows home and does not fall back to an unrelated account", async () => {
  const source = { id: "test", label: "Test", input: {} as never,
    async discover(scope: { kind: string; env?: Readonly<Record<string, string>> }) {
      assert.equal(scope.kind, "session");
      assert.equal(scope.env?.HOME, process.platform === "win32" ? "C:/isolated-user" : undefined);
      assert.equal(scope.env?.FACTORY_API_KEY, "test-key");
      return [];
    },
    async fetch(): Promise<never> { throw new Error("Must not fetch another account"); },
  };
  assert.match(await readSessionLimits({ USERPROFILE: "C:/isolated-user", FACTORY_API_KEY: "test-key" }, source), /unavailable/);
});

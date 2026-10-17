import assert from "node:assert/strict";
import { test } from "node:test";
import { DocumentSourceSchema, FACTORY_PROTOCOL_VERSION, type StringFramedDroidClientTransport } from "@factory/droid-sdk/node";
import { createSteeringTransport } from "./steering";

function fake() {
  let message: ((frame: string) => void) | undefined;
  let error: ((error: Error) => void) | undefined;
  let connected = true;
  const sent: string[] = [];
  let closeCount = 0;
  const base: StringFramedDroidClientTransport = {
    get isConnected() { return connected; },
    async send(frame) { sent.push(frame); },
    onMessage(handler) { message = handler; },
    onError(handler) { error = handler; },
    async close() { closeCount++; connected = false; error?.(new Error("Base transport closed")); },
  };
  return {
    base, sent,
    receive: (frame: string) => message?.(frame),
    fail: (failure: Error) => error?.(failure),
    closed: () => closeCount,
    reply(id: string, fields: Record<string, unknown> = { result: {} }) {
      message?.(JSON.stringify({ jsonrpc: "2.0", factoryApiVersion: "1.0.0", factoryProtocolVersion: FACTORY_PROTOCOL_VERSION, type: "response", id, ...fields }));
    },
  };
}

test("preserves early stdout, SDK frames, and server requests exactly", async () => {
  const f = fake();
  const bridge = createSteeringTransport(f.base);
  const frames: string[] = [];
  f.receive('{"method":"droid.session_notification","params":{"early":true}}');
  bridge.transport.onMessage((frame) => frames.push(frame));
  f.receive('{"id":"sdk-request","result":{}}');
  f.receive('{"id":"permission-request","method":"droid.request_permission","params":{}}');
  assert.equal(frames.length, 3);
  assert.equal(JSON.parse(frames[0]).params.early, true);
  await bridge.transport.send("sdk-outgoing");
  assert.deepEqual(f.sent, ["sdk-outgoing"]);
  await bridge.transport.close();
});

test("steers via the native boundary queue with idle-loop guard and attachments", async () => {
  const f = fake();
  const bridge = createSteeringTransport(f.base);
  const sdkFrames: string[] = [];
  bridge.transport.onMessage((frame) => sdkFrames.push(frame));
  const pending = bridge.steer("Use the new requirement", {
    messageId: "client-message",
    images: [{ type: "base64", mediaType: "image/png", data: "cG5n" }],
    files: [DocumentSourceSchema.parse({ type: "text", mediaType: "text/plain", data: "file contents", name: "notes.txt" })],
  });
  const request = JSON.parse(f.sent[0]);
  assert.equal(request.method, "droid.add_user_message");
  assert.match(request.id, /^paseo-steer:/);
  assert.deepEqual(request.params, {
    text: "Use the new requirement",
    messageId: "client-message",
    images: [{ type: "base64", mediaType: "image/png", data: "cG5n" }],
    files: [{ type: "text", mediaType: "text/plain", data: "file contents", name: "notes.txt" }],
    userMessageSource: "sdk", queuePlacement: "end_of_turn", skipAgentLoop: true,
  });
  f.reply(request.id);
  await pending;
  assert.equal(sdkFrames.length, 0);
  assert.equal(f.sent.length, 1);
  await bridge.transport.close();
});

test("native steering rejection preserves the SDK channel and sanitizes the error", async () => {
  const f = fake();
  const bridge = createSteeringTransport(f.base);
  const pending = bridge.steer("Update");
  f.reply(JSON.parse(f.sent[0]).id, { error: { code: -32602, message: "private-error-sentinel" } });
  await assert.rejects(pending, (error: Error) => /-32602/.test(error.message) && !error.message.includes("private-error-sentinel"));
  assert.equal(bridge.transport.isConnected, true);
  await bridge.transport.close();
});

test("canceling a pending acknowledgment ignores its late reply and permits later steering", async () => {
  const f = fake();
  const bridge = createSteeringTransport(f.base);
  const sdkFrames: string[] = [];
  bridge.transport.onMessage((frame) => sdkFrames.push(frame));
  const first = bridge.steer("First");
  const rejected = assert.rejects(first, /stop requested/);
  bridge.cancelPending(new Error("stop requested"));
  await rejected;
  f.reply(JSON.parse(f.sent[0]).id);
  const second = bridge.steer("Second");
  f.reply(JSON.parse(f.sent[1]).id);
  await second;
  assert.equal(sdkFrames.length, 0);
  assert.equal(bridge.transport.isConnected, true);
  await bridge.transport.close();
});

test("underlying failure rejects pending steering and notifies the SDK once", async () => {
  const f = fake();
  const bridge = createSteeringTransport(f.base);
  let errors = 0;
  bridge.transport.onError(() => { errors++; });
  const pending = bridge.steer("Update");
  const rejected = assert.rejects(pending, /process failed/);
  f.fail(new Error("process failed"));
  await rejected;
  const closing = bridge.transport.close();
  assert.equal(bridge.transport.close(), closing);
  await closing;
  assert.equal(errors, 1);
  assert.equal(f.closed(), 1);
});

test("ack timeout closes the uncertain connection", async () => {
  const f = fake();
  const bridge = createSteeringTransport(f.base);
  await assert.rejects(bridge.steer("Update", { timeoutMs: 10 }), /timed out/);
  await bridge.transport.close();
  assert.equal(f.closed(), 1);
  assert.equal(bridge.transport.isConnected, false);
});

test("abort cancels the local wait and pre-aborted calls send no request", async () => {
  const f = fake();
  const bridge = createSteeringTransport(f.base);
  const controller = new AbortController();
  const pending = bridge.steer("Update", { signal: controller.signal });
  const rejected = assert.rejects(pending, /stop requested/);
  controller.abort(new Error("stop requested"));
  await rejected;
  await assert.rejects(bridge.steer("Later", { signal: controller.signal }), /stop requested/);
  assert.equal(f.sent.length, 1);
  assert.equal(f.closed(), 0);
  await bridge.transport.close();
});

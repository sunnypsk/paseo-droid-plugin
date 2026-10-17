import assert from "node:assert/strict";
import test from "node:test";
import type { DroidMessage, FactoryDroidMessage } from "@factory/droid-sdk";
import { ProviderEventSchema, type ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { DroidTimeline } from "./timeline";

type TextItem = Extract<ProviderTimelineItem, { type: "assistant_message" | "reasoning" }>;

function delta(messageId: string, text: string, thinking = false, blockIndex = 0): DroidMessage {
  return { type: thinking ? "thinking_text_delta" : "assistant_text_delta", messageId, blockIndex, text };
}

function nativeMessage(id: string, role: "assistant" | "user", content: FactoryDroidMessage["content"]): FactoryDroidMessage {
  return { id, role, content } as FactoryDroidMessage;
}

function assistant(messageId: string, text: string): DroidMessage {
  return { type: "assistant", message: nativeMessage(messageId, "assistant", [{ type: "text", text }]), text };
}

function call(id: string, name: string, input: Record<string, unknown>): DroidMessage {
  return { type: "tool_call", toolUseId: id, name, input };
}

function result(id: string, name: string, failed = false): DroidMessage {
  return { type: "tool_result", toolUseId: id, toolName: name, content: failed ? "Tool failed" : "Done", isError: failed };
}

function retract(messageId: string): DroidMessage { return { type: "assistant_message_retracted", messageId }; }

function textItems(items: ProviderTimelineItem[]): TextItem[] {
  return items.filter((item): item is TextItem => item.type === "assistant_message" || item.type === "reasoning");
}

function validate(items: ProviderTimelineItem[]): void {
  for (const item of items) ProviderEventSchema.parse({ type: "timeline.item", sessionId: "test", item });
}

test("small deltas buffer until flush and publish complete stable text snapshots", () => {
  const timeline = new DroidTimeline();
  assert.deepEqual(timeline.handle(delta("answer", "")), []);
  assert.equal(timeline.hasPendingText, false);
  assert.deepEqual(timeline.handle(delta("answer", "Hello ")), []);
  assert.deepEqual(timeline.handle(delta("answer", "world")), []);
  assert.deepEqual(timeline.handle(delta("reason", "Thinking", true)), []);
  assert.equal(timeline.hasPendingText, true);
  const flushed = timeline.flush();
  assert.deepEqual(textItems(flushed).map(({ id, text }) => ({ id, text })), [
    { id: "droid:assistant_message:answer:0", text: "Hello world" },
    { id: "droid:reasoning:reason:0", text: "Thinking" },
  ]);
  validate(flushed);
  assert.equal(timeline.hasPendingText, false);
  assert.deepEqual(timeline.flush(), []);
  timeline.handle(delta("answer", "!"));
  assert.equal(textItems(timeline.flush())[0].text, "Hello world!");
});

test("a synchronous burst auto-flushes at the presentation limit without losing text", () => {
  const timeline = new DroidTimeline();
  assert.deepEqual(timeline.handle(delta("large", "a".repeat(4095))), []);
  const emitted = timeline.handle(delta("large", "b"));
  assert.equal(textItems(emitted)[0].text, "a".repeat(4095) + "b");
  assert.equal(timeline.hasPendingText, false);
  assert.deepEqual(timeline.flush(), []);
});

test("non-delta events flush text before tools and dedupe the matching final assistant snapshot", () => {
  const timeline = new DroidTimeline();
  timeline.handle(delta("before-tool", "About to read"));
  const before = timeline.handle(call("read", "Read", { file_path: "/tmp/example" }));
  assert.deepEqual(before.map((item) => item.type), ["assistant_message", "tool_call"]);
  timeline.handle(delta("after-tool", "Reading finished"));
  const after = timeline.handle(result("read", "Read"));
  assert.deepEqual(after.map((item) => item.type), ["assistant_message", "tool_call"]);
  assert.equal(after[1].type === "tool_call" && after[1].status, "completed");

  timeline.handle(delta("final", "Final answer"));
  const completed = timeline.handle(assistant("final", "Final answer"));
  assert.equal(completed.length, 1);
  assert.equal(textItems(completed)[0].text, "Final answer");
  assert.deepEqual(timeline.handle(assistant("final", "Final answer")), []);
  validate([...before, ...after, ...completed]);
});

test("text snapshot deduplication does not serialize text with JSON.stringify", () => {
  const timeline = new DroidTimeline();
  const original = JSON.stringify;
  let serialized = 0;
  JSON.stringify = (() => { serialized++; throw new Error("Text must not use the tool fingerprint serializer"); }) as typeof JSON.stringify;
  try {
    assert.equal(timeline.handle(assistant("same", "Exact answer")).length, 1);
    assert.deepEqual(timeline.handle(assistant("same", "Exact answer")), []);
    timeline.handle(delta("same", " plus one"));
    assert.equal(textItems(timeline.flush())[0].text, "Exact answer plus one");
  } finally { JSON.stringify = original; }
  assert.equal(serialized, 0);
});

test("10,000 small deltas preserve exact content with fewer than 60 emitted updates", () => {
  const timeline = new DroidTimeline();
  const chunk = "0123456789abcdefghij";
  const emitted: ProviderTimelineItem[] = [];
  for (let index = 0; index < 10_000; index++) emitted.push(...timeline.handle(delta("long-answer", chunk)));
  emitted.push(...timeline.flush());
  const updates = textItems(emitted);
  assert.ok(updates.length > 1 && updates.length < 60, `Unexpected update count: ${updates.length}`);
  assert.equal(updates.at(-1)?.text, chunk.repeat(10_000));
  assert.equal(updates.at(-1)?.text.length, 200_000);
  for (let index = 1; index < updates.length; index++) assert.ok(updates[index].text.startsWith(updates[index - 1].text));
  validate(emitted);
});

test("retraction discards unpublished text, clears all matching blocks and warns once", () => {
  const timeline = new DroidTimeline();
  timeline.handle(delta("withdrawn", "Published answer"));
  timeline.handle(delta("withdrawn", "Published reasoning", true, 1));
  timeline.flush();
  timeline.handle(delta("withdrawn", " NEVER PUBLISH THIS"));
  const retracted = timeline.handle(retract("withdrawn"));
  assert.deepEqual(textItems(retracted).map((item) => item.text), ["", ""]);
  const notices = retracted.filter((item) => item.type === "notification");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].id, "droid:retracted:withdrawn");
  assert.equal(notices[0].type === "notification" && notices[0].level, "warning");
  assert.doesNotMatch(JSON.stringify(retracted), /NEVER PUBLISH THIS/);
  assert.deepEqual(timeline.flush(), []);
  assert.deepEqual(timeline.handle(retract("withdrawn")), []);
  validate(retracted);
});

test("retraction before the first flush never publishes withdrawn content", () => {
  const timeline = new DroidTimeline();
  timeline.handle(delta("never-visible", "Unpublished withdrawn content"));
  const items = timeline.handle(retract("never-visible"));
  assert.deepEqual(textItems(items).map((item) => item.text), [""]);
  assert.equal(items.filter((item) => item.type === "notification").length, 1);
  assert.doesNotMatch(JSON.stringify(items), /Unpublished withdrawn content/);
  assert.equal(timeline.hasPendingText, false);
  assert.deepEqual(timeline.handle(retract("missing-message")), []);
});

test("same-ID replacement starts fresh after retraction and other messages remain intact", () => {
  const timeline = new DroidTimeline();
  timeline.handle(delta("replaced", "Wrong answer"));
  timeline.flush();
  timeline.handle(delta("replaced", " discard pending suffix"));
  timeline.handle(delta("unaffected", "Keep this"));
  const removed = timeline.handle(retract("replaced"));
  assert.equal(textItems(removed).find((item) => item.id.includes("unaffected"))?.text, "Keep this");
  timeline.handle(delta("replaced", "Correct replacement"));
  timeline.handle(delta("unaffected", " plus update"));
  const next = textItems(timeline.flush());
  assert.equal(next.find((item) => item.id.includes("replaced"))?.text, "Correct replacement");
  assert.equal(next.find((item) => item.id.includes("unaffected"))?.text, "Keep this plus update");
  assert.doesNotMatch(JSON.stringify(next), /Wrong answer|discard pending suffix/);
});

test("release discards pending text, prior tool state and dedupe indexes", () => {
  const timeline = new DroidTimeline();
  timeline.handle(assistant("reuse", "Old response"));
  timeline.handle(retract("reuse"));
  timeline.handle(call("reuse-tool", "Read", { file_path: "/tmp/old" }));
  timeline.handle(result("reuse-tool", "Read"));
  timeline.handle(delta("reuse", "Must not survive release"));
  timeline.release();
  assert.equal(timeline.hasPendingText, false);
  assert.deepEqual(timeline.flush(), []);
  assert.deepEqual(timeline.finishTools("completed"), []);
  const fresh = timeline.handle(call("reuse-tool", "Read", { file_path: "/tmp/new" }));
  assert.equal(fresh[0].type === "tool_call" && fresh[0].status, "running");
  assert.deepEqual(fresh[0].type === "tool_call" && fresh[0].detail, { type: "read", filePath: "/tmp/new", content: undefined, offset: undefined, limit: undefined });
  assert.equal(textItems(timeline.handle(assistant("reuse", "Old response")))[0].text, "Old response");
  assert.equal(timeline.handle(retract("reuse")).filter((item) => item.type === "notification").length, 1);
});

test("TodoWrite publishes authoritative task lists only after successful tool results", () => {
  const timeline = new DroidTimeline();
  const first = { todos: "1. [in_progress] Inspect\n2. [pending] Verify" };
  assert.equal(timeline.handle(call("todo-1", "TodoWrite", first)).some((item) => item.type === "todo"), false);
  assert.equal(timeline.handle(result("todo-1", "TodoWrite", true)).some((item) => item.type === "todo"), false);
  timeline.handle(call("todo-2", "TodoWrite", first));
  const success = timeline.handle(result("todo-2", "TodoWrite"));
  const initial = success.find((item) => item.type === "todo");
  assert.equal(initial?.type, "todo");
  assert.equal(initial?.items.length, 2);
  assert.equal(initial?.items[0].status, "in_progress");
  timeline.handle(call("todo-3", "TodoWrite", { todos: "1. [completed] Inspect" }));
  const replaced = timeline.handle(result("todo-3", "TodoWrite")).find((item) => item.type === "todo");
  assert.equal(replaced?.id, initial?.id);
  assert.deepEqual(replaced?.items, [{ text: "Inspect", completed: true, status: "completed" }]);
  timeline.handle(call("todo-4", "TodoWrite", { todos: [] }));
  assert.deepEqual(timeline.handle(result("todo-4", "TodoWrite")).find((item) => item.type === "todo")?.items, []);
  validate(success);
});

test("turn completion or cancellation cannot manufacture a successful TodoWrite update", () => {
  for (const status of ["completed", "failed", "canceled"] as const) {
    const timeline = new DroidTimeline();
    timeline.handle(call("pending-todo", "TodoWrite", { todos: "1. [completed] Not acknowledged" }));
    timeline.handle(delta("finish", "Final text"));
    const finished = timeline.finishTools(status);
    assert.deepEqual(finished.map((item) => item.type), ["assistant_message", "tool_call"]);
    assert.equal(finished.some((item) => item.type === "todo"), false);
    assert.equal(finished[1].type === "tool_call" && finished[1].status, status);
    validate(finished);
  }
});

test("history replay uses the streaming identities and replays successful todo results only", () => {
  const timeline = new DroidTimeline();
  const messages = [
    nativeMessage("user", "user", [{ type: "text", text: "Review this" }]),
    nativeMessage("assistant", "assistant", [
      { type: "text", text: "Reviewing" },
      { type: "tool_use", id: "todo-replay", name: "TodoWrite", input: { todos: "1. [completed] Reviewed" } },
    ]),
    nativeMessage("tool-results", "user", [{ type: "tool_result", toolUseId: "todo-replay", content: "Done", isError: false }]),
  ];
  const replayed = timeline.replay(messages);
  assert.equal(replayed.find((item) => item.type === "user_message")?.id, "droid:user:user");
  assert.equal(replayed.find((item) => item.type === "assistant_message")?.id, "droid:assistant_message:assistant:0");
  assert.equal(replayed.find((item) => item.type === "todo")?.id, "droid:todo");
  assert.equal(replayed.find((item) => item.type === "todo")?.items[0].completed, true);
  assert.deepEqual(timeline.handle(assistant("assistant", "Reviewing")), []);
  validate(replayed);

  const failed = new DroidTimeline().replay([
    nativeMessage("failed-call", "assistant", [{ type: "tool_use", id: "failed-todo", name: "TodoWrite", input: { todos: "1. [completed] Must not apply" } }]),
    nativeMessage("failed-result", "user", [{ type: "tool_result", toolUseId: "failed-todo", content: "Failed", isError: true }]),
  ]);
  assert.equal(failed.some((item) => item.type === "todo"), false);
});

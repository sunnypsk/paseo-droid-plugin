import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderPersistence, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { TimelinePersistence } from "./persistence";

const nativeSessionId = "11111111-1111-4111-8111-111111111111";
const cwd = "/workspace/project";
type SnapshotData = { nativeSessionId: string; cwd: string; items: ProviderTimelineItem[] };
function data(snapshot: ProviderPersistence): SnapshotData { return snapshot.data as unknown as SnapshotData; }

test("successive persistence snapshots serialize only new or replaced rows", () => {
  const builder = new TimelinePersistence();
  const serialized: string[] = [];
  function row(id: string, text: string): ProviderTimelineItem {
    const source: ProviderTimelineItem & { toJSON(): unknown } = {
      type: "assistant_message", id, text,
      toJSON() { serialized.push(id); return { type: "assistant_message", id, text }; },
    };
    return source;
  }
  const items = new Map([["a", row("a", "first")], ["b", row("b", "second")]]);
  const first = builder.build(nativeSessionId, cwd, items);
  assert.deepEqual(serialized, ["a", "b"]);
  const same = builder.build(nativeSessionId, cwd, items);
  assert.deepEqual(serialized, ["a", "b"], "Unchanged rows must not be serialized again");
  assert.notEqual(same, first);
  assert.notEqual(same.data, first.data);
  assert.notEqual(data(same).items, data(first).items);
  assert.equal(data(same).items[0], data(first).items[0], "Reuse immutable row data across snapshots");

  items.set("b", row("b", "updated"));
  items.set("c", row("c", "third"));
  const changed = builder.build(nativeSessionId, cwd, items);
  assert.deepEqual(serialized, ["a", "b", "b", "c"]);
  assert.equal(data(changed).items[0], data(first).items[0]);
  assert.deepEqual(data(first).items.map((item) => "text" in item ? item.text : ""), ["first", "second"]);
  assert.deepEqual(data(changed).items.map((item) => "text" in item ? item.text : ""), ["first", "updated", "third"]);
});

test("cached persistence is deeply immutable and preserves complete JSON-safe row content", () => {
  const builder = new TimelinePersistence();
  const row: ProviderTimelineItem = {
    type: "tool_call", id: "tool", callId: "call", name: "Execute", status: "completed", error: null,
    detail: { type: "shell", command: "read a large file", cwd: undefined, output: "x".repeat(64_000) },
  };
  const items = new Map([[row.id, row]]);
  const snapshot = builder.build(nativeSessionId, cwd, items);
  const previous = JSON.parse(JSON.stringify({ nativeSessionId, cwd, items: [...items.values()] }));
  assert.deepEqual(snapshot.data, previous, "Retain all history and the former undefined-field serialization semantics");
  assert.ok(z.json().safeParse(snapshot.data).success);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), { version: 1, data: previous });
  assert.equal(Object.hasOwn((data(snapshot).items[0] as typeof row).detail, "cwd"), false);
  assert.equal((data(snapshot).items[0] as typeof row).detail.type, "shell");
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.data));
  assert.ok(Object.isFrozen(data(snapshot).items));
  assert.ok(Object.isFrozen(data(snapshot).items[0]));
  assert.ok(Object.isFrozen((data(snapshot).items[0] as typeof row).detail));
  assert.throws(() => { (data(snapshot).items[0] as typeof row).name = "changed"; }, TypeError);
  row.name = "source changed later";
  assert.equal((data(snapshot).items[0] as typeof row).name, "Execute", "A source mutation cannot corrupt an earlier snapshot");
});

test("removed rows leave the cache and reinserted references are serialized afresh in map order", () => {
  const builder = new TimelinePersistence();
  let serializations = 0;
  const removed: ProviderTimelineItem & { toJSON(): unknown } = {
    type: "reasoning", id: "removed", text: "old",
    toJSON() { serializations++; return { type: "reasoning", id: "removed", text: "old" }; },
  };
  const retained: ProviderTimelineItem = { type: "user_message", id: "retained", text: "keep" };
  const items = new Map<string, ProviderTimelineItem>([[removed.id, removed], [retained.id, retained]]);
  const first = builder.build(nativeSessionId, cwd, items);
  items.delete(removed.id);
  const without = builder.build(nativeSessionId, cwd, items);
  assert.deepEqual(data(without).items.map((item) => item.id), ["retained"]);
  items.set(removed.id, removed);
  const reinserted = builder.build(nativeSessionId, "/workspace/other", items);
  assert.equal(serializations, 2, "Removed references must not remain cached");
  assert.deepEqual(data(reinserted).items.map((item) => item.id), ["retained", "removed"]);
  assert.equal(data(reinserted).cwd, "/workspace/other");
  assert.deepEqual(data(first).items.map((item) => item.id), ["removed", "retained"]);
});

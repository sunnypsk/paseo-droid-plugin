import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderPersistence, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { TimelinePersistence } from "./persistence";
import { FileSnapshotStore } from "./snapshot-store";

const nativeId = "11111111-1111-4111-8111-111111111111";
const cwd = "/private/test-project";
const reference = (value: ProviderPersistence) => value.data as { nativeSessionId: string; cwd: string; snapshotKey: string };

test("v2 preserves rows, order and tasks across store instances and reuses unchanged rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "droid-snapshots-"));
  try {
    const store = new FileSnapshotStore(directory);
    const builder = new TimelinePersistence();
    const items = new Map<string, ProviderTimelineItem>([
      ["user", { type: "user_message", id: "user", text: "Existing prompt" }],
      ["answer", { type: "assistant_message", id: "answer", text: "Existing response" }],
      ["tasks", { type: "todo", id: "tasks", items: [{ text: "Existing task", completed: true, status: "completed" }] }],
    ]);
    const legacy = builder.build(nativeId, cwd, items);
    const first = await store.save(legacy);
    assert.equal(first.version, 2);
    assert.equal(Object.hasOwn(reference(first), "items"), false);
    assert.deepEqual(await new FileSnapshotStore(directory).load(first), legacy.data);
    const files = await readdir(join(directory, "rows"));
    const before = await Promise.all(files.map(async (file) => ({ file, mtime: (await stat(join(directory, "rows", file))).mtimeMs })));
    items.set("answer", { type: "assistant_message", id: "answer", text: "A new response" });
    const firstManifest = (await readdir(join(directory, "snapshots")))[0];
    const originalManifest = await readFile(join(directory, "snapshots", firstManifest), "utf8");
    const second = await store.save(builder.build(nativeId, cwd, items), first);
    assert.equal(reference(first).snapshotKey, reference(second).snapshotKey, "A cached host handle must reach later background checkpoints");
    assert.equal((await readdir(join(directory, "rows"))).length, 4);
    for (const { file, mtime } of before) assert.equal((await stat(join(directory, "rows", file))).mtimeMs, mtime);
    assert.deepEqual(await store.load(first), await store.load(second), "A cached handle must resolve the latest observed state");
    assert.equal(await readFile(join(directory, "snapshots", firstManifest), "utf8"), originalManifest, "Earlier manifests remain immutable");
    assert.equal((await store.load(second)).items[1].type, "assistant_message");
    if (process.platform !== "win32") {
      assert.equal((await stat(join(directory, "rows", files[0]))).mode & 0o777, 0o600);
      assert.equal((await stat(join(directory, "rows"))).mode & 0o777, 0o700);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("v1 empty persistence remains empty without historical reconstruction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "droid-empty-state-"));
  try {
    const store = new FileSnapshotStore(directory);
    const old: ProviderPersistence = { version: 1, data: { nativeSessionId: nativeId, cwd, items: [] } };
    assert.deepEqual((await store.load(old)).items, []);
    assert.deepEqual((await store.load(await store.save(old))).items, []);
    await assert.rejects(store.load({ ...old, version: 99 }), /Unsupported/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("missing, corrupt and identity-mismatched snapshots fail without empty-state fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "droid-damaged-state-"));
  try {
    const store = new FileSnapshotStore(directory);
    const original = await store.save({ version: 1, data: { nativeSessionId: nativeId, cwd, items: [{ type: "assistant_message", id: "answer", text: "Keep this" }] } });
    await assert.rejects(store.load({ ...original, data: { ...reference(original), cwd: "/another-project" } }), /missing, damaged, or belongs/);
    await assert.rejects(store.load({ ...original, data: { ...reference(original), snapshotKey: "0".repeat(64) } }), /missing, damaged/);
    await assert.rejects(store.load({ ...original, data: { ...reference(original), snapshotKey: "../../private" } }));
    const rows = await readdir(join(directory, "rows"));
    await writeFile(join(directory, "rows", rows[0]), "{}", "utf8");
    await assert.rejects(new FileSnapshotStore(directory).load(original), /missing, damaged/);
    assert.ok((await readFile(join(directory, "heads", `${reference(original).snapshotKey}.json`), "utf8")).includes(nativeId));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a failed write leaves a previous durable reference readable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "droid-failed-state-"));
  try {
    const store = new FileSnapshotStore(directory);
    const legacy: ProviderPersistence = { version: 1, data: { nativeSessionId: nativeId, cwd, items: [] } };
    const previous = await store.save(legacy);
    const blocked = join(directory, "not-a-directory");
    await writeFile(blocked, "existing file");
    await assert.rejects(new FileSnapshotStore(blocked).save(legacy));
    assert.deepEqual((await store.load(previous)).items, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("1,000 and 10,000-row histories keep a sub-2-KiB reference and replay completely", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "droid-large-state-"));
  try {
    const store = new FileSnapshotStore(directory);
    const builder = new TimelinePersistence();
    const items = new Map<string, ProviderTimelineItem>();
    for (const count of [1000, 10000]) {
      for (let i = items.size; i < count; i++) items.set(`row:${i}`, { type: "assistant_message", id: `row:${i}`, text: `Response ${i}` });
      const handle = await store.save(builder.build(nativeId, cwd, items));
      assert.ok(Buffer.byteLength(JSON.stringify(handle)) < 2048);
      t.diagnostic(`${count} rows: ${Buffer.byteLength(JSON.stringify(handle))}-byte persistence reference`);
      const restored = await new FileSnapshotStore(directory).load(handle);
      assert.equal(restored.items.length, count);
      assert.deepEqual(restored.items, [...items.values()]);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

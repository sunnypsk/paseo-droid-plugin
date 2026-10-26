import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSession, resumeSession, listModels } from "@factory/droid-sdk/node";
import { ProviderEventSchema, type ProviderEvent } from "@getpaseo/plugin/server/provider";
import { createDroidProvider, supported } from "./provider";
import { createDroidTransport } from "./transport";
import { FileSnapshotStore } from "./snapshot-store";

test("real SDK and process transport retain notifications after the first stream ends", async () => {
  const directory = await mkdtemp(join(tmpdir(), "droid-real-sdk-"));
  const store = new FileSnapshotStore(join(directory, "state"));
  const connection = await createDroidProvider({ createSession, resumeSession, listModels, transport: createDroidTransport,
    snapshotStore: store, usageReplayDelaysMs: [] }).connect({ versions: [1], capabilities: supported, launch: {
    command: process.execPath, args: [fileURLToPath(new URL("./fixtures/fake-droid.mjs", import.meta.url))], env: { DROID_FAKE_BACKGROUND_DELAY_MS: "100" },
  } });
  const events: ProviderEvent[] = [];
  let check = () => {};
  connection.onEvent((event) => { ProviderEventSchema.parse(event); events.push(event); check(); });
  function wait(predicate: () => boolean) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Synthetic SDK flow timed out: ${events.map((e) => e.type === "request.failed" ? JSON.stringify(e) : e.type).join(", ")}`)), 5000);
      check = () => { if (predicate()) { clearTimeout(timer); resolve(); } };
      check();
    });
  }
  try {
    await connection.send({ type: "session.open", requestId: "open", sessionId: "test", history: "replay",
      config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: true, model: "test-model", mode: "ask" } });
    await wait(() => events.some((e) => e.type === "session.ready"));
    await connection.send({ type: "session.prompt", sessionId: "test", prompt: { clientMessageId: "synthetic-prompt", delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "Synthetic background regression" }] } } });
    await wait(() => events.filter((e) => e.type === "session.turn" && e.state === "completed").length === 2);
    assert.equal(events.filter((e) => e.type === "session.prompt_result").length, 1);
    assert.equal(events.filter((e) => e.type === "session.turn" && e.state === "started").length, 2);
    const saved = events.findLast((e) => e.type === "session.persistence");
    assert.ok(saved?.type === "session.persistence");
    const snapshot = await store.load(saved.persistence);
    assert.equal(snapshot.items.filter((i) => i.type === "assistant_message" && i.text === "Background report: all synthetic checks finished.").length, 1);
    const glob = snapshot.items.find((i) => i.type === "tool_call" && i.name === "Glob");
    assert.ok(glob?.type === "tool_call" && glob.detail.type === "search");
    assert.equal(glob.detail.query, "src/**/*.ts, docs/**/*.md (in /synthetic/project)");
    assert.equal(snapshot.items.find((i) => i.type === "todo")?.type, "todo");
    assert.ok(Buffer.byteLength(JSON.stringify(saved.persistence)) < 2048);
    const cached = events.find((e) => e.type === "session.persistence");
    assert.ok(cached?.type === "session.persistence");
    assert.deepEqual(await store.load(cached.persistence), snapshot, "The foreground handle cached by Paseo must resolve later background work");
    await connection.send({ type: "session.close", requestId: "close", sessionId: "test" });
    await wait(() => events.some((e) => e.type === "session.closed"));
    const before = events.length;
    await connection.send({ type: "session.open", requestId: "reopen", sessionId: "resumed", history: "replay", persistence: cached.persistence,
      config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: true, model: "test-model", mode: "ask" } });
    await wait(() => events.slice(before).some((e) => e.type === "session.ready"));
    assert.equal(events.slice(before).filter((e) => e.type === "timeline.item" && e.item.type === "assistant_message" && e.item.text === "Background report: all synthetic checks finished.").length, 1);
    assert.equal(events.slice(before).filter((e) => e.type === "session.prompt_result").length, 0, "Reload must not run another model turn");
  } finally { await connection.close(); await rm(directory, { recursive: true, force: true }); }
});

test("real SDK executes discovered commands and resumes the successor after compact without another model stream", async () => {
  const directory = await mkdtemp(join(tmpdir(), "droid-sdk-commands-"));
  const store = new FileSnapshotStore(join(directory, "state"));
  const connection = await createDroidProvider({ createSession, resumeSession, listModels, transport: createDroidTransport,
    limits: async () => "Synthetic Factory quota: 80% remaining", snapshotStore: store, usageReplayDelaysMs: [] }).connect({
    versions: [1], capabilities: supported, launch: {
      command: process.execPath, args: [fileURLToPath(new URL("./fixtures/fake-droid.mjs", import.meta.url))],
      env: { DROID_FAKE_BACKGROUND_DISABLED: "1", DROID_FAKE_COMMAND_ECHO: "1" },
    },
  });
  const events: ProviderEvent[] = [];
  const checks = new Set<() => void>();
  connection.onEvent((event) => { ProviderEventSchema.parse(event); events.push(event); for (const check of [...checks]) check(); });
  function wait(predicate: () => boolean) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { checks.delete(check); reject(new Error("Synthetic SDK command test timed out")); }, 5000);
      const check = () => { if (predicate()) { clearTimeout(timer); checks.delete(check); resolve(); } };
      checks.add(check); check();
    });
  }
  const config = { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: true, model: "test-model", mode: "ask" };
  async function command(name: string, args = "") {
    await connection.send({ type: "session.prompt", sessionId: "test", prompt: { clientMessageId: name,
      delivery: "auto", input: { type: "command", name, arguments: args } } });
    await wait(() => events.some((event) => event.type === "session.prompt_result" && event.clientMessageId === name));
    const result = events.find((event) => event.type === "session.prompt_result" && event.clientMessageId === name);
    assert.ok(result?.type === "session.prompt_result" && result.result.type !== "failed", JSON.stringify(result));
    if (result.result.type === "turn") {
      const turnId = result.result.turnId;
      await wait(() => events.some((event) => event.type === "session.turn" && event.turnId === turnId && event.state === "completed"));
    }
  }
  try {
    await connection.send({ type: "session.open", requestId: "open", sessionId: "test", history: "replay", config });
    await wait(() => events.some((event) => event.type === "session.ready"));
    const initial = events.find((event) => event.type === "session.opened");
    assert.ok(initial?.type === "session.opened");
    const commands = events.find((event) => event.type === "session.commands");
    assert.deepEqual(commands?.type === "session.commands" && commands.commands.map((entry) => entry.name),
      ["compact", "context", "limits", "native-review", "native-skill"]);
    await command("native-review", '"feature/a b" --literal');
    assert.ok(events.some((event) => event.type === "timeline.item" && event.item.type === "assistant_message" &&
      event.item.text === 'Native received: /native-review "feature/a b" --literal'));
    for (const name of ["context", "limits", "compact"]) await command(name);
    const compacted = events.findLast((event) => event.type === "session.persistence");
    assert.ok(compacted?.type === "session.persistence");
    assert.notEqual((compacted.persistence.data as { nativeSessionId: string }).nativeSessionId,
      (initial.persistence!.data as { nativeSessionId: string }).nativeSessionId);
    await command("native-skill");
    await connection.send({ type: "session.close", requestId: "close", sessionId: "test" });
    await wait(() => events.some((event) => event.type === "session.closed"));
    const before = events.length;
    await connection.send({ type: "session.open", requestId: "resume", sessionId: "resumed", history: "replay", persistence: compacted.persistence, config });
    await wait(() => events.slice(before).some((event) => event.type === "session.ready"));
    assert.equal(events.slice(before).some((event) => event.type === "session.turn"), false);
    assert.ok(events.slice(before).some((event) => event.type === "timeline.item" && event.item.type === "assistant_message" &&
      event.item.text === "Native received: /native-skill"));
  } finally { await connection.close(); await rm(directory, { recursive: true, force: true }); }
});

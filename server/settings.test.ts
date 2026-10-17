import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AutonomyLevel, DroidInteractionMode, ReasoningEffort,
  type DroidSessionUpdateSettingsOptions, type SessionSettings,
} from "@factory/droid-sdk/node";
import type { ProviderConfigChanges } from "@getpaseo/plugin/server/provider";
import { DroidSettingsTimeoutError, updateSessionSettings } from "./settings";

function fake() {
  let connected = true;
  let closeCalls = 0;
  const calls: DroidSessionUpdateSettingsOptions[] = [];
  let update: (changes: DroidSessionUpdateSettingsOptions) => Promise<Record<string, never>> = async () => ({});
  const settings: SessionSettings = {
    modelId: "test-model", reasoningEffort: ReasoningEffort.Medium,
    interactionMode: DroidInteractionMode.Auto, autonomyLevel: AutonomyLevel.Off,
  };
  const native = {
    settings,
    async updateSettings(changes: DroidSessionUpdateSettingsOptions) {
      if (!connected) throw new Error("Transport closed");
      calls.push(changes);
      return update(changes);
    },
    async *stream() {
      if (!connected) throw new Error("Transport closed");
      yield { type: "result", success: true };
    },
  };
  const transport = { async close() { closeCalls++; connected = false; } };
  return { native, transport, calls, onUpdate(fn: typeof update) { update = fn; }, closeCalls: () => closeCalls, connected: () => connected };
}

test("an ordinary native settings rejection preserves subsequent prompts and settings changes", async () => {
  const f = fake();
  const rejection = new Error("Model setting was rejected by native RPC");
  f.onUpdate(async () => { throw rejection; });
  await assert.rejects(updateSessionSettings(f.native, f.transport, { model: "stale-model" }), (error) => error === rejection);
  assert.equal(f.connected(), true);
  assert.equal(f.closeCalls(), 0);
  const messages = [];
  for await (const message of f.native.stream()) messages.push(message);
  assert.deepEqual(messages, [{ type: "result", success: true }]);

  f.onUpdate(async () => ({}));
  await updateSessionSettings(f.native, f.transport, { model: "valid-model", mode: "spec", thinkingOption: "high" });
  assert.deepEqual(f.calls.at(-1), {
    modelId: "valid-model", reasoningEffort: ReasoningEffort.High,
    interactionMode: DroidInteractionMode.Spec, autonomyLevel: AutonomyLevel.Off,
  });
  assert.equal(f.closeCalls(), 0);
});

test("invalid picker values and restricted modes fail locally without sending or closing", async () => {
  const f = fake();
  f.native.settings.availableAutonomyLevels = [AutonomyLevel.Low];
  for (const [changes, message] of [
    [{ thinkingOption: "removed-effort" }, /Unknown Droid reasoning effort/],
    [{ mode: "removed-mode" }, /Unknown Droid mode/],
    [{ mode: "" }, /Unknown Droid mode/],
    [{ mode: "auto-high" }, /organization policy/],
    [{ mode: "ask" }, /organization policy/],
    [{ mode: "spec" }, /organization policy/],
    [{ settings: { unknown: true } }, /Unknown Droid setting/],
  ] satisfies Array<[ProviderConfigChanges, RegExp]>) {
    await assert.rejects(updateSessionSettings(f.native, f.transport, changes), message);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.connected(), true);
  assert.equal(f.closeCalls(), 0);
  await updateSessionSettings(f.native, f.transport, { mode: "auto-low" });
  assert.equal(f.calls.length, 1);
});

test("a settings deadline closes an uncertain connection and ignores a late RPC response", async () => {
  const f = fake();
  let finish!: (result: Record<string, never>) => void;
  f.onUpdate(() => new Promise((resolve) => { finish = resolve; }));
  await assert.rejects(updateSessionSettings(f.native, f.transport, { mode: "spec" }, 5), DroidSettingsTimeoutError);
  assert.equal(f.closeCalls(), 1);
  assert.equal(f.connected(), false);
  finish({});
  await assert.rejects(updateSessionSettings(f.native, f.transport, { mode: "ask" }), /Transport closed/);
  assert.equal(f.closeCalls(), 1, "A subsequent rejection must not attempt another timeout teardown");
});

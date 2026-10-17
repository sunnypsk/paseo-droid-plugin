import assert from "node:assert/strict";
import { test } from "node:test";
import { AutonomyLevel, DroidInteractionMode, ReasoningEffort, type ModelInfo, type SessionSettings } from "@factory/droid-sdk/node";
import { configState, presentCatalog, sessionModes } from "./catalog";

function model(tokenMultiplier?: number, displayName = "GPT-6.1 Sol"): ModelInfo {
  return { id: "gpt-6.1-sol", displayName, supportedReasoningEfforts: [], disabled: false, tokenMultiplier } as unknown as ModelInfo;
}

test("model selector labels show the reported multiplier and preserve the original catalog identity", () => {
  for (const multiplier of [0, 0.5, 1, 1.25, 5]) {
    const entry = presentCatalog([model(multiplier)]).models[0];
    assert.equal(entry.id, "gpt-6.1-sol");
    assert.equal(entry.label, `GPT-6.1 Sol · ${multiplier}×`);
    assert.equal(entry.metadata?.displayName, "GPT-6.1 Sol");
    assert.equal(entry.metadata?.tokenMultiplier, multiplier);
    assert.equal(entry.contextWindowMaxTokens, undefined, "The catalog does not report a context limit");
  }
});

test("missing or invalid multipliers never invent a price or leak non-JSON values into metadata", () => {
  for (const multiplier of [undefined, -1, NaN, Infinity, -Infinity]) {
    const entry = presentCatalog([model(multiplier)]).models[0];
    assert.equal(entry.label, "GPT-6.1 Sol");
    assert.equal(entry.metadata?.displayName, "GPT-6.1 Sol");
    assert.equal(Object.hasOwn(entry.metadata ?? {}, "tokenMultiplier"), false);
  }
  const disabled = { ...model(1), disabled: true as const, disabledReason: "Unavailable" };
  assert.equal(presentCatalog([disabled]).models.length, 0);
});

test("session mode picker follows organization autonomy availability, including Ask and Spec", () => {
  for (const [levels, expected] of [
    [undefined, ["ask", "spec", "auto-low", "auto-medium", "auto-high"]],
    [[AutonomyLevel.Off, AutonomyLevel.Low], ["ask", "spec", "auto-low"]],
    [[AutonomyLevel.Medium], ["auto-medium"]],
    [[], []],
  ] as const) {
    const settings: SessionSettings = {
      modelId: "gpt-6.1-sol", reasoningEffort: ReasoningEffort.Medium,
      interactionMode: DroidInteractionMode.Auto, autonomyLevel: AutonomyLevel.Low,
      availableAutonomyLevels: levels === undefined ? undefined : [...levels],
    };
    assert.deepEqual(sessionModes(settings).map((mode) => mode.id), expected);
    const state = configState({ settings }, presentCatalog([model(1)]));
    assert.deepEqual(state.modes.map((mode) => mode.id), expected);
    assert.equal(state.mode, "auto-low", "Report the actual native mode even if policy has just changed");
  }
});

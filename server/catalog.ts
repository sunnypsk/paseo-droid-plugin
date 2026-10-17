import {
  AutonomyLevel,
  DroidInteractionMode,
  ReasoningEffort,
  type DroidSession,
  type ModelInfo,
} from "@factory/droid-sdk/node";
import type { ProviderCatalog, ProviderConfigState } from "@getpaseo/plugin/server/provider";

export const modes = [
  { id: "ask", label: "Ask", description: "Ask before actions" },
  { id: "spec", label: "Spec", description: "Plan before implementation" },
  { id: "auto-low", label: "Auto low", description: "File edits and read-only commands" },
  { id: "auto-medium", label: "Auto medium", description: "Reversible development commands" },
  { id: "auto-high", label: "Auto high", description: "Commands without approval prompts", isUnattended: true },
];

export function modeSettings(mode = "ask") {
  if (!modes.some((entry) => entry.id === mode)) throw new Error(`Unknown Droid mode: ${mode}`);
  return {
    interactionMode: mode === "spec" ? DroidInteractionMode.Spec : DroidInteractionMode.Auto,
    autonomyLevel: mode === "auto-low" ? AutonomyLevel.Low
      : mode === "auto-medium" ? AutonomyLevel.Medium
      : mode === "auto-high" ? AutonomyLevel.High : AutonomyLevel.Off,
  };
}

/** Honor the session's organization policy; older CLI versions omit this list. */
export function sessionModes(settings: Pick<DroidSession["settings"], "availableAutonomyLevels">) {
  const levels = settings.availableAutonomyLevels;
  return levels === undefined ? modes : modes.filter((entry) => levels.includes(modeSettings(entry.id).autonomyLevel));
}

export function reasoning(value?: string): ReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (!Object.values(ReasoningEffort).includes(value as ReasoningEffort))
    throw new Error(`Unknown Droid reasoning effort: ${value}`);
  return value as ReasoningEffort;
}

export function presentCatalog(models: ModelInfo[]): ProviderCatalog {
  return {
    models: models.filter((model) => !model.disabled).map((model) => {
      const multiplier = typeof model.tokenMultiplier === "number" && Number.isFinite(model.tokenMultiplier) && model.tokenMultiplier >= 0
        ? model.tokenMultiplier : undefined;
      return {
        id: model.id,
        label: multiplier === undefined ? model.displayName : `${model.displayName} · ${multiplier}×`,
        thinkingOptions: model.supportedReasoningEfforts.map((id) => ({ id, label: id })),
        defaultThinkingOptionId: model.defaultReasoningEffort,
        metadata: {
          displayName: model.displayName,
          noImageSupport: model.noImageSupport ?? false,
          ...(multiplier === undefined ? {} : { tokenMultiplier: multiplier }),
        },
      };
    }),
    modes,
    defaultMode: "ask",
  };
}

export function configState(native: Pick<DroidSession, "settings">, catalog: ProviderCatalog): ProviderConfigState {
  const settings = native.settings;
  const mode = settings.interactionMode === DroidInteractionMode.Spec ? "spec"
    : settings.autonomyLevel === AutonomyLevel.Off ? "ask" : `auto-${settings.autonomyLevel}`;
  const model = catalog.models.find((entry) => entry.id === settings.modelId);
  return {
    model: settings.modelId,
    mode,
    thinkingOption: settings.reasoningEffort,
    models: catalog.models,
    modes: sessionModes(settings),
    thinkingOptions: model?.thinkingOptions ?? [],
    settings: [],
  };
}

import type { DroidSession, StringFramedDroidClientTransport } from "@factory/droid-sdk/node";
import type { ProviderConfigChanges } from "@getpaseo/plugin/server/provider";
import { modeSettings, reasoning, sessionModes } from "./catalog";

export class DroidSettingsTimeoutError extends Error {
  constructor() {
    super("Droid settings update timed out; the connection was closed. Reopen the conversation before retrying.");
    this.name = "DroidSettingsTimeoutError";
  }
}

/** A rejected setting is recoverable. Only an uncertain timed-out update closes its transport. */
export async function updateSessionSettings(
  native: Pick<DroidSession, "settings" | "updateSettings">,
  transport: Pick<StringFramedDroidClientTransport, "close">,
  changes: ProviderConfigChanges,
  timeoutMs = 30_000,
): Promise<void> {
  if (changes.settings && Object.keys(changes.settings).length) throw new Error("Unknown Droid setting");
  // Validate locally before starting the RPC or its deadline. A stale picker must
  // never turn a validation failure into a subprocess teardown.
  const effort = reasoning(changes.thinkingOption ?? undefined);
  const requestedMode = changes.mode ?? undefined;
  const mode = requestedMode === undefined ? undefined : modeSettings(requestedMode);
  if (mode && !sessionModes(native.settings).some((entry) => entry.id === changes.mode)) {
    throw new Error(`Droid mode "${changes.mode}" is unavailable under the current session's organization policy. Choose an available mode.`);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      native.updateSettings({ modelId: changes.model ?? undefined, reasoningEffort: effort, ...mode }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new DroidSettingsTimeoutError());
        }, Math.max(1, timeoutMs));
      }),
    ]);
  } catch (error) {
    if (timedOut) await transport.close().catch(() => {});
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

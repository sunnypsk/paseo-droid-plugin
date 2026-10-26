import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  FACTORY_PROTOCOL_VERSION, LEGACY_FACTORY_API_VERSION,
  type ListSkillsResult, type StringFramedDroidClientTransport,
} from "@factory/droid-sdk/node";
import type { ProviderCommand, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import type { UsageReport } from "@getpaseo/plugin/server/usage";
import { createDroidUsageSource } from "./usage";

export const builtinCommands: readonly ProviderCommand[] = [
  { name: "compact", description: "Summarize the conversation", argumentHint: "[instructions]" },
  { name: "context", description: "Show native context usage and breakdown" },
  { name: "limits", description: "Show Factory account quota for this session" },
];
const commandName = z.string().min(1).max(256).regex(/^[^\s/\\]+$/);
const customCommandSchema = z.object({
  name: commandName, description: z.string(), argumentHint: z.string().optional(), isExecutable: z.boolean().optional(),
});
export type NativeCommand = z.infer<typeof customCommandSchema>;
const count = z.number().finite().nonnegative();
const contextBreakdownSchema = z.object({
  modelId: z.string(), modelDisplayName: z.string(), contextBudget: count, usedTokens: count, freeTokens: count,
  categories: z.array(z.object({ name: z.string(), tokens: count })),
});
export type ContextBreakdown = z.infer<typeof contextBreakdownSchema>;
const responseSchema = z.object({
  jsonrpc: z.literal("2.0"), type: z.literal("response"), id: z.string(),
  factoryApiVersion: z.literal(LEGACY_FACTORY_API_VERSION), factoryProtocolVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  result: z.unknown().optional(), error: z.object({ code: z.number(), message: z.string() }).optional(),
}).refine((value) => Object.hasOwn(value, "result") !== !!value.error);

export interface CommandReadOptions { signal?: AbortSignal; timeoutMs?: number }
export interface DroidCommandTransport {
  transport: StringFramedDroidClientTransport;
  list(options?: CommandReadOptions): Promise<NativeCommand[]>;
  context(options?: CommandReadOptions): Promise<ContextBreakdown>;
}

/** Only read-only RPCs missing from DroidSession. Never creates a second SDK client. */
export function createCommandTransport(base: StringFramedDroidClientTransport): DroidCommandTransport {
  const prefix = `paseo-command:${randomUUID()}:`;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }>();
  let receive: ((frame: string) => void) | undefined;
  let receiveError: ((error: Error) => void) | undefined;
  let failure: Error | undefined;
  let errorNotified = false;
  let closing: Promise<void> | undefined;
  let startup: string[] = [];
  let startupBytes = 0;
  function settle(id: string, value?: unknown, error?: Error) {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    request.cleanup();
    if (error) request.reject(error); else request.resolve(value);
  }
  function notifyError() {
    if (!failure || !receiveError || errorNotified) return;
    errorNotified = true;
    try { receiveError(failure); } catch { /* Pending reads and process cleanup still complete. */ }
  }
  function fail(error: Error) {
    failure ??= error;
    for (const id of [...pending.keys()]) settle(id, undefined, failure);
    startup = [];
    startupBytes = 0;
    notifyError();
  }
  const transport: StringFramedDroidClientTransport = {
    get isConnected() { return !failure && base.isConnected; },
    async send(frame) { if (failure) throw failure; await base.send(frame); },
    onMessage(handler) {
      receive = handler;
      const frames = startup;
      startup = [];
      startupBytes = 0;
      for (const frame of frames) handler(frame);
    },
    onError(handler) { receiveError = handler; notifyError(); },
    close() {
      if (closing) return closing;
      closing = Promise.resolve().then(() => base.close());
      fail(new Error("Droid command transport was closed."));
      return closing;
    },
  };
  base.onMessage((frame) => {
    if (failure) return;
    let value: unknown;
    try { value = JSON.parse(frame); } catch { /* Unrelated invalid frames belong to the SDK. */ }
    if (value && typeof value === "object" && "id" in value && typeof value.id === "string" && value.id.startsWith(prefix) &&
        ("result" in value || "error" in value)) {
      const parsed = responseSchema.safeParse(value);
      if (!parsed.success) settle(value.id, undefined, new Error("Droid returned an invalid command response."));
      else if (parsed.data.error) settle(value.id, undefined, new Error(`Droid command request failed (code ${parsed.data.error.code}).`));
      else settle(value.id, parsed.data.result);
      return; // Includes late replies after cancellation/timeout.
    }
    if (receive) receive(frame);
    else {
      startupBytes += Buffer.byteLength(frame);
      if (startupBytes > 32 * 1024 * 1024) {
        fail(new Error("Droid command startup buffer exceeded its limit."));
        void transport.close();
      } else startup.push(frame);
    }
  });
  base.onError(fail);
  async function read(method: string, options: CommandReadOptions = {}): Promise<unknown> {
    if (failure) throw failure;
    if (!base.isConnected) throw new Error("Droid command transport is not connected.");
    options.signal?.throwIfAborted();
    const id = `${prefix}${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const abort = () => settle(id, undefined, new Error("Droid command request canceled."));
      const timer = setTimeout(() => settle(id, undefined, new Error("Droid command request timed out.")), options.timeoutMs ?? 5000);
      pending.set(id, { resolve, reject, cleanup() { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); } });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) { abort(); return; }
      void Promise.resolve().then(() => pending.has(id) ? base.send(JSON.stringify({
        jsonrpc: "2.0", type: "request", factoryApiVersion: LEGACY_FACTORY_API_VERSION,
        factoryProtocolVersion: FACTORY_PROTOCOL_VERSION, id, method, params: {},
      })) : undefined).catch(() => settle(id, undefined, new Error("Could not send the Droid command request.")));
    });
  }
  return {
    transport,
    async list(options) { return z.object({ commands: z.array(customCommandSchema) }).parse(await read("droid.list_commands", options)).commands; },
    async context(options) { return contextBreakdownSchema.parse(await read("droid.get_context_breakdown", options)); },
  };
}

export function presentCommands(custom: readonly NativeCommand[], skills: ListSkillsResult["skills"], disableBuiltinSkills = false): ProviderCommand[] {
  const commands = new Map(builtinCommands.map((entry) => [entry.name, { ...entry }]));
  for (const entry of custom) {
    const key = entry.name.toLowerCase();
    if (commandName.safeParse(entry.name).success && !commands.has(key))
      commands.set(key, { name: entry.name, description: entry.description, ...(entry.argumentHint ? { argumentHint: entry.argumentHint } : {}) });
  }
  for (const skill of skills) {
    const key = skill.name.toLowerCase();
    if (skill.enabled === false || skill.userInvocable === false || skill.disabledBy ||
        (disableBuiltinSkills && skill.location === "builtin") || !commandName.safeParse(skill.name).success || commands.has(key)) continue;
    commands.set(key, { name: skill.name, description: skill.description ?? "Run this Droid skill" });
  }
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Paseo sends steering as text even when a user selected a slash command. */
export function selectedCommand(request: ProviderPrompt, commands: readonly ProviderCommand[]): { name: string; arguments: string } | undefined {
  if (request.input.type === "command") return request.input;
  if (request.input.content.length !== 1 || request.input.content[0].type !== "text") return;
  const match = /^\/([^\s/\\]+)(?:\s([\s\S]*))?$/.exec(request.input.content[0].text.trimStart());
  if (!match) return;
  const found = commands.find((entry) => entry.name.toLowerCase() === match[1].toLowerCase());
  if (found) return { name: found.name, arguments: match[2] ?? "" };
}

const number = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 1 });
export function formatContext(value: ContextBreakdown): string {
  return [`Context · ${value.modelDisplayName}`, `Used: ${number(value.usedTokens)} / ${number(value.contextBudget)} tokens`,
    `Free: ${number(value.freeTokens)} tokens`, ...value.categories.map((entry) => `${entry.name}: ${number(entry.tokens)} tokens`)].join("\n");
}
export function formatLimits(report: UsageReport): string {
  if (report.status === "error") return `Factory quota unavailable: ${report.error}`;
  if (report.status === "unavailable") {
    const problem = report.problem;
    return problem.kind === "no_quota" ? `Factory quota unavailable: ${problem.detail}`
      : problem.kind === "expired" ? "Factory access token has expired. Open Droid to refresh it, then retry /limits."
      : "Factory rejected this session's login. Sign in with Droid and retry /limits.";
  }
  return ["Factory account quota", ...report.windows.map((window) => [window.label,
    window.usedPct == null ? undefined : `${number(window.usedPct)}% used`,
    window.remainingPct == null ? undefined : `${number(window.remainingPct)}% remaining`,
    window.resetsAt ? `resets ${window.resetsAt}` : undefined].filter(Boolean).join(" · ")),
    ...(report.balances ?? []).map((balance) => `${balance.label}: ${balance.remaining == null ? "unreported" : number(balance.remaining)} ${balance.unit} remaining`),
    ...(report.details ?? []).map((detail) => `${detail.label}: ${detail.value}`)].join("\n");
}
export async function readSessionLimits(env: Readonly<Record<string, string>>, source = createDroidUsageSource()): Promise<string> {
  // Windows CLI login uses USERPROFILE when HOME is absent. This is still the
  // launch's explicit home, never a fallback to the plugin process's account.
  const scopedEnv = process.platform === "win32" && !env.HOME && env.USERPROFILE ? { ...env, HOME: env.USERPROFILE } : env;
  const accounts = await source.discover({ kind: "session", provider: "droid-native", env: scopedEnv });
  if (!accounts.length) return "Factory account quota is unavailable for this session's authentication or backend.";
  return formatLimits(await source.fetch(accounts[0].input));
}

export function supportsCommands(version: string | undefined): boolean {
  const match = version && /\b(\d+)\.(\d+)\.(\d+)\b/.exec(version);
  return !!match && (Number(match[1]) > 0 || Number(match[2]) >= 249);
}

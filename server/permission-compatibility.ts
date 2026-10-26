import { createHash } from "node:crypto";
import { z } from "zod";
import {
  FACTORY_PROTOCOL_VERSION,
  LEGACY_FACTORY_API_VERSION,
  RequestPermissionRequestSchema,
  RequestPermissionResponseSchema,
  ToolConfirmationDetailsSchema,
  ToolConfirmationInfoSchema,
  ToolConfirmationOutcome,
  ToolUseSchema,
  TraceContextMetaSchema,
  type RequestPermissionHandlerResult,
  type StringFramedDroidClientTransport,
  type ToolConfirmationDetails,
  type ToolConfirmationInfo,
  type TraceContextMeta,
} from "@factory/droid-sdk/node";

// The SDK uses Zod 3. Validate its existing types without mixing Zod versions,
// and reject fields its strip-mode schemas would otherwise silently discard.
function sdkValue<T>(schema: { safeParse(value: unknown): { success: false } | { success: true; data: T } }) {
  return z.custom<T>((value) => {
    const parsed = schema.safeParse(value);
    return parsed.success && retainsFields(value, parsed.data);
  });
}

function retainsFields(input: unknown, parsed: unknown): boolean {
  if (Array.isArray(input)) return Array.isArray(parsed) && input.every((item, index) => retainsFields(item, parsed[index]));
  if (input && typeof input === "object") {
    if (!parsed || typeof parsed !== "object") return false;
    return Object.entries(input).every(([key, value]) =>
      Object.hasOwn(parsed, key) && retainsFields(value, (parsed as Record<string, unknown>)[key]));
  }
  return true;
}

const scriptConfirmationDetailsSchema = z.strictObject({
  type: z.literal("script"),
  impactLevel: z.string(),
  calls: z.array(z.strictObject({
    toolName: z.string(),
    line: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    toolInput: z.record(z.string(), z.json()),
    // Deliberately nonrecursive. New native recommend_mission confirmations
    // are outside this compatibility bridge and must receive no approval.
    confirmation: sdkValue<ToolConfirmationDetails>(ToolConfirmationDetailsSchema),
    alwaysAsk: z.boolean().optional(),
  })).min(1),
});

export type ScriptConfirmationDetails = z.infer<typeof scriptConfirmationDetailsSchema>;

const scriptToolConfirmationInfoSchema = z.strictObject({
  toolUse: sdkValue<ToolConfirmationInfo["toolUse"]>(ToolUseSchema),
  confirmationType: z.literal("script"),
  details: scriptConfirmationDetailsSchema,
});

export type ScriptToolConfirmationInfo = z.infer<typeof scriptToolConfirmationInfoSchema>;
export type ScriptPermissionToolUse = ToolConfirmationInfo | ScriptToolConfirmationInfo;

export const scriptPermissionParamsSchema = z.strictObject({
  toolUses: z.array(z.union([
    scriptToolConfirmationInfoSchema,
    sdkValue<ToolConfirmationInfo>(ToolConfirmationInfoSchema),
  ])).min(1),
  options: z.array(z.strictObject({
    label: z.string(), value: z.enum(ToolConfirmationOutcome),
    // Native CLI option rows include theme colors and the Cancel prefix. These
    // are presentation strings, not permission outcomes or policy overrides.
    selectedColor: z.string().optional(),
    selectedPrefix: z.string().optional(),
  })).min(1),
  associatedSessionIds: z.array(z.string()).optional(),
}).refine((params) => params.toolUses.some((item) => item.confirmationType === "script"), {
  message: "A compatibility permission batch must contain a Script confirmation.",
});

export type ScriptPermissionParams = z.infer<typeof scriptPermissionParamsSchema>;
export type ScriptPermissionHandler = (params: ScriptPermissionParams) => RequestPermissionHandlerResult | Promise<RequestPermissionHandlerResult>;

// The receiving SDK and the sending CLI expose different protocol revisions.
// Pin both independently; accepting every future native revision would hide
// another potentially incompatible permission shape.
const SCRIPT_COMPAT_SDK_PROTOCOL_VERSION = "1.201.1";
const SCRIPT_COMPAT_NATIVE_PROTOCOL_VERSIONS = ["1.269.0", "1.272.0", "1.275.0"] as const;
const SCRIPT_COMPAT_API_VERSION = "1.0.0";
const scriptPermissionRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  factoryApiVersion: z.literal(SCRIPT_COMPAT_API_VERSION),
  factoryProtocolVersion: z.enum(SCRIPT_COMPAT_NATIVE_PROTOCOL_VERSIONS),
  _meta: sdkValue<TraceContextMeta>(TraceContextMetaSchema).optional(),
  type: z.literal("request"),
  id: z.string(),
  method: z.literal("droid.request_permission"),
  params: scriptPermissionParamsSchema,
});

const manualDecisionSchema = z.strictObject({
  selectedOption: z.enum([ToolConfirmationOutcome.ProceedOnce, ToolConfirmationOutcome.Cancel]),
  comment: z.string().optional(),
});

export interface PermissionCompatibilityTransport {
  transport: StringFramedDroidClientTransport;
  /** Retire owned requests before interrupt; late human responses are ignored. */
  cancelPending(): void;
}

const MAX_STARTUP_BYTES = 32 * 1024 * 1024;
const MAX_OWNED_IDS = 4096;
const MAX_PENDING = 128;

/**
 * Narrow wire compatibility for native Droid 0.244/0.245/0.249 Script confirmations absent
 * from SDK 0.9.1. Existing SDK requests retain their original bytes and handler.
 * Script requests always require a separate explicit Once/Cancel decision.
 */
export function createPermissionCompatibilityTransport(
  base: StringFramedDroidClientTransport,
  handler: ScriptPermissionHandler,
): PermissionCompatibilityTransport {
  const pending = new Map<string, { params: ScriptPermissionParams; protocolVersion: string }>();
  // Hashes retain no script/input data and keep duplicate IDs from reopening an
  // approval after interrupt or completion. Bound lifetime growth by closing.
  const seen = new Map<string, string>();
  let messageHandler: ((frame: string) => void) | undefined;
  let errorHandler: ((error: Error) => void) | undefined;
  let terminalError: Error | undefined;
  let errorNotified = false;
  let closePromise: Promise<void> | undefined;
  let startupFrames: string[] = [];
  let startupBytes = 0;

  function notifyError() {
    if (!terminalError || !errorHandler || errorNotified) return;
    errorNotified = true;
    try { errorHandler(terminalError); } catch { /* Still complete owned cleanup. */ }
  }

  function fail(error: Error) {
    terminalError ??= error;
    pending.clear();
    startupFrames = [];
    startupBytes = 0;
    notifyError();
  }

  function sendOwned(response: unknown) {
    const sendFailure = () => {
      fail(new Error("Could not send the Droid permission response."));
      void transport.close();
    };
    try { void base.send(JSON.stringify(response)).catch(sendFailure); }
    catch { sendFailure(); }
  }

  function envelope(id: string, protocolVersion: string = FACTORY_PROTOCOL_VERSION) {
    return {
      jsonrpc: "2.0", factoryApiVersion: LEGACY_FACTORY_API_VERSION,
      factoryProtocolVersion: protocolVersion, type: "response", id,
    };
  }

  function rejectRequest(id: string) {
    sendOwned(RequestPermissionResponseSchema.parse({
      ...envelope(id), error: { code: -32602, message: "Unsupported Droid permission request." },
    }));
  }

  function respond(id: string, decision: unknown) {
    const request = pending.get(id);
    if (!request || terminalError) return;
    const { params, protocolVersion } = request;
    pending.delete(id);
    const parsed = manualDecisionSchema.safeParse(typeof decision === "string" ? { selectedOption: decision } : decision);
    const allowed = parsed.success && params.options.some((option) => option.value === parsed.data.selectedOption);
    if (allowed) {
      sendOwned(RequestPermissionResponseSchema.parse({ ...envelope(id, protocolVersion), result: parsed.data }));
    } else if (params.options.some((option) => option.value === ToolConfirmationOutcome.Cancel)) {
      sendOwned(RequestPermissionResponseSchema.parse({ ...envelope(id, protocolVersion), result: { selectedOption: ToolConfirmationOutcome.Cancel } }));
    } else rejectRequest(id);
  }

  function cancelPending() {
    for (const id of [...pending.keys()]) respond(id, ToolConfirmationOutcome.Cancel);
  }

  function forward(frame: string) {
    if (terminalError) return;
    if (messageHandler) messageHandler(frame);
    else {
      startupBytes += Buffer.byteLength(frame);
      if (startupBytes > MAX_STARTUP_BYTES) {
        fail(new Error("Droid permission compatibility startup buffer exceeded its limit."));
        void transport.close();
      } else startupFrames.push(frame);
    }
  }

  const transport: StringFramedDroidClientTransport = {
    get isConnected() { return !terminalError && base.isConnected; },
    async send(frame) {
      if (terminalError) throw terminalError;
      let request: unknown;
      try { request = JSON.parse(frame); } catch { /* SDK owns its outgoing frames. */ }
      if (isRecord(request) && request.type === "request" &&
          ["droid.interrupt_session", "droid.close_session", "droid.kill_worker_session"].includes(String(request.method))) {
        cancelPending();
      }
      await base.send(frame);
    },
    onMessage(callback) {
      messageHandler = callback;
      const frames = startupFrames;
      startupFrames = [];
      startupBytes = 0;
      for (const frame of frames) {
        if (terminalError) break;
        callback(frame);
      }
    },
    onError(callback) { errorHandler = callback; notifyError(); },
    close() {
      if (closePromise) return closePromise;
      closePromise = Promise.resolve().then(() => base.close());
      // Cancel sends are initiated before closing, without waiting on a stuck
      // pipe. The underlying process close remains the final fail-closed stop.
      cancelPending();
      fail(new Error("Droid permission compatibility transport was closed."));
      seen.clear();
      return closePromise;
    },
  };

  base.onMessage((frame) => {
    if (terminalError) return;
    let request: unknown;
    try { request = JSON.parse(frame); } catch { forward(frame); return; }
    if (!isRecord(request) || request.method !== "droid.request_permission" || request.type !== "request") {
      forward(frame); return;
    }
    const id = request.id;
    if (typeof id !== "string") {
      fail(new Error("Droid sent an uncorrelatable permission request."));
      void transport.close();
      return;
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const previous = seen.get(id);
    if (previous !== undefined) {
      if (previous !== fingerprint) {
        fail(new Error("Droid reused a permission request ID with different contents."));
        void transport.close();
      }
      return;
    }
    // Do not normalize, intercept, or constrain SDK-supported permissions.
    if (RequestPermissionRequestSchema.safeParse(request).success) {
      forward(frame); return;
    }
    if (seen.size >= MAX_OWNED_IDS || pending.size >= MAX_PENDING) {
      fail(new Error("Droid permission compatibility request limit exceeded."));
      void transport.close();
      return;
    }
    seen.set(id, fingerprint);
    const parsed = scriptPermissionRequestSchema.safeParse(request);
    const supportedSdk = FACTORY_PROTOCOL_VERSION === SCRIPT_COMPAT_SDK_PROTOCOL_VERSION &&
      LEGACY_FACTORY_API_VERSION === SCRIPT_COMPAT_API_VERSION;
    if (!supportedSdk || !parsed.success) { rejectRequest(id); return; }
    pending.set(id, { params: parsed.data.params, protocolVersion: parsed.data.factoryProtocolVersion });
    // Invoke asynchronously so a synchronous throw follows the same Cancel
    // path and the request is already owned before any callback can resolve it.
    void Promise.resolve().then(() => {
      if (!pending.has(id) || terminalError) return;
      return handler(parsed.data.params);
    }).then((decision) => respond(id, decision), () => respond(id, ToolConfirmationOutcome.Cancel));
  });
  base.onError((error) => fail(error));

  return { transport, cancelPending };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

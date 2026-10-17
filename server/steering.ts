import { randomUUID } from "node:crypto";
import {
  AddUserMessageRequestSchema,
  AddUserMessageResponseSchema,
  FACTORY_PROTOCOL_VERSION,
  LEGACY_FACTORY_API_VERSION,
  type MessageOptions,
  type StringFramedDroidClientTransport,
} from "@factory/droid-sdk/node";

export interface SteeringOptions extends Pick<MessageOptions, "images" | "files"> {
  messageId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** A native error response establishes rejection, unlike a missing ACK. */
export class SteeringRejectedError extends Error {
  constructor(readonly code: number) {
    super(`Droid rejected steering (code ${code}).`);
    this.name = "SteeringRejectedError";
  }
}

export interface DroidSteeringTransport {
  transport: StringFramedDroidClientTransport;
  /** Inject at the next model-turn boundary, within the current agent loop. */
  steer(text: string, options?: SteeringOptions): Promise<void>;
  /** Cancel local acknowledgment waits. Native interrupt stops the agent work. */
  cancelPending(reason?: Error): void;
}

interface PendingSteer {
  resolve(): void;
  reject(error: Error): void;
  cleanup(): void;
}

const MAX_STARTUP_BYTES = 32 * 1024 * 1024;

/**
 * Multiplex one additional public Factory request beside the high-level SDK.
 * The SDK continues to own sessions, permissions, notifications, and streaming.
 * Only responses to this wrapper's unique IDs are consumed here.
 */
export function createSteeringTransport(base: StringFramedDroidClientTransport): DroidSteeringTransport {
  const prefix = `paseo-steer:${randomUUID()}:`;
  const pending = new Map<string, PendingSteer>();
  let messageHandler: ((message: string) => void) | undefined;
  let errorHandler: ((error: Error) => void) | undefined;
  let terminalError: Error | undefined;
  let sdkErrorNotified = false;
  let closePromise: Promise<void> | undefined;
  let startupFrames: string[] = [];
  let startupBytes = 0;

  function notifySdkError() {
    if (!terminalError || !errorHandler || sdkErrorNotified) return;
    sdkErrorNotified = true;
    try { errorHandler(terminalError); } catch { /* Cleanup still belongs to us. */ }
  }

  function settle(id: string, error?: Error) {
    const operation = pending.get(id);
    if (!operation) return;
    pending.delete(id);
    operation.cleanup();
    if (error) operation.reject(error);
    else operation.resolve();
  }

  function cancelPending(reason = new Error("Droid steering acknowledgment canceled.")) {
    for (const id of [...pending.keys()]) settle(id, reason);
  }

  function fail(error: Error) {
    terminalError ??= error;
    cancelPending(terminalError);
    notifySdkError();
  }

  const transport: StringFramedDroidClientTransport = {
    get isConnected() { return !terminalError && base.isConnected; },
    async send(message) {
      if (terminalError) throw terminalError;
      await base.send(message);
    },
    onMessage(handler) {
      messageHandler = handler;
      const frames = startupFrames;
      startupFrames = [];
      startupBytes = 0;
      for (const frame of frames) handler(frame);
    },
    onError(handler) {
      errorHandler = handler;
      notifySdkError();
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = Promise.resolve().then(() => base.close());
      fail(new Error("Droid steering transport was closed."));
      startupFrames = [];
      startupBytes = 0;
      return closePromise;
    },
  };

  base.onMessage((frame) => {
    let envelope: unknown;
    try { envelope = JSON.parse(frame); } catch { /* SDK owns invalid frames. */ }
    if (envelope && typeof envelope === "object" && "id" in envelope &&
        typeof envelope.id === "string" && envelope.id.startsWith(prefix) &&
        ("result" in envelope || "error" in envelope)) {
      const id = envelope.id;
      const parsed = AddUserMessageResponseSchema.safeParse(envelope);
      if (!parsed.success) settle(id, new Error("Droid returned an invalid steering acknowledgment."));
      else if (parsed.data.error) settle(id, new SteeringRejectedError(parsed.data.error.code));
      else settle(id);
      return;
    }
    if (terminalError) return;
    if (messageHandler) messageHandler(frame);
    else {
      startupBytes += Buffer.byteLength(frame);
      if (startupBytes > MAX_STARTUP_BYTES) {
        fail(new Error("Droid steering startup buffer exceeded its limit."));
        void transport.close();
        return;
      }
      startupFrames.push(frame);
    }
  });
  base.onError(fail);

  async function steer(text: string, options: SteeringOptions = {}): Promise<void> {
    if (terminalError) throw terminalError;
    if (!base.isConnected) throw new Error("Droid transport is not connected.");
    if (options.signal?.aborted) throw abortError(options.signal);
    const id = `${prefix}${randomUUID()}`;
    const request = AddUserMessageRequestSchema.parse({
      jsonrpc: "2.0",
      factoryApiVersion: LEGACY_FACTORY_API_VERSION,
      factoryProtocolVersion: FACTORY_PROTOCOL_VERSION,
      type: "request",
      id,
      method: "droid.add_user_message",
      params: {
        text,
        messageId: options.messageId,
        images: options.images,
        files: options.files,
        userMessageSource: "sdk",
        // EndOfTurn is the native mid-loop steering queue. EndOfLoop would
        // wait for the entire task. skipAgentLoop prevents a new loop if the
        // original task finishes while this request is being delivered.
        queuePlacement: "end_of_turn",
        skipAgentLoop: true,
      },
    });
    await new Promise<void>((resolve, reject) => {
      const abort = () => settle(id, abortError(options.signal!));
      const timer = setTimeout(() => {
        settle(id, new Error("Droid steering acknowledgment timed out; the connection was closed."));
        // Receipt is uncertain after a timeout. Stop the owned subprocess
        // instead of silently allowing an unacknowledged update to run later.
        void transport.close();
      }, options.timeoutMs ?? 10_000);
      pending.set(id, {
        resolve,
        reject,
        cleanup() { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); },
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) { abort(); return; }
      void base.send(JSON.stringify(request)).catch(() => {
        settle(id, new Error("Could not send the Droid steering update."));
      });
    });
  }

  return { transport, steer, cancelPending };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Droid steering acknowledgment canceled.");
}

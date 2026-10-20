import {
  SessionNotificationPayloadSchema,
  convertNotificationToStreamMessage,
  type DroidSession,
  type SessionNotificationPayload,
} from "@factory/droid-sdk/node";
import type { DroidMessage } from "@factory/droid-sdk";

export type NativeCompletion = Extract<SessionNotificationPayload, { type: "agent_turn_completed" }>;
export type NativeUpdate =
  | { type: "completion"; completion: NativeCompletion }
  | { type: "message"; message: DroidMessage };

/** One lifetime subscription, independent of the SDK's per-prompt iterator. */
export function observeSession(native: Pick<DroidSession, "onNotification">, receive: (update: NativeUpdate) => void): () => void {
  return native.onNotification((notification) => {
    const params = notification.params as { notification?: unknown } | undefined;
    const parsed = SessionNotificationPayloadSchema.safeParse(params?.notification);
    if (!parsed.success) return;
    if (parsed.data.type === "agent_turn_completed") {
      receive({ type: "completion", completion: parsed.data });
      return;
    }
    const converted = convertNotificationToStreamMessage(parsed.data);
    for (const message of converted === null ? [] : Array.isArray(converted) ? converted : [converted])
      receive({ type: "message", message: message as DroidMessage });
  });
}

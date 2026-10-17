import type { DroidMessage, FactoryDroidMessage } from "@factory/droid-sdk";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { detailForTool, toolResultText, previewToolText, todoUpdateForTool } from "./tool-presentation";

type ToolItem = Extract<ProviderTimelineItem, { type: "tool_call" }>;
type TextItem = Extract<ProviderTimelineItem, { type: "assistant_message" | "reasoning" }>;
type ToolState = { input: Record<string, unknown>; item: ToolItem; output?: string };

/** Converts native events to complete snapshots, using stable native identities. */
export class DroidTimeline {
  private readonly text = new Map<string, TextItem>();
  private readonly tools = new Map<string, ToolState>();
  private readonly fingerprints = new Map<string, string>();
  private readonly publishedText = new Map<string, string>();
  private readonly pendingText = new Map<string, { messageId: string; blockIndex: number; type: TextItem["type"]; chunks: string[]; length: number }>();
  private pendingCharacters = 0;
  private readonly retractionNotices = new Set<string>();

  get hasPendingText(): boolean { return this.pendingText.size > 0; }

  /** Join native deltas once per presentation batch, rather than once per token. */
  flush(): ProviderTimelineItem[] {
    const items: ProviderTimelineItem[] = [];
    for (const [id, pending] of this.pendingText) {
      const text = (this.text.get(id)?.text ?? "") + pending.chunks.join("");
      items.push(this.setText(pending.messageId, pending.blockIndex, pending.type, text));
    }
    this.pendingText.clear();
    this.pendingCharacters = 0;
    return this.changed(items);
  }

  /** Completed snapshots live in provider persistence; do not retain a second history. */
  release(): void {
    this.pendingText.clear();
    this.pendingCharacters = 0;
    this.text.clear();
    this.tools.clear();
    this.fingerprints.clear();
    this.publishedText.clear();
    this.retractionNotices.clear();
  }

  handle(event: DroidMessage): ProviderTimelineItem[] {
    // A withdrawal must discard buffered text before it can become visible.
    if (event.type === "assistant_message_retracted") {
      for (const [id, pending] of this.pendingText) if (pending.messageId === event.messageId) {
        if (!this.text.has(id)) this.setText(pending.messageId, pending.blockIndex, pending.type, "");
        this.pendingCharacters -= pending.length;
        this.pendingText.delete(id);
      }
    }
    const prefix = event.type === "assistant_text_delta" || event.type === "thinking_text_delta" ? [] : this.flush();
    let items: ProviderTimelineItem[] = [];
    switch (event.type) {
      case "assistant_text_delta":
      case "thinking_text_delta": {
        const type = event.type === "assistant_text_delta" ? "assistant_message" : "reasoning";
        const id = this.textId(event.messageId, event.blockIndex, type);
        if (!event.text) break;
        let pending = this.pendingText.get(id);
        if (!pending) {
          pending = { messageId: event.messageId, blockIndex: event.blockIndex, type, chunks: [], length: 0 };
          this.pendingText.set(id, pending);
        }
        pending.chunks.push(event.text);
        pending.length += event.text.length;
        this.pendingCharacters += event.text.length;
        // Also bound a synchronous burst whose microtasks could delay timers.
        if (this.pendingCharacters >= 4096) return this.flush();
        break;
      }
      case "assistant":
        items = this.message(event.message, false);
        if (!event.message.content.some((block) => block.type === "text") && event.text) {
          items.push(this.setText(event.message.id, 0, "assistant_message", event.text));
        }
        break;
      case "user":
        // The provider owns the live user row and its clientMessageId. Native
        // user messages can still carry results from tools.
        items = this.message(event.message, false);
        break;
      case "assistant_message_retracted": {
        let found = false;
        for (const item of this.text.values()) {
          const prefix = `droid:${item.type}:${event.messageId}:`;
          if (item.id.startsWith(prefix)) {
            found = true;
            const empty = { ...item, text: "" };
            this.text.set(item.id, empty);
            items.push(empty);
          }
        }
        if (found && !this.retractionNotices.has(event.messageId)) {
          this.retractionNotices.add(event.messageId);
          items.push({ type: "notification", id: `droid:retracted:${event.messageId}`, level: "warning",
            message: "Droid withdrew an earlier response. Treat that response as invalid. This Paseo version may still display the withdrawn text." });
        }
        break;
      }
      case "tool_call":
        items = [this.tool(event.toolUseId, event.name, event.input)];
        break;
      case "tool_call_delta":
        items = [this.tool(event.toolUse.id, event.toolUse.name, event.toolUse.input)];
        break;
      case "tool_result":
        items = this.toolResultItems(event.toolUseId, event.toolName, event.content, event.isError);
        break;
      case "tool_progress": {
        const previous = this.tools.get(event.toolUseId);
        const input = previous?.input ?? event.update.parameters ?? {};
        this.tool(event.toolUseId, event.toolName, input);
        const state = this.tools.get(event.toolUseId)!;
        // fullOutput is a snapshot; other progress strings describe the latest
        // update and must not be blindly concatenated as output chunks.
        state.output = previewToolText(event.update.fullOutput ?? event.content);
        state.item = { ...state.item, detail: detailForTool(state.item.name, state.input, state.output) };
        items = [state.item];
        break;
      }
      case "error":
        items = [{ type: "error", id: `droid:error:${event.timestamp}`, message: event.message }];
        break;
      // Complete markers carry no new text. Result messages contain a copy of
      // prior events and must not be folded again.
      default:
        break;
    }
    return [...prefix, ...this.changed(items)];
  }

  /** Optional native history can use the exact same row identities as streaming. */
  replay(messages: readonly FactoryDroidMessage[]): ProviderTimelineItem[] {
    return this.changed(messages.flatMap((message) => this.message(message, true)));
  }

  /** Ensure an interrupted or failed turn leaves no permanently running tools. */
  finishTools(status: "completed" | "failed" | "canceled"): ProviderTimelineItem[] {
    const prefix = this.flush();
    const items: ProviderTimelineItem[] = [];
    for (const state of this.tools.values()) {
      if (state.item.status !== "running") continue;
      state.item = status === "failed"
        ? { ...state.item, status, error: "Droid turn failed before the tool completed" }
        : { ...state.item, status, error: null };
      items.push(state.item);
    }
    return [...prefix, ...this.changed(items)];
  }

  private message(message: FactoryDroidMessage, replay: boolean): ProviderTimelineItem[] {
    if (message.visibility === "llm_only" || message.role === "system") return [];
    const items: ProviderTimelineItem[] = [];
    if (replay && message.role === "user") {
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      if (text) items.push({ type: "user_message", id: `droid:user:${message.id}`, messageId: message.id, text });
    }
    message.content.forEach((block, index) => {
      if (block.type === "text" && message.role === "assistant")
        items.push(this.setText(message.id, index, "assistant_message", block.text));
      else if (block.type === "thinking" && message.role === "assistant")
        items.push(this.setText(message.id, index, "reasoning", block.thinking));
      else if (block.type === "tool_use")
        items.push(this.tool(block.id, block.name, block.input));
      else if (block.type === "tool_result")
        items.push(...this.toolResultItems(block.toolUseId, "", block.content, block.isError ?? false));
    });
    return items;
  }

  private textId(messageId: string, blockIndex: number, type: TextItem["type"]): string {
    return `droid:${type}:${messageId}:${blockIndex}`;
  }

  private setText(messageId: string, blockIndex: number, type: TextItem["type"], text: string): TextItem {
    const id = this.textId(messageId, blockIndex, type);
    const item: TextItem = type === "assistant_message"
      ? { type, id, messageId, text }
      : { type, id, text };
    this.text.set(id, item);
    return item;
  }

  private tool(id: string, name: string, input: Record<string, unknown>): ToolItem {
    const previous = this.tools.get(id);
    const merged = { ...previous?.input, ...input };
    const item: ToolItem = {
      ...(previous?.item ?? { status: "running", error: null }),
      type: "tool_call",
      id: `droid:tool:${id}`,
      callId: id,
      name: name || previous?.item.name || "Droid tool",
      detail: detailForTool(name || previous?.item.name || "Droid tool", merged, previous?.output),
    };
    this.tools.set(id, { input: merged, item, output: previous?.output });
    return item;
  }

  private toolResultItems(id: string, name: string, content: unknown, failed: boolean): ProviderTimelineItem[] {
    const result = this.toolResult(id, name, content, failed);
    const state = this.tools.get(id)!;
    const todo = todoUpdateForTool(state.item.name, state.input, !failed);
    return todo ? [result, todo] : [result];
  }

  private toolResult(id: string, name: string, content: unknown, failed: boolean): ToolItem {
    this.tool(id, name, this.tools.get(id)?.input ?? {});
    const state = this.tools.get(id)!;
    state.output = toolResultText(content);
    const detail = detailForTool(state.item.name, state.input, state.output);
    state.item = failed
      ? { ...state.item, detail, status: "failed", error: state.output || "Droid tool failed" }
      : { ...state.item, detail, status: "completed", error: null };
    return state.item;
  }

  private changed(items: ProviderTimelineItem[]): ProviderTimelineItem[] {
    return items.filter((item) => {
      if (item.type === "assistant_message" || item.type === "reasoning") {
        if (this.publishedText.get(item.id) === item.text) return false;
        this.publishedText.set(item.id, item.text);
        return true;
      }
      const fingerprint = JSON.stringify(item);
      if (this.fingerprints.get(item.id) === fingerprint) return false;
      this.fingerprints.set(item.id, fingerprint);
      return true;
    });
  }
}

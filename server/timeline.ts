import type { DroidMessage, FactoryDroidMessage } from "@factory/droid-sdk";
import type {
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";

type ToolItem = Extract<ProviderTimelineItem, { type: "tool_call" }>;
type TextItem = Extract<ProviderTimelineItem, { type: "assistant_message" | "reasoning" }>;
type ToolState = { input: Record<string, unknown>; item: ToolItem; output?: string };

// These are presentation limits, not limits on what reaches the native agent.
const MAX_TOOL_TEXT = 64_000;

function preview(text: string): string {
  return text.length <= MAX_TOOL_TEXT
    ? text
    : `${text.slice(0, MAX_TOOL_TEXT)}\n[Output truncated in Paseo]`;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof input[key] === "string") return input[key] as string;
  return undefined;
}

function number(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Never stringify arbitrary native payloads: they may include credentials,
// thought signatures, base64 images, or transport metadata.
function resultText(content: unknown): string {
  if (typeof content === "string") return preview(content);
  if (!Array.isArray(content)) return "";
  return preview(
    content
      .map((part: unknown) => {
        if (typeof part === "string") return part;
        const block = object(part);
        return block?.type === "text" && typeof block.text === "string" ? block.text : "";
      })
      .filter(Boolean)
      .join("\n"),
  );
}

function toolDetail(
  name: string,
  input: Record<string, unknown>,
  output?: string,
): ProviderToolCallDetail {
  const kind = name.toLowerCase().split(/[.:/]/).at(-1)?.replace(/[^a-z]/g, "") ?? "";
  const filePath = string(input, "file_path", "filePath", "path");
  if (["execute", "shell", "bash", "execcommand", "executecommand"].includes(kind)) {
    return {
      type: "shell",
      command: string(input, "command", "cmd") ?? "",
      cwd: string(input, "cwd", "workdir"),
      output,
    };
  }
  if (["read", "readfile"].includes(kind) && filePath) {
    return {
      type: "read",
      filePath,
      content: output,
      offset: number(input, "offset"),
      limit: number(input, "limit"),
    };
  }
  if (["edit", "editfile", "strreplace"].includes(kind) && filePath) {
    return {
      type: "edit",
      filePath,
      oldString: string(input, "old_str", "old_string", "oldString"),
      newString: string(input, "new_str", "new_string", "newString"),
    };
  }
  if (["create", "write", "writefile", "createfile"].includes(kind) && filePath) {
    const content = string(input, "content", "contents");
    return { type: "write", filePath, content: content === undefined ? undefined : preview(content) };
  }
  if (["grep", "glob", "search", "websearch"].includes(kind)) {
    return {
      type: "search",
      query: string(input, "pattern", "query", "search_term") ?? "",
      toolName: kind === "websearch" ? "web_search" : kind === "grep" ? "grep" : kind === "glob" ? "glob" : "search",
      content: output,
    };
  }
  if (["fetchurl", "webfetch", "fetch"].includes(kind)) {
    return { type: "fetch", url: string(input, "url") ?? "", result: output };
  }
  if (["task", "subagent"].includes(kind)) {
    return {
      type: "sub_agent",
      subAgentType: string(input, "subagent_type", "subagentType"),
      description: string(input, "description"),
      log: output ?? "",
    };
  }
  return { type: "plain_text", label: name, text: output, icon: "wrench" };
}

/** Converts native events to complete snapshots, using stable native identities. */
export class DroidTimeline {
  private readonly text = new Map<string, TextItem>();
  private readonly tools = new Map<string, ToolState>();
  private readonly fingerprints = new Map<string, string>();

  handle(event: DroidMessage): ProviderTimelineItem[] {
    let items: ProviderTimelineItem[] = [];
    switch (event.type) {
      case "assistant_text_delta":
      case "thinking_text_delta": {
        const type = event.type === "assistant_text_delta" ? "assistant_message" : "reasoning";
        const id = this.textId(event.messageId, event.blockIndex, type);
        const text = (this.text.get(id)?.text ?? "") + event.text;
        items = [this.setText(event.messageId, event.blockIndex, type, text)];
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
      case "assistant_message_retracted":
        for (const item of this.text.values()) {
          const prefix = `droid:${item.type}:${event.messageId}:`;
          if (item.id.startsWith(prefix)) {
            const empty = { ...item, text: "" };
            this.text.set(item.id, empty);
            items.push(empty);
          }
        }
        break;
      case "tool_call":
        items = [this.tool(event.toolUseId, event.name, event.input)];
        break;
      case "tool_call_delta":
        items = [this.tool(event.toolUse.id, event.toolUse.name, event.toolUse.input)];
        break;
      case "tool_result":
        items = [this.toolResult(event.toolUseId, event.toolName, event.content, event.isError)];
        break;
      case "tool_progress": {
        const previous = this.tools.get(event.toolUseId);
        const input = previous?.input ?? event.update.parameters ?? {};
        this.tool(event.toolUseId, event.toolName, input);
        const state = this.tools.get(event.toolUseId)!;
        // fullOutput is a snapshot; other progress strings describe the latest
        // update and must not be blindly concatenated as output chunks.
        state.output = preview(event.update.fullOutput ?? event.content);
        state.item = { ...state.item, detail: toolDetail(state.item.name, state.input, state.output) };
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
    return this.changed(items);
  }

  /** Optional native history can use the exact same row identities as streaming. */
  replay(messages: readonly FactoryDroidMessage[]): ProviderTimelineItem[] {
    return this.changed(messages.flatMap((message) => this.message(message, true)));
  }

  /** Ensure an interrupted or failed turn leaves no permanently running tools. */
  finishTools(status: "completed" | "failed" | "canceled"): ProviderTimelineItem[] {
    const items: ProviderTimelineItem[] = [];
    for (const state of this.tools.values()) {
      if (state.item.status !== "running") continue;
      state.item = status === "failed"
        ? { ...state.item, status, error: "Droid turn failed before the tool completed" }
        : { ...state.item, status, error: null };
      items.push(state.item);
    }
    return this.changed(items);
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
        items.push(this.toolResult(block.toolUseId, "", block.content, block.isError ?? false));
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
      detail: toolDetail(name || previous?.item.name || "Droid tool", merged, previous?.output),
    };
    this.tools.set(id, { input: merged, item, output: previous?.output });
    return item;
  }

  private toolResult(id: string, name: string, content: unknown, failed: boolean): ToolItem {
    this.tool(id, name, this.tools.get(id)?.input ?? {});
    const state = this.tools.get(id)!;
    state.output = resultText(content);
    const detail = toolDetail(state.item.name, state.input, state.output);
    state.item = failed
      ? { ...state.item, detail, status: "failed", error: state.output || "Droid tool failed" }
      : { ...state.item, detail, status: "completed", error: null };
    return state.item;
  }

  private changed(items: ProviderTimelineItem[]): ProviderTimelineItem[] {
    return items.filter((item) => {
      const fingerprint = JSON.stringify(item);
      if (this.fingerprints.get(item.id) === fingerprint) return false;
      this.fingerprints.set(item.id, fingerprint);
      return true;
    });
  }
}

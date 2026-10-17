import type { ProviderTimelineItem, ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";

const MAX_TOOL_TEXT = 64_000;
const MAX_INPUT_TEXT = 24_000;
const MAX_DEPTH = 6;
const MAX_ENTRIES = 64;
const MAX_NODES = 512;
const REDACTED = "[Redacted]";
const OMITTED = "[Presentation limit reached]";

export function previewToolText(text: string): string {
  return text.length <= MAX_TOOL_TEXT
    ? text
    : `${text.slice(0, MAX_TOOL_TEXT)}\n[Output truncated in Paseo]`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
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

function toolKind(name: string): string {
  return name.toLowerCase().split(/[.:/]/).at(-1)?.replace(/[^a-z]/g, "") ?? "";
}

function hiddenKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return /password|passwd|secret|credential|authorization|cookie|privatekey|apikey|accesskey|signature/.test(normalized) ||
    normalized.endsWith("token") ||
    /^(?:data|base64|binary|bytes|imagedata|imageurl|image|attachment|attachments)$/.test(normalized);
}

// This only produces presentation text. It never changes the native tool input.
// Inspect a bounded prefix before applying patterns, even for huge native strings.
function safeText(value: string, limit: number, label = "Input"): string {
  if (/^data:[^,]{0,200};base64,/i.test(value.slice(0, 256))) return "[Encoded data omitted]";
  const sample = value.slice(0, 256);
  if (sample.length >= 128 && /^[A-Za-z0-9+/=_-]+$/.test(sample)) return "[Encoded data omitted]";
  const text = value.slice(0, Math.max(0, limit));
  const cleaned = text
    .replace(/-----BEGIN [^-\n]{0,80}PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]{0,80}PRIVATE KEY-----|$)/g, REDACTED)
    .replace(/data:[^,\s"']{0,200};base64,[A-Za-z0-9+/=_-]+/gi, "[Encoded data omitted]")
    .replace(/[A-Za-z0-9+/]{128,}={0,2}/g, "[Encoded data omitted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, `Bearer ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\b(?:sk-(?:proj-)?|gh[pousr]_)[A-Za-z0-9_-]{16,}/g, REDACTED)
    .replace(/((?:["']?)(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|password|passwd|client[-_]?secret|authorization|cookie|private[-_]?key|thought[-_]?signature|signature)(?:["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi, `$1${REDACTED}`);
  return cleaned + (value.length > text.length ? `\n[${label} truncated in Paseo]` : "");
}

function structuredPreview(input: unknown, maxText: number, label: string): string {
  let remaining = maxText;
  let nodes = MAX_NODES;
  const ancestors = new Set<object>();
  function visit(value: unknown, depth: number): unknown {
    if (--nodes < 0 || remaining <= 0) return OMITTED;
    if (typeof value === "string") {
      const text = safeText(value, remaining, label);
      remaining -= text.length;
      return text;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
    if (typeof value !== "object") return `[${typeof value} omitted]`;
    if (ancestors.has(value)) return "[Circular reference omitted]";
    if (depth >= MAX_DEPTH) return "[Nested content omitted]";
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const result: unknown[] = [];
        for (let index = 0; index < Math.min(value.length, MAX_ENTRIES); index++) {
          if (nodes <= 0 || remaining <= 0) { result.push(OMITTED); break; }
          result.push(visit(value[index], depth + 1));
        }
        if (value.length > MAX_ENTRIES) result.push(`[${value.length - MAX_ENTRIES} more entries omitted]`);
        return result;
      }
      const result: Record<string, unknown> = Object.create(null);
      let entries = 0;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (entries++ >= MAX_ENTRIES || nodes <= 0 || remaining <= 0) {
          result["[Omitted]"] = OMITTED;
          break;
        }
        const displayKey = key.slice(0, 128);
        remaining -= displayKey.length;
        if (hiddenKey(key)) result[displayKey] = REDACTED;
        else {
          // Native payloads are JSON. Do not execute accessors on a non-JSON caller.
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          result[displayKey] = descriptor && "value" in descriptor
            ? visit(descriptor.value, depth + 1)
            : "[Accessor omitted]";
        }
      }
      return result;
    } finally { ancestors.delete(value); }
  }
  const text = JSON.stringify(visit(input, 0), null, 2);
  return text.length <= maxText ? text : `${text.slice(0, maxText)}\n[${label} truncated in Paseo]`;
}

/** Bounded, cycle-safe input review with credential and binary fields omitted. */
export function toolInputPreview(input: unknown): string {
  return structuredPreview(input, MAX_INPUT_TEXT, "Input");
}

function outputPreview(output: string, maxText: number): string {
  // Many MCP tools encode their result as JSON inside a text block. Redact
  // nested credential/binary fields there as well, without parsing huge output.
  if (output.length <= MAX_TOOL_TEXT && /^[\s]*[\[{]/.test(output)) {
    try { return structuredPreview(JSON.parse(output), maxText, "Output"); }
    catch { /* A textual result can start with a brace or bracket. */ }
  }
  return safeText(output, maxText, "Output");
}

/** Extract text blocks without serializing images, credentials, or protocol data. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return previewToolText(content);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  let length = 0;
  for (const part of content) {
    const block = record(part);
    const text = typeof part === "string" ? part : block?.type === "text" && typeof block.text === "string" ? block.text : "";
    if (!text) continue;
    const prefix = parts.length ? "\n" : "";
    parts.push(prefix + text.slice(0, MAX_TOOL_TEXT + 1 - length));
    length += prefix.length + text.length;
    if (length > MAX_TOOL_TEXT) break;
  }
  return previewToolText(parts.join(""));
}

export function detailForTool(name: string, input: Record<string, unknown>, output?: string): ProviderToolCallDetail {
  const kind = toolKind(name);
  const filePath = string(input, "file_path", "filePath", "path");
  if (["execute", "shell", "bash", "execcommand", "executecommand"].includes(kind)) return {
    type: "shell", command: string(input, "command", "cmd") ?? "", cwd: string(input, "cwd", "workdir"), output,
  };
  if (["read", "readfile"].includes(kind) && filePath) return {
    type: "read", filePath, content: output, offset: number(input, "offset"), limit: number(input, "limit"),
  };
  if (["edit", "editfile", "strreplace"].includes(kind) && filePath) return {
    type: "edit", filePath, oldString: string(input, "old_str", "old_string", "oldString"), newString: string(input, "new_str", "new_string", "newString"),
  };
  if (["create", "write", "writefile", "createfile"].includes(kind) && filePath) {
    const content = string(input, "content", "contents");
    return { type: "write", filePath, content: content === undefined ? undefined : previewToolText(content) };
  }
  if (["grep", "glob", "search", "websearch"].includes(kind)) return {
    type: "search", query: string(input, "pattern", "query", "search_term") ?? "",
    toolName: kind === "websearch" ? "web_search" : kind === "grep" ? "grep" : kind === "glob" ? "glob" : "search", content: output,
  };
  if (["fetchurl", "webfetch", "fetch"].includes(kind)) return { type: "fetch", url: string(input, "url") ?? "", result: output };
  if (["task", "subagent"].includes(kind)) return {
    type: "sub_agent", subAgentType: string(input, "subagent_type", "subagentType"), description: string(input, "description"), log: output ?? "",
  };
  const inputText = `Input:\n${toolInputPreview(input)}`;
  const text = output === undefined ? inputText : `${inputText}\n\nOutput:\n${outputPreview(output, MAX_TOOL_TEXT - inputText.length - 10)}`;
  return { type: "plain_text", label: name, text: previewToolText(text), icon: "wrench" };
}

type TodoItem = Extract<ProviderTimelineItem, { type: "todo" }>;
type TodoEntry = TodoItem["items"][number];

function todoStatus(value: unknown): TodoEntry["status"] | undefined {
  if (typeof value !== "string") return undefined;
  if (["~", ">", "-"].includes(value.trim())) return "in_progress";
  const normalized = value.trim().toLowerCase().replace(/[ -]/g, "_");
  if (["pending", "todo", "not_started", "open", ""].includes(normalized)) return "pending";
  if (["in_progress", "inprogress", "doing", "running", "started"].includes(normalized)) return "in_progress";
  if (["completed", "complete", "done", "finished", "x", "✓"].includes(normalized)) return "completed";
  return undefined;
}

function todoEntries(value: unknown): TodoEntry[] | undefined {
  if (typeof value === "string") {
    if (!value.trim()) return [];
    const entries: TodoEntry[] = [];
    for (const line of value.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const match = /^\s*(?:(?:[-*+]|\d+[.)])\s*)?\[([^\]]*)\]\s*(.+)$/.exec(line);
      const status = match ? todoStatus(match[1]) : undefined;
      if (!match || !status) return undefined;
      entries.push({ text: match[2].trim(), completed: status === "completed", status });
    }
    return entries;
  }
  if (!Array.isArray(value)) return undefined;
  const entries: TodoEntry[] = [];
  for (const raw of value) {
    const item = record(raw);
    const text = typeof raw === "string" ? raw : item ? string(item, "content", "text", "title", "description") : undefined;
    if (!text?.trim()) return undefined;
    const status = item?.status === undefined
      ? item?.completed === true ? "completed" : "pending"
      : todoStatus(item.status);
    if (!status) return undefined;
    entries.push({
      text: text.trim(), completed: status === "completed", status,
      ...(typeof item?.id === "string" ? { id: item.id } : {}),
      ...(typeof item?.activeForm === "string" ? { activeForm: item.activeForm } : {}),
    });
  }
  return entries;
}

/** Apply a complete list only after a successful TodoWrite result. */
export function todoUpdateForTool(name: string, input: Record<string, unknown>, successful: boolean): TodoItem | undefined {
  if (!successful || toolKind(name) !== "todowrite") return undefined;
  const entries = todoEntries(input.todos ?? input.tasks);
  return entries === undefined ? undefined : { type: "todo", id: "droid:todo", items: entries };
}

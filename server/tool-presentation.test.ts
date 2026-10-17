import assert from "node:assert/strict";
import test from "node:test";
import { detailForTool, todoUpdateForTool, toolInputPreview, toolResultText } from "./tool-presentation";

test("Script and MCP cards retain the operation, target and prompt after completion", () => {
  const script = "await tools.paseo___send_agent_prompt({ agentId: 'child-123', prompt: 'Review the release plan' });";
  const input = { script, background: true, notifyOnFinish: true };
  const detail = detailForTool("Script", input, '{"success":true,"status":"running"}');
  assert.equal(detail.type, "plain_text");
  if (detail.type !== "plain_text") throw new Error("Expected a generic review card");
  assert.match(detail.text!, /Input:/);
  assert.ok(detail.text!.includes(script));
  assert.match(detail.text!, /Output:\n\{/);
  assert.match(detail.text!, /"success": true/);
  assert.deepEqual(input, { script, background: true, notifyOnFinish: true });

  const mcp = detailForTool("paseo___send_agent_prompt", { agentId: "child-123", prompt: "Review the release plan" });
  assert.equal(mcp.type, "plain_text");
  if (mcp.type !== "plain_text") throw new Error("Expected a generic MCP card");
  assert.match(mcp.text!, /child-123/);
  assert.match(mcp.text!, /Review the release plan/);
});

test("generic input redacts nested credentials irrespective of key casing or separators", () => {
  const input = {
    target: "child-123",
    max_tokens: 1024,
    nested: [{
      "X-API-KEY": "secret-api-value",
      authorization: "secret-auth-value",
      ClientSecret: "secret-client-value",
      ACCESS_TOKEN: "secret-access-value",
      refreshToken: "secret-refresh-value",
      THOUGHT_SIGNATURE: "secret-signature-value",
      Password: "secret-password-value",
      sessionToken: "secret-session-value",
    }],
  };
  const preview = toolInputPreview(input);
  assert.match(preview, /child-123/);
  assert.match(preview, /1024/);
  assert.doesNotMatch(preview, /secret-(?:api|auth|client|access|refresh|signature|password|session)-value/);
  assert.match(preview, /\[Redacted\]/);
  assert.equal(input.nested[0].Password, "secret-password-value");
});

test("generic text and output omit encoded data and redact embedded credentials", () => {
  const data = "data:image/png;base64," + "a".repeat(1000);
  const preview = toolInputPreview({
    prompt: "Inspect the diagram",
    payload: data,
    blob: "YWJj".repeat(1000),
    source: { type: "base64", data: "private-image-content" },
    script: "const api_key = 'private-api-value'; await fetch(url, {Authorization: 'Bearer private-bearer-value'});",
  });
  assert.match(preview, /Inspect the diagram/);
  assert.doesNotMatch(preview, /private-api-value|private-bearer-value|private-image-content|data:image|YWJjYWJj/);
  const detail = detailForTool("MCP", {}, JSON.stringify({
    nested: { ClientSecret: "private-output-value", data: "private-output-image", token: "private-output-token" },
    ok: true,
  }));
  assert.equal(detail.type, "plain_text");
  if (detail.type !== "plain_text") throw new Error("Expected generic text");
  assert.doesNotMatch(detail.text!, /private-output-value|private-output-image|private-output-token/);
  assert.match(detail.text!, /"ok": true/);
});

test("input previews bound large, cyclic, deeply nested and accessor-bearing payloads", () => {
  let getterCalls = 0;
  const input: Record<string, unknown> = {
    prompt: "Keep this useful prompt",
    script: "const step = 1;\n".repeat(20_000),
  };
  input.self = input;
  const large = toolInputPreview(input);
  assert.ok(large.length < 25_000);
  assert.match(large, /Keep this useful prompt/);
  assert.match(large, /truncated|limit/i);

  const cycle: Record<string, unknown> = { target: "child-123" };
  cycle.self = cycle;
  const deep = { level: { level: { level: { level: { level: { level: { hidden: "do-not-expand" } } } } } } };
  Object.defineProperty(cycle, "getter", { enumerable: true, get() { getterCalls++; return "do-not-execute"; } });
  const bounded = toolInputPreview({ cycle, deep, wide: Array.from({ length: 100_000 }, (_, index) => index) });
  assert.equal(getterCalls, 0);
  assert.match(bounded, /Circular reference omitted/);
  assert.match(bounded, /Nested content omitted/);
  assert.match(bounded, /more entries omitted/);
  assert.doesNotMatch(bounded, /do-not-expand|do-not-execute/);
  assert.ok(bounded.length < 25_000);
});

test("existing shell, file, search, fetch and task detail types stay inspectable", () => {
  assert.deepEqual(detailForTool("Execute", { command: "pwd", cwd: "/tmp" }, "out"), { type: "shell", command: "pwd", cwd: "/tmp", output: "out" });
  assert.deepEqual(detailForTool("Read", { file_path: "/tmp/a", offset: 2, limit: 5 }, "file"), { type: "read", filePath: "/tmp/a", content: "file", offset: 2, limit: 5 });
  assert.deepEqual(detailForTool("Edit", { file_path: "/tmp/a", old_str: "old", new_str: "new" }), { type: "edit", filePath: "/tmp/a", oldString: "old", newString: "new" });
  assert.deepEqual(detailForTool("Create", { file_path: "/tmp/a", content: "new file" }), { type: "write", filePath: "/tmp/a", content: "new file" });
  assert.deepEqual(detailForTool("Grep", { pattern: "needle" }, "match"), { type: "search", query: "needle", toolName: "grep", content: "match" });
  assert.deepEqual(detailForTool("FetchUrl", { url: "https://example.test" }, "page"), { type: "fetch", url: "https://example.test", result: "page" });
  assert.deepEqual(detailForTool("Task", { subagent_type: "reviewer", description: "Review" }, "done"), { type: "sub_agent", subAgentType: "reviewer", description: "Review", log: "done" });
});

test("tool result extraction bounds text without inspecting binary or later blocks", () => {
  const result = toolResultText([{ type: "image", source: { data: "private-image-content" } }, { type: "text", text: "visible text" }]);
  assert.equal(result, "visible text");
  let lateReads = 0;
  const late = { get type() { lateReads++; return "text"; }, text: "later" };
  const long = toolResultText([{ type: "text", text: "word ".repeat(20_000) }, late]);
  assert.equal(lateReads, 0);
  assert.ok(long.length < 65_000);
  assert.match(long, /Output truncated in Paseo/);
  assert.equal(toolResultText({ data: "must not stringify" }), "");
});

test("successful native TodoWrite markdown maps every status and updates one stable row", () => {
  const first = todoUpdateForTool("TodoWrite", { todos: "1. [pending] Inspect code\n2. [in_progress] Review UI\n3. [completed] Read instructions" }, true);
  assert.deepEqual(first, {
    type: "todo", id: "droid:todo", items: [
      { text: "Inspect code", completed: false, status: "pending" },
      { text: "Review UI", completed: false, status: "in_progress" },
      { text: "Read instructions", completed: true, status: "completed" },
    ],
  });
  const next = todoUpdateForTool("TodoWrite", { todos: "- [x] Inspect code\n- [ ] Review UI" }, true);
  assert.equal(next?.id, first?.id);
  assert.equal(next?.items[0].completed, true);
  assert.equal(next?.items[1].status, "pending");
  assert.equal(todoUpdateForTool("TodoWrite", { todos: "1. [-] Working" }, true)?.items[0].status, "in_progress");
  assert.deepEqual(todoUpdateForTool("TodoWrite", { todos: [] }, true)?.items, []);
});

test("structured todo arrays preserve IDs and active wording without accepting partial malformed lists", () => {
  const result = todoUpdateForTool("TodoWrite", { todos: [
    { id: "a", content: "Inspect", status: "in_progress", activeForm: "Inspecting" },
    { text: "Verify", completed: true },
    { title: "Report", status: "pending" },
  ] }, true);
  assert.deepEqual(result?.items, [
    { id: "a", text: "Inspect", status: "in_progress", completed: false, activeForm: "Inspecting" },
    { text: "Verify", status: "completed", completed: true },
    { text: "Report", status: "pending", completed: false },
  ]);
  assert.equal(todoUpdateForTool("TodoWrite", { todos: [{ text: "Valid" }, { text: "Unknown", status: "future_status" }] }, true), undefined);
  assert.equal(todoUpdateForTool("TodoWrite", { todos: "- [x] Valid\ninvalid todo row" }, true), undefined);
});

test("unresolved, failed and canceled tools cannot replace the task list", () => {
  const input = { todos: [{ content: "Must not mark done", status: "completed" }] };
  assert.equal(todoUpdateForTool("TodoWrite", input, false), undefined);
  assert.equal(todoUpdateForTool("TodoRead", input, true), undefined);
  assert.equal(todoUpdateForTool("Execute", input, true), undefined);
});

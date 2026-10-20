// Synthetic JSON-RPC peer for SDK/host tests. Never executes commands or calls a model.
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

if (process.argv.includes("--version")) { process.stdout.write("droid 0.244.0\n"); process.exit(0); }
const sessionId = "11111111-1111-4111-8111-111111111111";
const settings = { modelId: "test-model", reasoningEffort: "low", autonomyLevel: "off", interactionMode: "auto" };
const tokenUsage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheCreationTokens: 0, thinkingTokens: 0 };
let envelope = {};
const timers = new Set();
function send(value) { process.stdout.write(`${JSON.stringify({ ...envelope, ...value })}\n`); }
function notify(notification) { send({ type: "notification", method: "droid.session_notification", params: { sessionId, notification } }); }
function message(id, role, text, visibility) {
  notify({ type: "create_message", message: { id, role, createdAt: Date.now(), updatedAt: Date.now(), content: [{ type: "text", text }], ...(visibility ? { visibility } : {}) } });
}
function complete(turnId, reason = "completed") { notify({ type: "agent_turn_completed", turnId, reason, tokenUsage }); }
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.type !== "request") return;
  envelope = { jsonrpc: "2.0", factoryApiVersion: request.factoryApiVersion, factoryProtocolVersion: request.factoryProtocolVersion };
  const reply = (result) => send({ type: "response", id: request.id, result });
  switch (request.method) {
    case "droid.list_models":
      reply({ models: [{ id: "test-model", displayName: "Synthetic Droid", shortDisplayName: "Synthetic", modelProvider: "anthropic",
        supportedReasoningEfforts: ["low"], defaultReasoningEffort: "low", disabled: false }] });
      break;
    case "droid.initialize_session":
      reply({ sessionId, session: { messages: [] }, settings });
      break;
    case "droid.load_session":
      reply({ session: { messages: [] }, settings, cwd: process.cwd() });
      break;
    case "droid.update_session_settings":
      Object.assign(settings, request.params);
      reply({});
      break;
    case "droid.get_context_stats":
      reply({ used: 1000, remaining: 127000, limit: 128000, accuracy: "estimated", updatedAt: new Date().toISOString() });
      break;
    case "droid.add_user_message": {
      reply({});
      const id = request.params.messageId;
      message(id, "user", request.params.text);
      message(`foreground:${id}`, "assistant", "Foreground finished; synthetic background work is scheduled.");
      complete(id);
      const timer = setTimeout(() => {
        timers.delete(timer);
        const backgroundId = `execute-completion:${randomUUID()}`;
        message(backgroundId, "user", "Synthetic background command completed", "llm_only");
        notify({ type: "droid_working_state_changed", newState: "thinking" });
        for (const [callId, name, input, content] of [
          ["synthetic-glob", "Glob", { patterns: ["src/**/*.ts", "docs/**/*.md"], folder: "/synthetic/project" }, "src/example.ts\ndocs/example.md"],
          ["synthetic-todo", "TodoWrite", { todos: "1. [completed] Verify background result" }, "TODO List Updated"],
        ]) {
          notify({ type: "tool_call", toolUse: { type: "tool_use", id: callId, name, input } });
          notify({ type: "tool_result", messageId: `result:${callId}`, toolUseId: callId, content, isError: false });
        }
        notify({ type: "assistant_text_delta", messageId: "synthetic-background-report", blockIndex: 0, textDelta: "Background report: " });
        notify({ type: "assistant_text_delta", messageId: "synthetic-background-report", blockIndex: 0, textDelta: "all synthetic checks finished." });
        message("synthetic-background-report", "assistant", "Background report: all synthetic checks finished.");
        complete(backgroundId);
        complete(backgroundId);
      }, Number(process.env.DROID_FAKE_BACKGROUND_DELAY_MS ?? 100));
      timers.add(timer);
      break;
    }
    case "droid.interrupt_session":
    case "droid.close_session":
      for (const timer of timers) clearTimeout(timer);
      timers.clear(); reply({}); break;
    default: reply({});
  }
});
input.on("close", () => { for (const timer of timers) clearTimeout(timer); process.exit(0); });

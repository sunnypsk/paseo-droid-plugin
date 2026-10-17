import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RequestPermissionRequestParamsSchema,
  ToolConfirmationOutcome as Outcome,
  ToolConfirmationType as Confirmation,
  type RequestPermissionRequestParams,
  type ToolConfirmationDetails,
} from "@factory/droid-sdk/node";
import type { ProviderEvent, ProviderPermissionRequest } from "@getpaseo/plugin/server/provider";
import { Permissions } from "./permissions";
import { scriptPermissionParamsSchema, type ScriptPermissionParams } from "./permission-compatibility";

function permission(
  details: ToolConfirmationDetails[] = [{ type: Confirmation.Execute, fullCommand: "echo hello", command: "echo" }],
  outcomes = [Outcome.ProceedOnce, Outcome.ProceedAlways, Outcome.Cancel],
): RequestPermissionRequestParams {
  return RequestPermissionRequestParamsSchema.parse({
    toolUses: details.map((detail, index) => ({
      toolUse: { type: "tool_use", id: `tool-${index}`, name: "Execute", input: { command: "echo hello" } },
      confirmationType: detail.type,
      details: detail,
    })),
    options: outcomes.map((value) => ({ label: `SDK label: ${value}`, value })),
  });
}

function fixture() {
  const events: ProviderEvent[] = [];
  const permissions = new Permissions("session", (event) => events.push(event));
  const request = (): ProviderPermissionRequest => {
    const event = events.findLast((item) => item.type === "session.permission");
    assert.equal(event?.type, "session.permission");
    return (event as Extract<ProviderEvent, { type: "session.permission" }>).request;
  };
  return { events, permissions, request };
}

function scriptPermission(): ScriptPermissionParams {
  return scriptPermissionParamsSchema.parse({
    toolUses: [{
      toolUse: {
        type: "tool_use", id: "native-script-1", name: "Script",
        thoughtSignature: "private-thought-signature-sentinel",
        namespace: "private-protocol-namespace-sentinel",
        scriptExecution: { runId: "private-run-id-sentinel", outerToolUseId: "private-outer-id-sentinel" },
        input: {
          script: 'await tools.paseo.send_agent_prompt({agentId: inputs.agentId, prompt: "Follow up"});\nawait tools.Create({file_path: "/tmp/script-note.txt", content: "Complete note"});',
          inputs: { agentId: "child-agent-42" },
        },
      },
      confirmationType: "script",
      details: {
        type: "script", impactLevel: "high",
        calls: [
          {
            toolName: "paseo___send_agent_prompt", line: 1, column: 7,
            toolInput: { agentId: "child-agent-42", prompt: "Follow up" },
            confirmation: { type: Confirmation.McpTool, toolName: "paseo___send_agent_prompt", serverName: "paseo", actualToolName: "send_agent_prompt", impactLevel: "high" },
          },
          {
            toolName: "Create", line: 2, column: 7, alwaysAsk: true,
            toolInput: { file_path: "/tmp/script-note.txt", content: "Complete note" },
            confirmation: { type: Confirmation.Create, filePath: "/tmp/script-note.txt", fileName: "script-note.txt", content: "Complete note" },
          },
        ],
      },
    }],
    options: [
      { label: "Run script once", value: Outcome.ProceedOnce },
      { label: "Run always", value: Outcome.ProceedAlways },
      { label: "Cancel script", value: Outcome.Cancel },
    ],
  });
}

test("native Script permissions require explicit once approval and visibly review the complete script and every call", async () => {
  const { permissions, request, events } = fixture();
  const params = scriptPermission();
  const result = permissions.scriptPermissionHandler(params);
  const card = request();
  assert.equal(permissions.hasPendingTools(), true);
  assert.equal(card.kind, "tool");
  assert.deepEqual(card.actions?.map(({ id, label }) => ({ id, label })), [
    { id: Outcome.ProceedOnce, label: "Run script once" },
    { id: Outcome.Cancel, label: "Cancel script" },
  ]);
  assert.equal(card.detail?.type, "plain_text");
  assert.doesNotMatch(JSON.stringify(card), /private-(?:thought-signature|protocol-namespace|run-id|outer-id)-sentinel/);
  const visible = card.detail?.type === "plain_text" ? card.detail.text ?? "" : "";
  assert.ok(visible.includes(String(params.toolUses[0].toolUse.input.script)), "Show original script with its original line breaks");
  for (const expected of [
    "all 1 requested action", "all 2 reported tool calls", "Call 1/2", "paseo___send_agent_prompt", "line 1, column 7",
    '"agentId": "child-agent-42"', '"prompt": "Follow up"', '"serverName": "paseo"', '"actualToolName": "send_agent_prompt"',
    "Call 2/2", "line 2, column 7", "/tmp/script-note.txt", "Complete note", "always requires approval",
  ]) assert.ok(visible.includes(expected), `Missing Script approval detail: ${expected}`);
  assert.throws(() => permissions.respond(card.id, { behavior: "allow" }));
  assert.throws(() => permissions.respond(card.id, { behavior: "allow", selectedActionId: Outcome.ProceedAlways }));
  assert.equal(events.filter((event) => event.type === "session.permission_resolved").length, 0);
  permissions.respond(card.id, { behavior: "allow", selectedActionId: Outcome.ProceedOnce });
  assert.equal(await result, Outcome.ProceedOnce);
  assert.equal(permissions.hasPendingTools(), false);
});

test("Script approval never uses exact MCP preapproval and close cancels the pending script", async () => {
  const events: ProviderEvent[] = [];
  const permissions = new Permissions("session", (event) => events.push(event), {
    preapproved: [{ kind: "mcp", server: "paseo", tool: "send_agent_prompt" }],
  });
  const result = permissions.scriptPermissionHandler(scriptPermission());
  assert.equal(events[0]?.type, "session.permission");
  assert.equal(permissions.hasPendingTools(), true);
  assert.equal(permissions.supersedeQuestions("Different task"), 0);
  assert.equal(permissions.hasPendingTools(), true);
  permissions.close();
  assert.equal(await result, Outcome.Cancel);
  assert.equal(permissions.hasPendingTools(), false);
  assert.equal(events.filter((event) => event.type === "session.permission_resolved").length, 1);
  await assert.rejects(permissions.scriptPermissionHandler(scriptPermission()), /closed/);
});

test("mixed Script and ordinary tool batches review every action and still offer only once or cancel", async () => {
  const { permissions, request } = fixture();
  const params = scriptPermission();
  params.toolUses.push(permission([{ type: Confirmation.Execute, command: "echo", fullCommand: "echo extra-batch-action > /tmp/extra.txt" }]).toolUses[0]);
  const result = permissions.scriptPermissionHandler(params);
  const card = request();
  const visible = card.detail?.type === "plain_text" ? card.detail.text ?? "" : "";
  for (const expected of ["all 2 requested actions", "Action 1/2", "Call 1/2", "Call 2/2", "Action 2/2", "echo extra-batch-action > /tmp/extra.txt"])
    assert.ok(visible.includes(expected), `Missing mixed Script action: ${expected}`);
  assert.deepEqual(card.actions?.map(({ id }) => id), [Outcome.ProceedOnce, Outcome.Cancel]);
  permissions.respond(card.id, { behavior: "deny" });
  assert.equal(await result, Outcome.Cancel);
});

test("malformed or future Script calls fail closed before an approval card can be opened", async () => {
  const { permissions, events } = fixture();
  const paramsFixture = scriptPermission();
  const first = paramsFixture.toolUses[0];
  assert.equal(first.details.type, "script");
  if (first.details.type !== "script") throw new Error("Expected native Script fixture");
  for (const malformed of [
    { ...paramsFixture, toolUses: [{ ...first, details: { ...first.details, calls: [{ ...first.details.calls[0], confirmation: { type: "recommend_mission", reason: "future operation" } }] } }] },
    { ...paramsFixture, toolUses: [{ ...first, details: { ...first.details, calls: [{ ...first.details.calls[0], toolInput: undefined }] } }] },
    { ...paramsFixture, toolUses: [{ ...first, details: { ...first.details, calls: [{ ...first.details.calls[0], confirmation: first.details }] } }] },
  ]) await assert.rejects(permissions.scriptPermissionHandler(malformed as unknown as ScriptPermissionParams));
  assert.equal(events.length, 0);
  assert.equal(permissions.hasPendingTools(), false);
});

test("tool permissions preserve offered outcomes and reject forged approvals", async () => {
  const { permissions, events, request } = fixture();
  const result = permissions.permissionHandler(permission());
  const card = request();
  assert.deepEqual(card.actions?.map(({ id, label }) => ({ id, label })), [
    { id: Outcome.ProceedOnce, label: `SDK label: ${Outcome.ProceedOnce}` },
    { id: Outcome.ProceedAlways, label: `SDK label: ${Outcome.ProceedAlways}` },
    { id: Outcome.Cancel, label: `SDK label: ${Outcome.Cancel}` },
  ]);
  assert.throws(() => permissions.respond(card.id, { behavior: "allow", selectedActionId: Outcome.ProceedAutoRunHigh }));
  assert.throws(() => permissions.respond(card.id, { behavior: "deny", selectedActionId: Outcome.ProceedAlways }));
  assert.equal(permissions.respond(card.id, { behavior: "allow" }), true);
  assert.equal(await result, Outcome.ProceedOnce);
  assert.equal(permissions.respond(card.id, { behavior: "allow" }), false);
  assert.equal(events.at(-1)?.type, "session.permission_resolved");
});

test("plans require an explicit offered approval and advanced modes remain unsupported", async () => {
  const { permissions, request } = fixture();
  const details: ToolConfirmationDetails[] = [{ type: Confirmation.ExitSpecMode, plan: "Create hello.txt" }];
  const result = permissions.permissionHandler(permission(details, [Outcome.ProceedOnce, Outcome.Cancel]));
  const card = request();
  assert.equal(card.kind, "plan");
  assert.deepEqual(card.detail, { type: "plan", text: "Create hello.txt" });
  assert.equal(card.metadata?.planText, "Create hello.txt");
  assert.equal(card.input?.plan, "Create hello.txt");
  assert.throws(() => permissions.respond(card.id, { behavior: "allow" }));
  permissions.respond(card.id, { behavior: "allow", selectedActionId: Outcome.ProceedOnce });
  assert.equal(await result, Outcome.ProceedOnce);

  const advanced = permissions.permissionHandler(permission(details, [Outcome.ProceedNewSessionHigh, Outcome.Cancel]));
  const advancedCard = request();
  assert.deepEqual(advancedCard.actions?.map(({ id }) => id), [Outcome.Cancel]);
  assert.match(advancedCard.description ?? "", /does not support/);
  assert.throws(() => permissions.respond(advancedCard.id, { behavior: "allow" }));
  permissions.respond(advancedCard.id, { behavior: "deny" });
  assert.equal(await advanced, Outcome.Cancel);
});

test("single native plans expose the exact review text through the host plan-card fields", async () => {
  for (const details of [
    { type: Confirmation.ExitSpecMode, plan: "# Implementation plan\n\n1. Preserve the existing file.\n2. Add `hello.txt`.\n" },
    { type: Confirmation.ProposeMission, proposal: "# Mission proposal\n\nReview before starting any workers.\n", title: "Mission" },
  ] as ToolConfirmationDetails[]) {
    const { permissions, request } = fixture();
    const result = permissions.permissionHandler(permission([details], [Outcome.ProceedOnce, Outcome.Cancel]));
    const card = request();
    const expected = details.type === Confirmation.ExitSpecMode ? details.plan : details.type === Confirmation.ProposeMission ? details.proposal : "";
    // These are the fields consumed by the installed host's plan card; detail
    // alone is insufficient even when it contains a complete native plan.
    assert.equal(card.metadata?.planText, expected);
    assert.equal(card.input?.plan, expected);
    assert.throws(() => permissions.respond(card.id, { behavior: "allow" }));
    permissions.respond(card.id, { behavior: "deny" });
    assert.equal(await result, Outcome.Cancel);
  }
});

test("batch tool cards visibly review every action instead of only the first detail", async () => {
  const { permissions, request } = fixture();
  const result = permissions.permissionHandler(permission([
    { type: Confirmation.Execute, command: "printf", fullCommand: "printf first > /tmp/first.txt" },
    { type: Confirmation.Create, filePath: "/tmp/second.txt", fileName: "second.txt", content: "second file\ncomplete content\n" },
    { type: Confirmation.Edit, filePath: "/tmp/third.txt", fileName: "third.txt", oldContent: "old third", newContent: "new third" },
    { type: Confirmation.McpTool, toolName: "send_message", serverName: "example", actualToolName: "send_message", impactLevel: "high" },
  ]));
  const card = request();
  assert.equal(card.kind, "tool");
  assert.equal(card.detail?.type, "plain_text");
  const visible = card.detail?.type === "plain_text" ? card.detail.text ?? "" : "";
  for (const expected of [
    "all 4 requested actions", "Action 1/4", "printf first > /tmp/first.txt", "Action 2/4", "/tmp/second.txt", "second file\ncomplete content\n",
    "Action 3/4", "/tmp/third.txt", "old third", "new third", "Action 4/4", "send_message", '"serverName": "example"',
  ]) assert.ok(visible.includes(expected), `Missing visible batch action detail: ${expected}`);
  assert.match(card.description ?? "", /all 4 actions/);
  permissions.respond(card.id, { behavior: "deny" });
  assert.equal(await result, Outcome.Cancel);
});

test("mixed plan batches keep the complete plan and extra actions in the actual plan-card review", async () => {
  const { permissions, request } = fixture();
  const plan = "# Exact plan\n\nCreate the file only after review.\n```sh\necho planned\n```\n";
  const result = permissions.permissionHandler(permission([
    { type: Confirmation.ExitSpecMode, plan },
    { type: Confirmation.Execute, command: "echo", fullCommand: "echo extra-action > /tmp/extra-action.txt" },
    { type: Confirmation.Create, filePath: "/tmp/batch-created.txt", fileName: "batch-created.txt", content: "complete extra file contents" },
  ], [Outcome.ProceedOnce, Outcome.Cancel]));
  const card = request();
  assert.equal(card.kind, "plan");
  assert.equal(card.detail?.type, "plain_text");
  assert.equal(card.input?.plan, card.metadata?.planText);
  const visible = String(card.metadata?.planText);
  for (const expected of [plan, "all 3 requested actions", "Action 2/3", "echo extra-action > /tmp/extra-action.txt", "Action 3/3", "/tmp/batch-created.txt", "complete extra file contents"])
    assert.ok(visible.includes(expected), `Missing visible mixed-plan action detail: ${expected}`);
  assert.ok(visible.startsWith("````text\n"), "The Markdown plan card must render all batch contents literally even when the plan contains code fences");
  assert.equal(card.metadata?.batchSize, 3);
  assert.throws(() => permissions.respond(card.id, { behavior: "allow" }));
  permissions.respond(card.id, { behavior: "allow", selectedActionId: Outcome.ProceedOnce });
  assert.equal(await result, Outcome.ProceedOnce);
});

test("MCP preapproval requires exact server and actual tool identity for the entire batch", async () => {
  const events: ProviderEvent[] = [];
  const permissions = new Permissions("session", (event) => events.push(event), {
    preapproved: [{ kind: "mcp", server: "paseo", tool: "read_workspace" }],
  });
  const matching: ToolConfirmationDetails = {
    type: Confirmation.McpTool,
    serverName: "paseo",
    actualToolName: "read_workspace",
    toolName: "display-name",
    impactLevel: "low",
  };
  assert.equal(await permissions.permissionHandler(permission([matching])), Outcome.ProceedOnce);
  assert.equal(events.length, 0);

  for (const details of [
    [{ ...matching, serverName: "other" }],
    [{ ...matching, actualToolName: undefined }],
    [matching, { type: Confirmation.Execute, command: "echo", fullCommand: "echo hello" }],
  ] as ToolConfirmationDetails[][]) {
    const result = permissions.permissionHandler(permission(details));
    assert.equal(events.at(-1)?.type, "session.permission");
    permissions.cancelAll();
    assert.equal(await result, Outcome.Cancel);
  }
});

test("question answers use unique headers and preserve SDK indexes and wording", async () => {
  const { permissions, request } = fixture();
  const result = permissions.askUserHandler({
    toolCallId: "question-tool",
    questions: [
      { index: 9, topic: "Choice", question: "Which file?", options: ["A", "B"] },
      { index: 12, topic: "Choice", question: "Which features?", options: ["X", "Y"], multiSelect: true },
    ],
  });
  const card = request();
  const questions = card.input?.questions as Array<{ header: string }>;
  assert.deepEqual(questions.map(({ header }) => header), ["Choice", "Choice (2)"]);
  assert.throws(() => permissions.respond(card.id, { behavior: "allow", updatedInput: { answers: { Choice: "A" } } }));
  permissions.respond(card.id, {
    behavior: "allow",
    updatedInput: { answers: { Choice: "A", "Choice (2)": ["X", "Y"] } },
  });
  assert.deepEqual(await result, {
    answers: [
      { index: 9, question: "Which file?", answer: "A" },
      { index: 12, question: "Which features?", answer: "X, Y" },
    ],
  });
});

test("steering supersedes questions with the exact new instruction while leaving tool approvals pending", async () => {
  const { permissions, events, request } = fixture();
  const tool = permissions.permissionHandler(permission());
  const toolCard = request();
  const question = permissions.askUserHandler({
    toolCallId: "steering-question",
    questions: [
      { index: 4, topic: "Path", question: "Which path should I edit?", options: ["src/a.ts", "src/b.ts"] },
      { index: 8, topic: "Checks", question: "Which checks should I run?", options: ["unit", "integration"], multiSelect: true },
    ],
  });
  const questionCard = request();
  const instruction = "Actually, inspect src/c.ts first.\nDo not edit any files yet.  ";
  assert.equal(permissions.hasPendingTools(), true);
  assert.throws(() => permissions.supersedeQuestions(" \n "), /user instruction/);
  assert.equal(permissions.supersedeQuestions(instruction), 1);
  assert.deepEqual(await question, {
    answers: [
      { index: 4, question: "Which path should I edit?", answer: instruction },
      { index: 8, question: "Which checks should I run?", answer: instruction },
    ],
  });
  assert.equal(permissions.hasPendingTools(), true);
  assert.equal(events.filter((event) => event.type === "session.permission_resolved" && event.permissionId === questionCard.id).length, 1);
  assert.equal(events.filter((event) => event.type === "session.permission_resolved" && event.permissionId === toolCard.id).length, 0);
  assert.equal(permissions.respond(questionCard.id, { behavior: "deny" }), false);
  assert.equal(permissions.supersedeQuestions("A later instruction"), 0);
  assert.equal(permissions.respond(toolCard.id, { behavior: "allow", selectedActionId: Outcome.ProceedOnce }), true);
  assert.equal(await tool, Outcome.ProceedOnce);
  assert.equal(permissions.hasPendingTools(), false);
});

test("superseding all pending questionnaires leaves later stop and close cancellation semantics intact", async () => {
  const { permissions, events } = fixture();
  const params = {
    toolCallId: "first-question",
    questions: [{ index: 2, topic: "Next", question: "What next?", options: ["continue", "wait"] }],
  };
  const first = permissions.askUserHandler(params);
  const second = permissions.askUserHandler({ ...params, toolCallId: "second-question" });
  assert.equal(permissions.hasPendingTools(), false);
  assert.equal(permissions.supersedeQuestions("Use the new task."), 2);
  for (const answer of await Promise.all([first, second])) {
    assert.deepEqual(answer, { answers: [{ index: 2, question: "What next?", answer: "Use the new task." }] });
    assert.equal("cancelled" in answer, false, "Question supersession must not trigger the native cancellation sentinel");
  }
  assert.equal(events.filter((event) => event.type === "session.permission_resolved").length, 2);
  const stopped = permissions.askUserHandler({ ...params, toolCallId: "stop-question" });
  permissions.cancelAll();
  assert.deepEqual(await stopped, { cancelled: true, answers: [] });
  const closed = permissions.askUserHandler({ ...params, toolCallId: "close-question" });
  permissions.close();
  assert.deepEqual(await closed, { cancelled: true, answers: [] });
  assert.throws(() => permissions.supersedeQuestions("too late"), /closed/);
});

test("interrupt cancels pending tools and questions, while close rejects late callbacks", async () => {
  const { permissions } = fixture();
  const tool = permissions.permissionHandler(permission());
  const question = permissions.askUserHandler({ toolCallId: "question-tool", questions: [] });
  permissions.cancelAll();
  assert.equal(await tool, Outcome.Cancel);
  assert.deepEqual(await question, { cancelled: true, answers: [] });

  const nextTurn = permissions.permissionHandler(permission());
  permissions.close();
  assert.equal(await nextTurn, Outcome.Cancel);
  await assert.rejects(async () => permissions.permissionHandler(permission()), /closed/);
  await assert.rejects(async () => permissions.askUserHandler({ toolCallId: "late", questions: [] }), /closed/);
});

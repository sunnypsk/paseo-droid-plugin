import { randomUUID } from "node:crypto";
import {
  ToolConfirmationOutcome,
  ToolConfirmationType,
  type AskUserRequestParams,
  type AskUserResult,
  type ClientAskUserHandler,
  type ClientPermissionHandler,
  type RequestPermissionHandlerResult,
  type RequestPermissionRequestParams,
  type ToolConfirmationDetails,
} from "@factory/droid-sdk/node";
import type {
  ProviderEvent,
  ProviderPermissionAction,
  ProviderPermissionRequest,
  ProviderPermissionResponse,
  ProviderToolCallDetail,
  ProviderToolPolicy,
} from "@getpaseo/plugin/server/provider";
import {
  scriptPermissionParamsSchema,
  type ScriptPermissionParams,
  type ScriptToolConfirmationInfo,
} from "./permission-compatibility";

type Pending = {
  kind: "tool";
  respond(response: ProviderPermissionResponse): void;
  cancel(): void;
} | {
  kind: "question";
  respond(response: ProviderPermissionResponse): void;
  cancel(): void;
  supersede(text: string): void;
};

const isPlan = (details: ToolConfirmationDetails) =>
  details.type === ToolConfirmationType.ExitSpecMode ||
  details.type === ToolConfirmationType.ProposeMission ||
  details.type === ToolConfirmationType.StartMissionRun;

function detailFor(details: ToolConfirmationDetails): ProviderToolCallDetail | undefined {
  switch (details.type) {
    case ToolConfirmationType.Execute:
      return { type: "shell", command: details.fullCommand };
    case ToolConfirmationType.Create:
      return { type: "write", filePath: details.filePath, content: details.content };
    case ToolConfirmationType.Edit:
      return {
        type: "edit",
        filePath: details.filePath,
        oldString: details.oldContent,
        newString: details.newContent,
      };
    case ToolConfirmationType.ApplyPatch:
      return { type: "edit", filePath: details.filePath, unifiedDiff: details.patchContent };
    case ToolConfirmationType.ExitSpecMode:
      return { type: "plan", text: details.plan };
    case ToolConfirmationType.ProposeMission:
      return { type: "plan", text: details.proposal };
    default:
      return undefined;
  }
}

function planText(details: ToolConfirmationDetails): string | undefined {
  if (details.type === ToolConfirmationType.ExitSpecMode) return details.plan;
  if (details.type === ToolConfirmationType.ProposeMission) return details.proposal;
  return undefined;
}

function actionText(item: RequestPermissionRequestParams["toolUses"][number]): string {
  const { details, toolUse } = item;
  const detail = detailFor(details);
  const lines: string[] = [];
  if (detail?.type === "shell") lines.push("Command:", detail.command);
  else if (detail?.type === "write") lines.push(`File: ${detail.filePath}`, "Content:", detail.content ?? "");
  else if (detail?.type === "edit") {
    lines.push(`File: ${detail.filePath}`);
    if (detail.unifiedDiff !== undefined) lines.push("Patch:", detail.unifiedDiff);
    if (detail.oldString !== undefined) lines.push("Old content:", detail.oldString);
    if (detail.newString !== undefined) lines.push("New content:", detail.newString);
    if (details.type === ToolConfirmationType.ApplyPatch && details.files)
      lines.push("All files in patch:", JSON.stringify(details.files, null, 2));
  } else if (detail?.type === "plan") lines.push(detail.text);
  else lines.push(JSON.stringify(details, null, 2));
  // In particular, MCP parameters can describe effects beyond the tool name.
  // Omit protocol metadata such as thought signatures from the visible review.
  lines.push("Tool parameters:", JSON.stringify(toolUse.input, null, 2));
  return lines.join("\n");
}

function batchText(params: RequestPermissionRequestParams): string {
  const size = params.toolUses.length;
  return [
    `This approval covers all ${size} requested actions.`,
    ...params.toolUses.map((item, index) =>
      `Action ${index + 1}/${size}: ${item.toolUse.name} (${item.details.type})\n${actionText(item)}`,
    ),
  ].join("\n\n");
}

// Plan cards render Markdown. A batch's commands/content must remain literal,
// including any Markdown fences contained inside a tool parameter or plan.
function literalReview(text: string): string {
  let longest = 2;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

function scriptActionText(item: ScriptToolConfirmationInfo): string {
  const { details, toolUse } = item;
  const original = ["script", "code", "source"].flatMap((key) =>
    typeof toolUse.input[key] === "string" ? [`Original ${key}:\n${toolUse.input[key]}`] : [],
  );
  return [
    `Script impact level: ${details.impactLevel}`,
    ...original,
    "Complete original Script input:",
    JSON.stringify(toolUse.input, null, 2),
    `The script requests all ${details.calls.length} reported tool calls:`,
    ...details.calls.map((call, index) => [
      `Call ${index + 1}/${details.calls.length}: ${call.toolName} (line ${call.line}, column ${call.column})`,
      ...(call.alwaysAsk ? ["This call always requires approval."] : []),
      "Call parameters:",
      JSON.stringify(call.toolInput, null, 2),
      "Native confirmation:",
      JSON.stringify(call.confirmation, null, 2),
      actionText({
        toolUse: { ...toolUse, name: call.toolName, input: call.toolInput },
        confirmationType: call.confirmation.type,
        details: call.confirmation,
      }),
    ].join("\n")),
  ].join("\n\n");
}

/** Bridges SDK callbacks into Paseo's native permission and question cards. */
export class Permissions {
  private readonly pending = new Map<string, Pending>();
  private closed = false;

  constructor(
    private readonly sessionId: string,
    private readonly emit: (event: ProviderEvent) => void,
    private readonly toolPolicy?: ProviderToolPolicy,
  ) {}

  readonly permissionHandler: ClientPermissionHandler = async (params) => {
    this.assertOpen();
    const once = params.options.find((option) => option.value === ToolConfirmationOutcome.ProceedOnce);
    // Never infer an MCP identity from a display name, namespace, or tool input.
    // A mixed batch must prompt if even one operation was not preapproved.
    if (once && params.toolUses.length > 0 && params.toolUses.every(({ details }) =>
      details.type === ToolConfirmationType.McpTool &&
      details.serverName !== undefined &&
      details.actualToolName !== undefined &&
      this.toolPolicy?.preapproved.some((rule) =>
        rule.kind === "mcp" &&
        rule.server === details.serverName &&
        rule.tool === details.actualToolName,
      ),
    )) return ToolConfirmationOutcome.ProceedOnce;

    const plan = params.toolUses.some(({ details }) => isPlan(details));
    const supported = params.options.filter(({ value }) =>
      value === ToolConfirmationOutcome.ProceedOnce ||
      value === ToolConfirmationOutcome.Cancel ||
      (!plan && value === ToolConfirmationOutcome.ProceedAlways),
    );
    const actions: ProviderPermissionAction[] = supported.map(({ value, label }) => ({
      id: value,
      label,
      behavior: value === ToolConfirmationOutcome.Cancel ? "deny" : "allow",
      variant: value === ToolConfirmationOutcome.Cancel ? "secondary" : "primary",
    }));
    const canProceed = supported.some(({ value }) => value !== ToolConfirmationOutcome.Cancel);
    const first = params.toolUses[0];
    const batch = params.toolUses.length > 1;
    const combined = batch ? batchText(params) : undefined;
    const reviewedPlan = plan
      ? batch ? literalReview(combined!) : first ? planText(first.details) ?? actionText(first) : undefined
      : undefined;
    const request: ProviderPermissionRequest = {
      id: `droid-permission-${randomUUID()}`,
      name: batch ? `Droid action batch (${params.toolUses.length})` : first?.toolUse.name ?? "Droid permission",
      kind: plan ? "plan" : "tool",
      title: plan ? "Review Droid plan" : batch ? `Droid needs permission for ${params.toolUses.length} actions` : "Droid needs permission",
      description: [
        ...(batch ? [`This approval applies to all ${params.toolUses.length} actions shown below.`] : []),
        ...(!canProceed ? ["Droid offered only approval modes this proof of concept does not support. Cancel and use the Droid CLI to continue with those modes."] : []),
      ].join("\n") || undefined,
      // The host plan card consumes metadata.planText/input.plan. Tool cards
      // prefer detail over input, so a batch must expose every action in detail.
      input: JSON.parse(JSON.stringify({
        toolUses: params.toolUses.map(({ toolUse, confirmationType, details }) => ({
          toolUse: { id: toolUse.id, name: toolUse.name, input: toolUse.input },
          confirmationType,
          details,
        })),
        ...(reviewedPlan !== undefined ? { plan: reviewedPlan } : {}),
      })),
      detail: batch ? { type: "plain_text", label: `${params.toolUses.length} requested actions`, text: combined } : first ? detailFor(first.details) : undefined,
      ...(reviewedPlan !== undefined ? { metadata: { planText: reviewedPlan, batchSize: params.toolUses.length } } : {}),
      actions,
    };

    return this.waitForPermission(request, !plan && once ? ToolConfirmationOutcome.ProceedOnce : undefined);
  };

  /** Native Script requests unsupported by the SDK still require explicit review. */
  readonly scriptPermissionHandler = async (input: ScriptPermissionParams): Promise<RequestPermissionHandlerResult> => {
    this.assertOpen();
    // This is also a public bridge entry point: validate before any card or
    // approval can exist, even when a caller bypasses the transport validator.
    const params = scriptPermissionParamsSchema.parse(input);
    const count = params.toolUses.length;
    const text = [
      `This approval covers all ${count} requested ${count === 1 ? "action" : "actions"}, including the complete script and every reported call.`,
      ...params.toolUses.map((item, index) => {
        const rendered = item.details.type === "script"
          ? scriptActionText(item as ScriptToolConfirmationInfo)
          : actionText(item as RequestPermissionRequestParams["toolUses"][number]);
        return `Action ${index + 1}/${count}: ${item.toolUse.name} (${item.details.type})\n${rendered}`;
      }),
    ].join("\n\n");
    const actions: ProviderPermissionAction[] = params.options
      .filter(({ value }) => value === ToolConfirmationOutcome.ProceedOnce || value === ToolConfirmationOutcome.Cancel)
      .map(({ value, label }) => ({
        id: value,
        label,
        behavior: value === ToolConfirmationOutcome.Cancel ? "deny" : "allow",
        variant: value === ToolConfirmationOutcome.Cancel ? "secondary" : "primary",
      }));
    const plan = params.toolUses.some((item) => item.details.type === "script"
      ? item.details.calls.some((call) => isPlan(call.confirmation))
      : isPlan(item.details));
    const reviewedPlan = plan ? literalReview(text) : undefined;
    const request: ProviderPermissionRequest = {
      id: `droid-script-permission-${randomUUID()}`,
      name: count === 1 ? "Script" : `Droid action batch (${count}, including Script)`,
      kind: plan ? "plan" : "tool",
      title: "Review Droid script",
      description: actions.some((action) => action.behavior === "allow")
        ? "Approve once to run the complete script and all actions shown below."
        : "Droid did not offer a supported one-time Script approval. Cancel to stop this request.",
      input: JSON.parse(JSON.stringify({
        toolUses: params.toolUses.map(({ toolUse, confirmationType, details }) => ({
          toolUse: { id: toolUse.id, name: toolUse.name, input: toolUse.input },
          confirmationType,
          details,
        })),
        ...(reviewedPlan !== undefined ? { plan: reviewedPlan } : {}),
      })),
      detail: { type: "plain_text", label: `${count} requested ${count === 1 ? "action" : "actions"}`, text },
      ...(reviewedPlan !== undefined ? { metadata: { planText: reviewedPlan, batchSize: count } } : {}),
      actions,
    };
    // No default approval and no MCP policy shortcut: the entire script must be
    // reviewed and the offered ProceedOnce action selected explicitly.
    return this.waitForPermission(request);
  };

  private waitForPermission(
    request: ProviderPermissionRequest,
    defaultApproval?: ToolConfirmationOutcome.ProceedOnce,
  ): Promise<RequestPermissionHandlerResult> {
    const actions = request.actions ?? [];
    return new Promise<RequestPermissionHandlerResult>((resolve, reject) => {
      const settle = (outcome: ToolConfirmationOutcome) => {
        resolve(outcome as Exclude<ToolConfirmationOutcome, ToolConfirmationOutcome.ProceedEdit>);
        this.resolved(request.id);
      };
      const cancel = () => {
        if (actions.some(({ id }) => id === ToolConfirmationOutcome.Cancel)) {
          settle(ToolConfirmationOutcome.Cancel);
        } else {
          reject(new Error("Droid permission cancelled; the SDK did not offer Cancel."));
          this.resolved(request.id);
        }
      };
      this.pending.set(request.id, {
        kind: "tool",
        cancel,
        respond: (response) => {
          if (response.behavior === "deny") {
            if (response.selectedActionId && response.selectedActionId !== ToolConfirmationOutcome.Cancel)
              throw new Error("A denied permission cannot select an approval action.");
            cancel();
            return;
          }
          // Plans and scripts need an explicit offered approval action.
          const selected = response.selectedActionId ?? defaultApproval;
          const action = actions.find((item) => item.id === selected && item.behavior === "allow");
          if (!action) throw new Error("Select a supported approval action offered by Droid.");
          settle(action.id as ToolConfirmationOutcome);
        },
      });
      this.publish(request, reject);
    });
  }

  readonly askUserHandler: ClientAskUserHandler = async (params) => {
    this.assertOpen();
    const headers = new Set<string>();
    const questions = params.questions.map((question, position) => {
      const base = question.topic.trim() || `Question ${position + 1}`;
      let header = base;
      let suffix = 2;
      while (headers.has(header)) header = `${base} (${suffix++})`;
      headers.add(header);
      return {
        id: `${params.toolCallId}:${position}`,
        header,
        question: question.question,
        options: question.options.map((label) => ({ label, description: "" })),
        multiSelect: question.multiSelect ?? false,
        allowOther: true,
        allowEmpty: false,
      };
    });
    const request: ProviderPermissionRequest = {
      id: `droid-question-${randomUUID()}`,
      name: "AskUser",
      kind: "question",
      title: "Droid has a question",
      input: { questions },
    };
    return new Promise<AskUserResult>((resolve, reject) => {
      const settle = (result: AskUserResult) => {
        resolve(result);
        this.resolved(request.id);
      };
      this.pending.set(request.id, {
        kind: "question",
        cancel: () => settle({ cancelled: true, answers: [] }),
        // A new user instruction is a freeform response to the pending
        // questions. Cancellation would abort Droid's loop before it can
        // process the queued steering message.
        supersede: (text) => settle({
          answers: params.questions.map(({ index, question }) => ({ index, question, answer: text })),
        }),
        respond: (response) => {
          if (response.behavior === "deny") {
            settle({ cancelled: true, answers: [] });
            return;
          }
          settle({ answers: this.answers(params, questions, response) });
        },
      });
      this.publish(request, reject);
    });
  };

  /** False means this request has already settled or belongs to another session. */
  respond(permissionId: string, response: ProviderPermissionResponse): boolean {
    const pending = this.pending.get(permissionId);
    if (!pending) return false;
    pending.respond(response);
    return true;
  }

  /** Tool approvals must be answered explicitly before active-turn steering. */
  hasPendingTools(): boolean {
    return [...this.pending.values()].some((pending) => pending.kind === "tool");
  }

  /** Let Droid continue from AskUser using the user's new instruction verbatim. */
  supersedeQuestions(text: string): number {
    this.assertOpen();
    if (!text.trim()) throw new Error("A user instruction is required to supersede Droid questions.");
    let resolved = 0;
    for (const pending of [...this.pending.values()]) {
      if (pending.kind !== "question") continue;
      pending.supersede(text);
      resolved++;
    }
    return resolved;
  }

  /** Interrupt pending callbacks; a subsequent turn can still request permission. */
  cancelAll(): void {
    for (const pending of [...this.pending.values()]) pending.cancel();
  }

  /** Close permanently so late callbacks cannot leave a dangling permission card. */
  close(): void {
    this.closed = true;
    this.cancelAll();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("The Droid permission bridge is closed.");
  }

  private resolved(permissionId: string): void {
    this.pending.delete(permissionId);
    this.emit({ type: "session.permission_resolved", sessionId: this.sessionId, permissionId });
  }

  private publish(request: ProviderPermissionRequest, reject: (error: unknown) => void): void {
    try {
      this.emit({ type: "session.permission", sessionId: this.sessionId, request });
    } catch (error) {
      this.pending.delete(request.id);
      reject(error);
    }
  }

  private answers(
    params: AskUserRequestParams,
    questions: Array<{ header: string; multiSelect: boolean }>,
    response: Extract<ProviderPermissionResponse, { behavior: "allow" }>,
  ): AskUserResult["answers"] {
    const supplied = response.updatedInput?.answers;
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied))
      throw new Error("Droid question responses require updatedInput.answers keyed by question header.");
    return questions.map((question, position) => {
      const raw = supplied[question.header];
      const answer = typeof raw === "string"
        ? raw
        : question.multiSelect && Array.isArray(raw) && raw.every((item) => typeof item === "string")
          ? raw.join(", ")
          : undefined;
      if (answer === undefined || answer.trim().length === 0)
        throw new Error(`Answer required for ${question.header}.`);
      return {
        index: params.questions[position].index,
        question: params.questions[position].question,
        answer,
      };
    });
  }
}

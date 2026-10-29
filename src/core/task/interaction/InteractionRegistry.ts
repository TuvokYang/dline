import type {
    InputPolicy,
    InteractionActionDefinition,
    InteractionActionType,
    InteractionContinuation,
    InteractionDefinition,
    InteractionKind,
    PayloadPolicy,
} from "./Interaction"

export const INTERACTION_KINDS = [
    "tool_approval",
    "hosted_web_approval",
    "command_approval",
    "browser_approval",
    "mcp_approval",
    "subagent_approval",
    "spawn_task_approval",
    "change_todo_list",
    "new_task",
    "report_bug",
    "condense",
    "followup",
    "make_plan",
    "qna_response",
    "generate_report",
    "status_acknowledgment",
    "error_retry",
    "profile_failure",
    "mistake_limit",
    "completion",
    "resume",
    "cancelled_resume",
] as const satisfies readonly InteractionKind[]

const DRAFT_INPUT: InputPolicy = {
    enabled: true,
    acceptsText: true,
    acceptsImages: true,
    acceptsFiles: true,
}

/** Create immutable action metadata. */
function action(
    type: InteractionActionType,
    label: string,
    payloadPolicy: PayloadPolicy = "none",
    appearance: InteractionActionDefinition["appearance"] = "primary",
): InteractionActionDefinition {
    return { type, label, appearance, payloadPolicy }
}

/** Create one immutable interaction definition. */
function define(
    kind: InteractionKind,
    taskAsk: InteractionDefinition["taskAsk"],
    actions: readonly InteractionActionDefinition[],
    input: InputPolicy = DRAFT_INPUT,
    continuation: InteractionContinuation = "none",
    presentationKind: InteractionDefinition["presentationKind"] = kind,
): InteractionDefinition {
    return { kind, taskAsk, presentationKind, input, actions, continuation }
}

/**
 * Interactions approved through the generic manual tool approval that still
 * present their own footer contract.
 *
 * NEW_TASK approval is planned outside its handler (approval-kind.ts forces it
 * to manual), so the kernel opens a `tool_approval` dialog. The user is still
 * choosing between starting the successor and regenerating its context, and
 * Start New Task must keep the unsent draft for the successor, so both the
 * planned action rules and the footer follow the NEW_TASK definition.
 */
const SPECIALIZED_TOOL_APPROVALS: ReadonlySet<string> = new Set<InteractionKind>(["new_task"])

/** The interaction whose contract a manual tool approval presents, keyed by its presentation ask. */
export function specializedToolApprovalKind(ask: string | undefined): InteractionKind | undefined {
    return ask !== undefined && SPECIALIZED_TOOL_APPROVALS.has(ask) ? (ask as InteractionKind) : undefined
}

const REPLY_INPUT: InputPolicy = { ...DRAFT_INPUT, enterAction: "reply" }
const RESUME_INPUT: InputPolicy = { ...DRAFT_INPUT, enterAction: "resume" }
const NO_INPUT: InputPolicy = { enabled: false, acceptsText: false, acceptsImages: false, acceptsFiles: false }
const APPROVAL_INPUT: InputPolicy = { ...DRAFT_INPUT, enterAction: "reject" }
const RETRY_INPUT: InputPolicy = { ...DRAFT_INPUT, enterAction: "retry" }
const ACKNOWLEDGE_INPUT: InputPolicy = { ...DRAFT_INPUT, enterAction: "acknowledge" }
const CONDENSE_INPUT: InputPolicy = { ...DRAFT_INPUT, enterAction: "reject" }
const APPROVAL_ACTIONS = [action("approve", "Approve", "draft"), action("reject", "Reject", "draft", "danger")]

const DEFINITIONS: Readonly<Record<InteractionKind, InteractionDefinition>> = {
    tool_approval: define("tool_approval", "tool", APPROVAL_ACTIONS, APPROVAL_INPUT),
    hosted_web_approval: define("hosted_web_approval", "tool", APPROVAL_ACTIONS, APPROVAL_INPUT, "api", "tool_approval"),
    command_approval: define("command_approval", "command", APPROVAL_ACTIONS, APPROVAL_INPUT),
    browser_approval: define("browser_approval", "browser_action_launch", APPROVAL_ACTIONS, APPROVAL_INPUT),
    mcp_approval: define("mcp_approval", "use_mcp_server", APPROVAL_ACTIONS, APPROVAL_INPUT),
    subagent_approval: define("subagent_approval", "use_subagents", APPROVAL_ACTIONS, APPROVAL_INPUT),
    spawn_task_approval: define("spawn_task_approval", "spawn_task", APPROVAL_ACTIONS, APPROVAL_INPUT),
    change_todo_list: define(
        "change_todo_list",
        "change_todo_list",
        [action("approve", "Approve", "draft_and_selection"), action("reject", "Reject", "draft", "danger")],
        APPROVAL_INPUT,
    ),
    new_task: define(
        "new_task",
        "new_task",
        [action("approve", "Start New Task"), action("reject", "Regenerate Context", "draft", "secondary")],
        APPROVAL_INPUT,
    ),
    report_bug: define(
        "report_bug",
        "report_bug",
        [action("approve", "Open GitHub Issue", "selection"), action("reject", "Cancel", "none", "secondary")],
        NO_INPUT,
    ),
    condense: define(
        "condense",
        "condense",
        [action("confirm_utility", "Condense Conversation"), action("reject", "Regenerate Summary", "draft", "secondary")],
        CONDENSE_INPUT,
    ),
    followup: define("followup", "followup", [], REPLY_INPUT, "handler"),
    make_plan: define("make_plan", "make_plan", [], REPLY_INPUT, "handler"),
    qna_response: define("qna_response", "qna_respond", [], REPLY_INPUT, "handler"),
    generate_report: define("generate_report", "generate_report", [], REPLY_INPUT, "handler"),
    // No handler opens this kind any more; it stays so an acknowledgment left open by an
    // earlier version can still be answered after the task is restored.
    status_acknowledgment: define(
        "status_acknowledgment",
        "status_acknowledgment",
        [action("acknowledge", "Acknowledge", "draft"), action("stop", "Stop", "draft", "danger")],
        ACKNOWLEDGE_INPUT,
    ),
    error_retry: define(
        "error_retry",
        "api_req_failed",
        [action("retry", "Retry", "draft"), action("start_new_task", "Start New Task", "draft")],
        RETRY_INPUT,
    ),
    /**
     * A provider failure that sending the same request again cannot fix, such as
     * a rejected API key. It reads exactly like `error_retry` but offers no
     * Retry: Enter carries a typed reply instead, so nothing is resent unless the
     * user writes something, and a Profile switch or edit clears it.
     */
    profile_failure: define(
        "profile_failure",
        "api_req_failed",
        [action("start_new_task", "Start New Task", "draft")],
        REPLY_INPUT,
        "none",
        "error_retry",
    ),
    mistake_limit: define("mistake_limit", "mistake_limit_reached", [
        action("process_anyway", "Process Anyway", "draft"),
        action("start_new_task", "Start New Task", "draft"),
    ]),
    completion: define(
        "completion",
        "completion_result",
        [action("start_new_task", "Start New Task", "draft")],
        REPLY_INPUT,
        "completion",
    ),
    resume: define("resume", "resume_task", [action("resume", "Resume", "draft")], RESUME_INPUT, "resume"),
    /**
     * Resuming a round the user stopped inside a live session.
     *
     * Identical to `resume` everywhere the user can see, and deliberately so:
     * both offer one Resume that carries the draft. They are separate kinds
     * because only `resume` may state that the session was closed and restored.
     * Sharing one kind made a cancelled round claim a restoration that never
     * happened, so the distinction has to live in the kind itself.
     */
    cancelled_resume: define(
        "cancelled_resume",
        "resume_task",
        [action("resume", "Resume", "draft")],
        RESUME_INPUT,
        "resume",
        "resume",
    ),
}

/** Return the immutable definition for one interaction kind. */
export function getInteraction(kind: InteractionKind): InteractionDefinition {
    return DEFINITIONS[kind]
}

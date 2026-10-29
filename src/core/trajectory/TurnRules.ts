import type { UiAsk, UiMessage, UiSay, UiSayTool } from "@shared/ExtensionMessage"
import { DlineDefaultTool } from "@shared/tools"

/**
 * The single rule set that divides committed chat rows into user turns and
 * attempts for the trajectory rail.
 *
 * Every rule reads only fields producers already persist, plus the kind of the
 * nearest preceding row that carries meaning. Producers are never asked to tag
 * rows for the rail (WS-117 D6), so a producer change surfaces here as a fixture
 * failure rather than as a silently miscounted rail.
 */

/** `interactionId` prefixes of feedback that answers an interaction instead of opening a turn. */
export const NON_TURN_INTERACTION_PREFIXES: readonly string[] = ["reply:", "command:", "tool-feedback:"]

/**
 * How untagged `user_feedback` that directly follows each ask is read.
 *
 * Follow-up, plan, report and Q&A handlers, and every approval dialog, persist
 * the user's answer through `sayFeedbackOnce` without an `interactionId` or
 * `userInputKind`, so the ask it answers is the only evidence that the row is a
 * tool reply. Asks that end or suspend the model's work invite a new instruction
 * instead. The record is exhaustive so a new ask kind cannot be added without
 * deciding how its replies count.
 */
const ASK_REPLY_ROLE: Readonly<Record<UiAsk, "tool_reply" | "turn_start">> = {
    followup: "tool_reply",
    make_plan: "tool_reply",
    act_mode_respond: "tool_reply",
    qna_respond: "tool_reply",
    generate_report: "tool_reply",
    command: "tool_reply",
    command_output: "tool_reply",
    tool: "tool_reply",
    browser_action_launch: "tool_reply",
    use_mcp_server: "tool_reply",
    new_task: "tool_reply",
    spawn_task: "tool_reply",
    condense: "tool_reply",
    change_todo_list: "tool_reply",
    summarize_task: "tool_reply",
    report_bug: "tool_reply",
    use_subagents: "tool_reply",
    status_acknowledgment: "tool_reply",
    completion_result: "turn_start",
    resume_task: "turn_start",
    resume_completed_task: "turn_start",
    api_req_failed: "turn_start",
    mistake_limit_reached: "turn_start",
}

/** Ask kinds whose untagged replies are tool replies rather than new turns. */
export const TOOL_DIALOG_ASKS: ReadonlySet<UiAsk> = new Set(
    (Object.keys(ASK_REPLY_ROLE) as UiAsk[]).filter((ask) => ASK_REPLY_ROLE[ask] === "tool_reply"),
)

/**
 * Infrastructure rows that never carry conversational meaning: they are skipped
 * when looking for the row a reply answers, and never count as rounds or tools.
 */
const CONTEXT_IGNORED_SAYS: ReadonlySet<UiSay> = new Set<UiSay>([
    "checkpoint_created",
    "hook_status",
    "hook_output_stream",
    "info",
    "task_progress",
    "state_snapshot",
    "conditional_rules_applied",
    "subagent_usage",
    "api_req_finished",
    "api_req_retried",
    "deleted_api_reqs",
    "error_retry",
])

/** The tool name of the compaction card, a `say: "tool"` row written when the context is summarized. */
const COMPACTION_TOOL_NAME = "summarizeTask"

/** Tool rows that are not tool calls the user made the model perform. */
const EXCLUDED_TOOL_NAMES: ReadonlySet<string> = new Set([COMPACTION_TOOL_NAME])

/**
 * Row keys that still carry the name of a tool that has since been renamed.
 *
 * Their handlers keep writing the former key so recorded and new rows render
 * alike, but the rail reports the tool the model actually calls today.
 */
const RENAMED_TOOL_ROW_KEYS: Readonly<Partial<Record<UiSayTool["tool"], DlineDefaultTool>>> = {
    actModeRespond: DlineDefaultTool.WORKING_RESPOND,
    statusUpdate: DlineDefaultTool.PHASE_REPORT,
}

/** Context the rules need from rows before the one being classified. */
export interface TurnContext {
    /** Ask kind of the nearest preceding meaningful row, or null when it was a say row or none exists. */
    readonly lastAskKind: UiAsk | null
}

/**
 * Whether the row is infrastructure that the context lookup skips.
 *
 * The compaction card is one: summarizing the context does not change which
 * dialog the next reply answers, so it must not clear the preceding ask.
 */
export function isContextIgnored(row: UiMessage): boolean {
    if (row.partial === true) return true
    if (row.type !== "say" || row.say === undefined) return false
    return CONTEXT_IGNORED_SAYS.has(row.say) || isCompactionCard(row)
}

function isCompactionCard(row: UiMessage): boolean {
    return row.say === "tool" && declaredToolName(row.text) === COMPACTION_TOOL_NAME
}

/** The ask kind a meaningful row leaves behind for the next row's classification. */
export function askKindAfter(row: UiMessage): UiAsk | null {
    return row.type === "ask" ? (row.ask ?? null) : null
}

/** Whether the row opens a new user turn. Partial rows never do. */
export function isTurnStart(row: UiMessage, context: TurnContext): boolean {
    if (row.partial === true || row.type !== "say") return false
    if (row.say === "task") return true
    if (row.say !== "user_feedback") return false
    if (row.userInputKind !== undefined) return true
    if (row.interactionId !== undefined) {
        return !NON_TURN_INTERACTION_PREFIXES.some((prefix) => row.interactionId?.startsWith(prefix))
    }
    // Untagged feedback: a reply to the dialog it follows, otherwise a new instruction.
    return context.lastAskKind === null || !TOOL_DIALOG_ASKS.has(context.lastAskKind)
}

/**
 * Whether the row is a completion the user accepted the work through.
 *
 * A completion first lands as a say row and is rewritten at the same ts into an
 * ask once it is presented; both shapes count. A refused completion closes with
 * empty text and does not end the attempt.
 */
export function isSuccessfulCompletion(row: UiMessage): boolean {
    if (row.partial === true) return false
    if (row.type === "ask") return row.ask === "completion_result"
    return row.say === "completion_result" && (row.text ?? "").trim().length > 0
}

/** Whether the row is one model round of the turn. */
export function isCountedRound(row: UiMessage): boolean {
    return row.partial !== true && row.type === "say" && row.say === "api_req_started"
}

/**
 * The tool a row records as called, or undefined when the row is not a tool call.
 *
 * Generic tool rows name their tool in the JSON body; dedicated rows are keyed by
 * their row kind. Checkpoint rows, the compaction card (a `summarizeTask` tool
 * row), retries, deleted-request markers and helper output rows are not tools.
 */
export function trajectoryToolKey(row: UiMessage): string | undefined {
    if (row.partial === true) return undefined
    const kind = row.type === "ask" ? row.ask : row.say
    switch (kind) {
        case "tool":
            return toolNameOf(row.text)
        case "command":
            return "execute_command"
        case "use_mcp_server":
            return "use_mcp_tool"
        case "browser_action_launch":
            return "browser_action"
        case "use_subagents":
            return "use_subagents"
        case "load_mcp_documentation":
            return "load_mcp_documentation"
        case "followup":
            return row.type === "ask" ? "ask_followup_question" : undefined
        case "make_plan":
            return row.type === "ask" ? "make_plan" : undefined
        case "generate_report":
            return row.type === "ask" ? "generate_report" : undefined
        case "new_task":
            return row.type === "ask" ? "new_task" : undefined
        case "spawn_task":
            return row.type === "ask" ? "spawn_task" : undefined
        case "change_todo_list":
            return row.type === "ask" ? "change_todo_list" : undefined
        default:
            return undefined
    }
}

function toolNameOf(text: string | undefined): string | undefined {
    const name = declaredToolName(text)
    if (name === undefined || EXCLUDED_TOOL_NAMES.has(name)) return undefined
    return RENAMED_TOOL_ROW_KEYS[name as UiSayTool["tool"]] ?? name
}

/** The `tool` field of a generic tool row's JSON body, or undefined when it has none. */
function declaredToolName(text: string | undefined): string | undefined {
    if (!text) return undefined
    try {
        const parsed: unknown = JSON.parse(text)
        if (typeof parsed !== "object" || parsed === null) return undefined
        const name = (parsed as { tool?: unknown }).tool
        return typeof name === "string" && name.length > 0 ? name : undefined
    } catch {
        return undefined
    }
}

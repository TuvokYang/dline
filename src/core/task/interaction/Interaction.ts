import type { UiAsk } from "@shared/ExtensionMessage"

/** All primary interaction definitions supported by the task runtime. */
export type InteractionKind =
    | "tool_approval"
    | "hosted_web_approval"
    | "command_approval"
    | "browser_approval"
    | "mcp_approval"
    | "subagent_approval"
    | "spawn_task_approval"
    | "change_todo_list"
    | "new_task"
    | "report_bug"
    | "condense"
    | "followup"
    | "make_plan"
    | "qna_response"
    | "generate_report"
    | "status_acknowledgment"
    | "error_retry"
    | "mistake_limit"
    | "completion"
    | "resume"
    | "cancelled_resume"

/** Interaction actions understood by the causal response protocol. */
export type InteractionActionType =
    | "approve"
    | "reject"
    | "reply"
    | "resume"
    | "retry"
    | "process_anyway"
    | "start_new_task"
    | "acknowledge"
    | "stop"
    | "confirm_utility"

/** Return whether a protocol action identifier is supported. */
export function isInteractionActionType(value: string): value is InteractionActionType {
    switch (value) {
        case "approve":
        case "reject":
        case "reply":
        case "resume":
        case "retry":
        case "process_anyway":
        case "start_new_task":
        case "acknowledge":
        case "stop":
        case "confirm_utility":
            return true
        default:
            return false
    }
}

/** Payload requirements for one interaction action. */
export type PayloadPolicy = "none" | "draft" | "selection" | "draft_and_selection"

/** Input behavior projected to the Webview. */
export interface InputPolicy {
    enabled: boolean
    acceptsText: boolean
    acceptsImages: boolean
    acceptsFiles: boolean
    enterAction?: InteractionActionType
}

/** Immutable action metadata owned by an interaction definition. */
export interface InteractionActionDefinition {
    type: InteractionActionType
    label: string
    appearance: "primary" | "secondary" | "danger"
    payloadPolicy: PayloadPolicy
}

/** One complete interaction definition. */
export type InteractionContinuation = "handler" | "api" | "resume" | "completion" | "none"

export interface InteractionDefinition {
    kind: InteractionKind
    taskAsk: UiAsk
    presentationKind: InteractionKind
    input: InputPolicy
    actions: readonly InteractionActionDefinition[]
    continuation: InteractionContinuation
}

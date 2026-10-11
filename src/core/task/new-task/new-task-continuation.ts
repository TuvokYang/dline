import type { ExplicitInstructionDeclaration } from "@core/task/explicit-instructions/types"
import type {
    ClineAssistantToolUseBlock,
    ClineContent,
    ClineStorageMessage,
    ClineUserToolResultContentBlock,
} from "@shared/messages/content"
import { DlineDefaultTool } from "@shared/tools"

/** Stable handler-owned marker for one New Task feedback tool result. */
export const NEW_TASK_FEEDBACK_CONTINUATION_MARKER = "<!-- dline:new-task-feedback:v1 -->"

export interface NewTaskContinuationToolUse {
    readonly type: "tool_use"
    readonly name: string
    readonly function_id: string
    readonly dline_tid: string
    readonly partial?: boolean
}

export interface NewTaskFeedbackContinuationInput {
    /** Content being prepared for the next ordinary Provider request. */
    readonly userContent: readonly ClineContent[]
    /** Canonical assistant tool identities retained for this conversation. */
    readonly assistantContent: readonly NewTaskContinuationToolUse[]
    /** Durable request replay must never mint fresh hidden-tool authority. */
    readonly persistedRequest: boolean
}

/** Return whether a tool result contains the handler-owned continuation marker. */
function hasFeedbackMarker(block: ClineUserToolResultContentBlock): boolean {
    if (typeof block.content === "string") return block.content.includes(NEW_TASK_FEEDBACK_CONTINUATION_MARKER)
    return block.content.some(
        (content) => content.type === "text" && content.text.includes(NEW_TASK_FEEDBACK_CONTINUATION_MARKER),
    )
}

/** Derive one fail-closed declaration from a trusted New Task feedback result. */
export function deriveNewTaskFeedbackContinuation(
    input: NewTaskFeedbackContinuationInput,
): ExplicitInstructionDeclaration | undefined {
    if (input.persistedRequest) return undefined
    const candidates = input.userContent.filter(
        (block): block is ClineUserToolResultContentBlock =>
            block.type === "tool_result" && block.is_error !== true && hasFeedbackMarker(block),
    )
    if (candidates.length !== 1) return undefined

    const result = candidates[0]
    const matchingTools = input.assistantContent.filter(
        (block) =>
            block.type === "tool_use" &&
            block.partial !== true &&
            block.name === DlineDefaultTool.NEW_TASK &&
            block.function_id === result.function_id &&
            block.dline_tid === result.dline_tid,
    )
    if (matchingTools.length !== 1) return undefined

    return {
        type: "new_task",
        source: "internal_continuation",
        targetTool: DlineDefaultTool.NEW_TASK,
        operationId: `new-task-feedback:${result.dline_tid}`,
        metadata: {
            functionId: result.function_id,
            dlineTid: result.dline_tid,
        },
    }
}

/**
 * Derive the continuation a provider request grants from the conversation it sends.
 *
 * The request answers the content after the last assistant message, so only a
 * feedback result there can authorize this round; every retained tool call is
 * a candidate for the declaration it must pair with.
 */
export function deriveNewTaskFeedbackContinuationFromConversation(
    messages: readonly ClineStorageMessage[],
): ExplicitInstructionDeclaration | undefined {
    let lastAssistant = messages.length - 1
    while (lastAssistant >= 0 && messages[lastAssistant].role !== "assistant") lastAssistant--
    if (lastAssistant < 0) return undefined
    const userContent = messages
        .slice(lastAssistant + 1)
        .flatMap((message) => (message.role === "user" && Array.isArray(message.content) ? message.content : []))
    const assistantContent = messages.flatMap((message) =>
        message.role === "assistant" && Array.isArray(message.content)
            ? message.content.filter((block): block is ClineAssistantToolUseBlock => block.type === "tool_use")
            : [],
    )
    return deriveNewTaskFeedbackContinuation({ userContent, assistantContent, persistedRequest: false })
}

import { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { MAX_TOOL_RESULT_TEXT_BYTES, truncateContent } from "@shared/content-limits"
import type { ClineContent, ClineUserToolResultContentBlock } from "@/shared/messages/content"
import { Logger } from "@/shared/services/Logger"
import { toolApprovalFeedbackText } from "../../utils/buildUserFeedbackContent"
import type { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import type { ToolResponse } from "../ToolResponse"

/**
 * Sentinel tool response meaning "the tool turn must not emit a tool_result".
 *
 * Manual condense confirmation truncates the conversation before the handler
 * returns, so the pairing tool_use is deleted from history. Writing a
 * tool_result afterwards would leave an orphaned result behind (projected as
 * call_dline_* by the OpenAI transformer) and fail the next request with
 * "No tool call found for tool output". Only the regenerate (reject) path
 * needs to return feedback content to the model.
 */
export const NO_TOOL_RESULT = "__dline_no_tool_result__"

/**
 * Utility functions for handling tool results and feedback
 */
interface PendingToolFeedbackBlock {
    type: "tool_feedback"
    dlineTid?: string
    content: ToolResponse
}

type ToolResultMessageContent = ClineContent | PendingToolFeedbackBlock

export class ToolResultUtils {
    // biome-ignore lint/complexity/noStaticOnlyClass: utility class with static methods only
    private constructor() {}

    /**
     * Check whether a user message block is pending approval feedback.
     *
     * @param block Candidate user message content block.
     * @returns True when the block should be merged into the next tool_result.
     */
    private static isPendingFeedback(block: unknown): block is PendingToolFeedbackBlock {
        return Boolean(block && typeof block === "object" && (block as PendingToolFeedbackBlock).type === "tool_feedback")
    }

    /**
     * Drain pending approval feedback before the current tool result is pushed.
     *
     * @param userMessageContent Mutable next-user-message content list.
     * @returns Feedback content blocks to append inside the tool_result.
     */
    private static drainPendingFeedback(userMessageContent: ToolResultMessageContent[], dlineTid: string): ToolResponse[] {
        const pendingFeedback: ToolResponse[] = []
        for (let i = userMessageContent.length - 1; i >= 0; i--) {
            const block = userMessageContent[i]
            if (ToolResultUtils.isPendingFeedback(block) && (block.dlineTid === undefined || block.dlineTid === dlineTid)) {
                pendingFeedback.unshift(block.content)
                userMessageContent.splice(i, 1)
            }
        }
        return pendingFeedback
    }

    /**
     * Merge tool execution result with approval feedback content.
     *
     * @param resultText Main tool result text.
     * @param feedbackContent Pending approval feedback content blocks.
     * @returns A string result when no feedback exists, otherwise content blocks.
     */
    private static mergeTextResult(resultText: string, feedbackContent: ToolResponse[]): ToolResponse {
        if (feedbackContent.length === 0) {
            return resultText
        }
        return [{ type: "text", text: resultText }, ...ToolResultUtils.flattenFeedback(feedbackContent)]
    }

    /**
     * Merge structured tool result content with approval feedback content.
     *
     * @param content Structured tool result content.
     * @param feedbackContent Pending approval feedback content blocks.
     * @returns Structured content with feedback appended.
     */
    private static mergeStructuredResult(content: ToolResponse, feedbackContent: ToolResponse[]): ToolResponse {
        if (feedbackContent.length === 0) {
            return content
        }
        const baseContent = Array.isArray(content) ? content : ([{ type: "text", text: String(content) }] as const)
        return [...baseContent, ...ToolResultUtils.flattenFeedback(feedbackContent)]
    }

    /**
     * Bound the text one canonical tool result contributes to the conversation.
     *
     * Every executed result, whichever path produced it, is held to the same
     * ceiling: a result that escapes it reaches every later request verbatim and
     * can by itself push the conversation past the window it was sized for.
     * Non-text blocks are kept as they are.
     */
    /**
     * The text a tool's string result is sent as: the call, then what it returned.
     *
     * The description names what the call acted on - the file read, the command
     * run - so two calls that returned the same text stay distinguishable to the
     * model, and a provider prefix built from them does not collapse.
     */
    static describeTextResult(description: string, text: string): string {
        return `${description} Result:\n${text || "(tool did not return anything)"}`
    }

    static boundContent(content: ToolResponse): ToolResponse {
        return typeof content === "string"
            ? truncateContent(content, MAX_TOOL_RESULT_TEXT_BYTES)
            : ToolResultUtils.boundStructuredResult(content)
    }

    /** Bound one tool result's generated text while preserving non-text blocks and user feedback. */
    private static boundStructuredResult(content: Exclude<ToolResponse, string>): ToolResponse {
        let remainingBytes = MAX_TOOL_RESULT_TEXT_BYTES
        const bounded: typeof content = []
        for (const block of content) {
            if (block.type !== "text") {
                bounded.push(block)
                continue
            }
            if (remainingBytes <= 0) continue
            const text = truncateContent(block.text, remainingBytes)
            if (!text) continue
            bounded.push({ ...block, text })
            remainingBytes = Math.max(0, remainingBytes - Buffer.byteLength(text, "utf8"))
        }
        return bounded
    }

    /**
     * Flatten formatted feedback into tool_result-compatible content blocks.
     *
     * @param feedbackContent Feedback entries captured from approval UI.
     * @returns Flattened text/image content blocks.
     */
    private static flattenFeedback(feedbackContent: ToolResponse[]): Exclude<ToolResponse, string> {
        return feedbackContent.flatMap((content) =>
            Array.isArray(content) ? content : ([{ type: "text", text: content }] as const),
        )
    }

    /**
     * Resolve where a new tool_result must be inserted in the pending user message.
     *
     * Providers require every tool_result answering an assistant tool_use batch to
     * appear before any other block of that user message. Tools may push their own
     * blocks first (for example read_file pushing an image block, or a hook pushing
     * context text), so appending blindly would leave the tool_result behind a
     * non-result block and make Anthropic reject the request with
     * "`tool_use` ids were found without `tool_result` blocks immediately after".
     *
     * @param userMessageContent Mutable next-user-message content list.
     * @returns Index directly after the last existing tool_result, otherwise 0.
     */
    private static findToolResultInsertIndex(userMessageContent: ToolResultMessageContent[]): number {
        let insertIndex = 0
        for (let i = 0; i < userMessageContent.length; i++) {
            if (userMessageContent[i]?.type === "tool_result") {
                insertIndex = i + 1
            }
        }
        return insertIndex
    }

    /**
     * Create a canonical native tool result without consulting runtime maps.
     *
     * @param content Tool result content.
     * @param block Native tool use carrying provider and Dline identities.
     * @returns Canonical structured tool result.
     */
    static createResult(content: ToolResponse, block: ToolUse, isError?: boolean): ClineUserToolResultContentBlock {
        if (!block.function_id || !block.dline_tid) {
            throw new Error(`Native tool result is missing canonical identity: tool=${block.name}`)
        }
        return {
            type: "tool_result",
            function_id: block.function_id,
            dline_tid: block.dline_tid,
            content: typeof content === "string" ? [{ type: "text", text: content }] : content,
            ...(isError === undefined ? {} : { is_error: isError }),
        }
    }

    /**
     * Push tool result to user message content with proper formatting
     */
    static pushToolResult(
        content: ToolResponse,
        block: ToolUse,
        userMessageContent: ToolResultMessageContent[],
        toolDescription: (block: ToolUse) => string,
        coordinator: ToolExecutorCoordinator | undefined,
        isError?: boolean,
    ): ClineUserToolResultContentBlock {
        const pendingFeedback = ToolResultUtils.drainPendingFeedback(userMessageContent, block.dline_tid)
        const existingIndex = userMessageContent.findIndex(
            (item) => item.type === "tool_result" && item.function_id === block.function_id,
        )
        const storeResult = (result: ClineUserToolResultContentBlock): ClineUserToolResultContentBlock => {
            if (existingIndex !== -1) {
                userMessageContent[existingIndex] = result
                Logger.warn(`ToolResultUtils: Replaced existing tool_result for function_id ${block.function_id}`)
                return result
            }
            // Keep every tool_result ahead of images, hook context and feedback text
            // so the provider pairing contract holds for the whole tool batch.
            userMessageContent.splice(ToolResultUtils.findToolResultInsertIndex(userMessageContent), 0, result)
            return result
        }

        if (typeof content === "string") {
            // Try to get description from coordinator first, otherwise use the provided function
            const description = coordinator
                ? (() => {
                      const handler = coordinator.getHandler(block.name)
                      return handler ? handler.getDescription(block) : toolDescription(block)
                  })()
                : toolDescription(block)

            // Replace an existing tool_result for the same function_id with the
            // latest result. When a tool is re-executed (e.g. partial→reRender
            // lifecycle), the newer error message (e.g. "Document not initialized")
            // replaces the older one (e.g. "SEARCH block not found"). The final
            // result is what the AI sees, and ensureToolResultsFollowToolUse
            // deduplicates by function_id before sending to the API.
            const boundedResult = truncateContent(
                ToolResultUtils.describeTextResult(description, content),
                MAX_TOOL_RESULT_TEXT_BYTES,
            )
            const mergedContent = ToolResultUtils.mergeTextResult(boundedResult, pendingFeedback)
            return storeResult(ToolResultUtils.createResult(mergedContent, block, isError))
        }
        // Bound tool-generated text before user approval feedback is merged.
        const boundedContent = ToolResultUtils.boundStructuredResult(content)
        const mergedContent = ToolResultUtils.mergeStructuredResult(boundedContent, pendingFeedback)
        return storeResult(ToolResultUtils.createResult(mergedContent, block, isError))
    }

    /**
     * Push additional tool feedback from user to message content
     */
    static pushAdditionalToolFeedback(
        userMessageContent: ToolResultMessageContent[],
        feedback?: string,
        images?: string[],
        fileContentString?: string,
        dlineTid?: string,
    ): void {
        // Check if we have any meaningful content to add
        const hasMeaningfulFeedback = feedback && feedback.trim() !== ""
        const hasImages = images && images.length > 0
        const hasMeaningfulFileContent = fileContentString && fileContentString.trim() !== ""

        // Only proceed if we have at least one meaningful piece of content
        if (!hasMeaningfulFeedback && !hasImages && !hasMeaningfulFileContent) {
            return
        }

        const content = formatResponse.toolResult(
            toolApprovalFeedbackText(hasMeaningfulFeedback ? feedback : undefined),
            images,
            hasMeaningfulFileContent ? fileContentString : undefined,
        )
        userMessageContent.push({
            type: "tool_feedback",
            content,
            ...(dlineTid ? { dlineTid } : {}),
        } satisfies PendingToolFeedbackBlock)
    }
}

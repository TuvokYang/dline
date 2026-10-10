import type { Anthropic } from "@anthropic-ai/sdk"
import type { ApiProvider } from "@/shared/api"
import type { ClineAssistantToolUseBlock, ClineUserToolResultContentBlock } from "@/shared/messages/content"

const MAX_CHAT_FUNCTION_ID_LENGTH = 40
const RESPONSES_ITEM_PREFIX = "fc_"
const RESPONSES_ITEM_LENGTH = 53
const DLINE_FUNCTION_PREFIX = "dline_function_"
const DLINE_CALL_PREFIX = "call_dline_"
const MAX_DLINE_CALL_SUFFIX_LENGTH = MAX_CHAT_FUNCTION_ID_LENGTH - DLINE_CALL_PREFIX.length

/** Error raised when a canonical tool block cannot be projected safely. */
export class ToolIdentityProjectionError extends Error {
    /**
     * Create a tool identity projection error.
     *
     * @param protocol Target provider protocol.
     * @param blockType Tool block type being projected.
     */
    constructor(protocol: string, blockType: string, missingField = "function_id") {
        super(`Canonical ${blockType} is missing ${missingField} for ${protocol} projection`)
        this.name = "ToolIdentityProjectionError"
    }
}

/**
 * Resolve the canonical pairing identity from a tool-use block.
 *
 * @param block Stored tool-use block.
 * @returns Canonical function identity or the legacy Anthropic identity.
 */
export function getUseFunctionId(block: ClineAssistantToolUseBlock): string {
    if (!block.function_id) {
        throw new ToolIdentityProjectionError("canonical", "tool_use")
    }
    return block.function_id
}

/**
 * Resolve the canonical pairing identity from a tool-result block.
 *
 * @param block Stored tool-result block.
 * @returns Canonical function identity or the legacy Anthropic identity.
 */
export function getResultFunctionId(block: ClineUserToolResultContentBlock): string {
    if (!block.function_id) {
        throw new ToolIdentityProjectionError("canonical", "tool_result")
    }
    return block.function_id
}

/**
 * Project a canonical function identity to the Chat Completions ID domain.
 *
 * @param functionId Canonical provider function identity.
 * @param provider Target API provider.
 * @returns Chat-compatible function identity used by both call and result.
 */
export function projectChatFunctionId(functionId: string, _provider?: ApiProvider): string {
    if (functionId.startsWith(RESPONSES_ITEM_PREFIX) && functionId.length === RESPONSES_ITEM_LENGTH) {
        return `call_${functionId.slice(functionId.length - (MAX_CHAT_FUNCTION_ID_LENGTH - 5))}`
    }
    if (functionId.startsWith(DLINE_FUNCTION_PREFIX)) {
        // Dline-owned identities for non-native tool calls must never reach the
        // provider: project them deterministically into the call-id domain so
        // both pairing sides (and later turns) map to the same provider id.
        const suffix = functionId.slice(DLINE_FUNCTION_PREFIX.length)
        return `${DLINE_CALL_PREFIX}${suffix.slice(0, MAX_DLINE_CALL_SUFFIX_LENGTH)}`
    }
    return functionId
}

/**
 * Project a canonical tool use to Anthropic pairing fields.
 *
 * @param block Stored canonical or legacy tool-use block.
 * @returns Anthropic tool-use block with the canonical pairing identity.
 */
export function projectAnthropicUse(block: ClineAssistantToolUseBlock): Anthropic.Messages.ToolUseBlockParam {
    const functionId = getUseFunctionId(block)
    if (!functionId) {
        throw new ToolIdentityProjectionError("Anthropic", "tool_use")
    }
    return {
        type: "tool_use",
        id: functionId,
        name: block.name,
        input: block.input,
    }
}

/**
 * Project a canonical tool result to Anthropic pairing fields.
 *
 * @param block Stored canonical or legacy tool-result block.
 * @returns Anthropic tool-result block with the canonical pairing identity.
 */
export function projectAnthropicResult(block: ClineUserToolResultContentBlock): Anthropic.Messages.ToolResultBlockParam {
    const functionId = getResultFunctionId(block)
    if (!functionId) {
        throw new ToolIdentityProjectionError("Anthropic", "tool_result")
    }
    return {
        type: "tool_result",
        tool_use_id: functionId,
        content: block.content,
        ...(block.is_error === undefined ? {} : { is_error: block.is_error }),
    }
}

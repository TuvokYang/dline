import type { ClineAssistantRedactedThinkingBlock, ClineAssistantThinkingBlock, ClineContent } from "./content"

/** Stored reasoning block shared by every provider protocol. */
export type ClineReasoningBlock = ClineAssistantThinkingBlock | ClineAssistantRedactedThinkingBlock

/**
 * Return whether a stored content block holds model reasoning.
 *
 * @param block Any canonical content block.
 * @returns True for `thinking` and `redacted_thinking` blocks.
 */
export function isReasoningBlock(block: ClineContent): block is ClineReasoningBlock {
	return block.type === "thinking" || block.type === "redacted_thinking"
}

/**
 * Return whether a stored reasoning block was issued by a protocol other than Anthropic Messages.
 *
 * Reasoning payloads (`redacted_thinking.data`, `thinking.signature`) are opaque ciphertext that
 * only the issuing protocol can verify; Anthropic rejects a foreign payload with a 400.
 *
 * The origin is inferred from the producer shape rather than persisted provenance:
 * - OpenAI Responses and Gemini attach a `provider_metadata` object to every reasoning chunk
 *   (Gemini even when its response id is missing, which persists as `{}`).
 * - Every Anthropic Messages-family stream (Anthropic, Claude Code, Vertex Claude, Bedrock,
 *   MiniMax) emits reasoning without provider metadata, so the stored value is `undefined`.
 *
 * This is a producer-shape heuristic, not an issuer proof: reasoning from other unmarked issuers
 * is indistinguishable and is treated as native.
 *
 * @param block A stored reasoning block.
 * @returns True when the block must not be replayed to an Anthropic Messages endpoint.
 */
export function isForeignReasoningForAnthropic(block: ClineReasoningBlock): boolean {
	return typeof block.provider_metadata === "object" && block.provider_metadata !== null
}

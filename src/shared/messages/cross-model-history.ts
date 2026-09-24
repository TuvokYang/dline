import type { ClineAssistantThinkingBlock, ClineContent, ClineStorageMessage, ClineTextContentBlock } from "./content"

/**
 * Request-time projection of history written by a different model.
 *
 * A task can continue on another model mid-conversation. Another model's opaque reasoning
 * (ciphertext, response ids) is only valid for the protocol that issued it, but its readable
 * reasoning is still useful context. Foreign assistant turns therefore keep their readable
 * reasoning as `<prior_model_reasoning>` text and lose provider replay metadata, and the first user
 * turn after the last foreign assistant turn that survives projection carries one fixed switch notice.
 *
 * Model identity decides which turns are foreign and is never written into request content:
 * the tag has no attributes and the notice names no model.
 */

const PRIOR_MODEL_REASONING_TAG = "prior_model_reasoning"

export const MODEL_SWITCH_NOTICE = [
	"<model_switch_notice>",
	"Earlier assistant turns in this conversation were produced by a different model.",
	`Text inside <${PRIOR_MODEL_REASONING_TAG}> tags is that model's reasoning, kept only as reference; it is not your own reasoning.`,
	"Continue the task from the current state and never write these tags yourself.",
	"</model_switch_notice>",
].join("\n")

/** Whether a stored message is an assistant turn produced by a model other than the target. */
export function isForeignAssistantMessage(message: ClineStorageMessage, targetModelId: string): boolean {
	if (message.role !== "assistant") return false
	const producerModelId = message.modelInfo?.modelId
	return typeof producerModelId === "string" && producerModelId.length > 0 && producerModelId !== targetModelId
}

/**
 * Project stored history for a request sent to `targetModelId`.
 *
 * Pure and idempotent: the input is never mutated, messages that need no change are returned by
 * reference, and projecting an already projected history yields the same result.
 */
export function projectCrossModelHistory(messages: readonly ClineStorageMessage[], targetModelId: string): ClineStorageMessage[] {
	const projected: ClineStorageMessage[] = []
	let noticeSearchStart: number | undefined

	for (const message of messages) {
		if (!isForeignAssistantMessage(message, targetModelId)) {
			projected.push(message)
			continue
		}
		const foreign = projectForeignAssistant(message)
		if (!foreign) continue
		projected.push(foreign)
		// Anchor to turns the target can see; a dropped turn leaves nothing to explain.
		noticeSearchStart = projected.length
	}

	if (noticeSearchStart === undefined) return projected
	const noticeIndex = projected.findIndex((message, index) => index >= noticeSearchStart && message.role === "user")
	if (noticeIndex >= 0) projected[noticeIndex] = withSwitchNotice(projected[noticeIndex])
	return projected
}

/** Returns undefined when nothing readable remains, so the caller drops the turn. */
function projectForeignAssistant(message: ClineStorageMessage): ClineStorageMessage | undefined {
	// Another model's response id must never become `previous_response_id` for the target.
	const { provider_metadata: _foreignResponse, ...rest } = message
	if (typeof message.content === "string") return rest

	const content = message.content.flatMap(projectForeignBlock)
	return content.length > 0 ? { ...rest, content } : undefined
}

function projectForeignBlock(block: ClineContent): ClineContent[] {
	if (block.type === "redacted_thinking") return []
	if (block.type === "thinking") {
		const reasoning = readableReasoning(block)
		return reasoning ? [{ type: "text", text: wrapPriorModelReasoning(reasoning) }] : []
	}
	if (!("provider_metadata" in block)) return [block]
	// Signatures and reasoning_details stay: each target converter already applies its own policy to them.
	const { provider_metadata: _foreignItem, ...rest } = block
	return [rest as ClineContent]
}

function readableReasoning(block: ClineAssistantThinkingBlock): string {
	if (block.thinking?.trim()) return block.thinking
	const summaryTexts = (block.summary ?? []).flatMap((item) => {
		const text = typeof item === "object" && item !== null ? (item as { text?: unknown }).text : undefined
		return typeof text === "string" && text.trim() ? [text] : []
	})
	return summaryTexts.join("\n\n")
}

function wrapPriorModelReasoning(reasoning: string): string {
	// Neutralize an embedded closing tag so quoted reasoning cannot end the wrapper early.
	const body = reasoning.replace(new RegExp(`</(${PRIOR_MODEL_REASONING_TAG})`, "gi"), "<\\/$1")
	return `<${PRIOR_MODEL_REASONING_TAG}>\n${body}\n</${PRIOR_MODEL_REASONING_TAG}>`
}

function withSwitchNotice(message: ClineStorageMessage): ClineStorageMessage {
	const notice: ClineTextContentBlock = { type: "text", text: MODEL_SWITCH_NOTICE }
	if (typeof message.content === "string") {
		return { ...message, content: message.content ? [{ type: "text", text: message.content }, notice] : [notice] }
	}
	const alreadyNoticed = message.content.some((block) => block.type === "text" && block.text === MODEL_SWITCH_NOTICE)
	return alreadyNoticed ? message : { ...message, content: [...message.content, notice] }
}

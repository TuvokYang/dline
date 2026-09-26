import { describe, expect, it } from "vitest"
import { isForeignReasoningForAnthropic } from "@/shared/messages/reasoning-origin"
import { MAX_ENCRYPTED_REASONING_ITEMS } from "../reasoning-retention"
import { StreamResponseHandler } from "../StreamResponseHandler"

function createHandler(): StreamResponseHandler {
	let ts = 0
	return new StreamResponseHandler(() => ++ts)
}

describe("ReasoningHandler encrypted reasoning accumulation", () => {
	it("refreshes repeated snapshots of one reasoning item instead of appending them", () => {
		const handler = createHandler()
		const { reasonsHandler } = handler.getHandlers()

		// One Responses reasoning item streams several in-progress snapshots before completing.
		reasonsHandler.processReasoningDelta({
			provider_metadata: { response_id: "rs_1" },
			redacted_data: "snapshot-1",
			redacted_phase: "partial",
		})
		reasonsHandler.processReasoningDelta({
			provider_metadata: { response_id: "rs_1" },
			redacted_data: "snapshot-2",
			redacted_phase: "partial",
		})
		reasonsHandler.processReasoningDelta({
			provider_metadata: { response_id: "rs_1" },
			redacted_data: "authoritative-payload",
			redacted_phase: "final",
		})

		const blocks = reasonsHandler.getRedactedThinking()
		expect(blocks).toHaveLength(1)
		expect(blocks[0]).toMatchObject({
			type: "redacted_thinking",
			data: "authoritative-payload",
			provider_metadata: { response_id: "rs_1" },
		})
	})

	it("preserves the newest snapshot when the stream is interrupted before completion", () => {
		const handler = createHandler()
		const { reasonsHandler } = handler.getHandlers()

		reasonsHandler.processReasoningDelta({
			provider_metadata: { response_id: "rs_1" },
			redacted_data: "partial-payload",
			redacted_phase: "partial",
		})

		const blocks = reasonsHandler.getRedactedThinking()
		expect(blocks).toHaveLength(1)
		expect(blocks[0].data).toBe("partial-payload")
	})

	it("keeps distinct reasoning items separate", () => {
		const handler = createHandler()
		const { reasonsHandler } = handler.getHandlers()

		for (const responseId of ["rs_1", "rs_2", "rs_3"]) {
			reasonsHandler.processReasoningDelta({
				provider_metadata: { response_id: responseId },
				redacted_data: `payload-${responseId}`,
				redacted_phase: "final",
			})
		}

		expect(reasonsHandler.getRedactedThinking().map((block) => block.data)).toEqual([
			"payload-rs_1",
			"payload-rs_2",
			"payload-rs_3",
		])
	})

	it("bounds accumulation when a long turn streams far more items than the budget allows", () => {
		const handler = createHandler()
		const { reasonsHandler } = handler.getHandlers()

		for (let index = 0; index < MAX_ENCRYPTED_REASONING_ITEMS * 4; index++) {
			reasonsHandler.processReasoningDelta({
				provider_metadata: { response_id: `rs_${index}` },
				redacted_data: "E".repeat(64),
				redacted_phase: "final",
			})
		}

		expect(reasonsHandler.getRedactedThinking().length).toBeLessThanOrEqual(MAX_ENCRYPTED_REASONING_ITEMS)
	})

	it("clears accumulated reasoning when the handler is reset between requests", () => {
		const handler = createHandler()

		handler.getHandlers().reasonsHandler.processReasoningDelta({
			provider_metadata: { response_id: "rs_1" },
			redacted_data: "payload",
			redacted_phase: "final",
		})
		expect(handler.getHandlers().reasonsHandler.getRedactedThinking()).toHaveLength(1)

		handler.reset()
		expect(handler.getHandlers().reasonsHandler.getRedactedThinking()).toHaveLength(0)
	})
})

/**
 * Anthropic replay relies on the producer shape recorded here (BUGFIX-088): Anthropic-family
 * streams emit reasoning without provider metadata, OpenAI Responses and Gemini always attach it.
 * Blocks are checked after a JSON round trip, which is how persisted history reaches the boundary.
 */
describe("ReasoningHandler reasoning origin shape", () => {
	function persisted<T>(value: T | null): T {
		expect(value).not.toBeNull()
		return JSON.parse(JSON.stringify(value)) as T
	}

	it("records Anthropic-family thinking and redacted thinking as replayable to Anthropic", () => {
		const { reasonsHandler } = createHandler().getHandlers()

		reasonsHandler.processReasoningDelta({ reasoning: "Plan the edit" })
		reasonsHandler.processReasoningDelta({ reasoning: "", signature: "claude-signature" })
		reasonsHandler.processReasoningDelta({ reasoning: "[Redacted thinking block]", redacted_data: "claude-ciphertext" })

		const [redacted] = reasonsHandler.getRedactedThinking()
		expect(isForeignReasoningForAnthropic(persisted(reasonsHandler.getCurrentReasoning()))).toBe(false)
		expect(isForeignReasoningForAnthropic(persisted(redacted))).toBe(false)
		expect(redacted.data).toBe("claude-ciphertext")
	})

	it("records OpenAI Responses encrypted reasoning as foreign to Anthropic", () => {
		const { reasonsHandler } = createHandler().getHandlers()

		reasonsHandler.processReasoningDelta({ provider_metadata: { response_id: "rs_1" }, reasoning: "summary" })
		reasonsHandler.processReasoningDelta({
			provider_metadata: { response_id: "rs_1" },
			reasoning: "",
			redacted_data: "openai-ciphertext",
			redacted_phase: "final",
		})

		const [redacted] = reasonsHandler.getRedactedThinking()
		expect(isForeignReasoningForAnthropic(persisted(redacted))).toBe(true)
		expect(isForeignReasoningForAnthropic(persisted(reasonsHandler.getCurrentReasoning()))).toBe(true)
	})

	it("records Gemini thinking as foreign even when the first chunk had no response id", () => {
		const { reasonsHandler } = createHandler().getHandlers()

		reasonsHandler.processReasoningDelta({
			provider_metadata: { response_id: undefined },
			reasoning: "Gemini thought",
			signature: "gemini-thought-signature",
		})
		reasonsHandler.processReasoningDelta({ provider_metadata: { response_id: "gemini-response-1" }, reasoning: " more" })

		const thinking = persisted(reasonsHandler.getCurrentReasoning())
		expect(thinking.signature).toBe("gemini-thought-signature")
		expect(isForeignReasoningForAnthropic(thinking)).toBe(true)
	})
})

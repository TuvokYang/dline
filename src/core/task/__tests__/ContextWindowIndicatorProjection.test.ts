import { estimateContextWindowCandidate } from "@core/context/context-management/context-window-projection"
import type { ClineStorageMessage } from "@shared/messages/content"
import { describe, expect, it } from "vitest"
import {
	estimateContextWindowIndicatorSegments,
	projectAuthoritativeContextWindowIndicatorSegments,
} from "../ContextWindowIndicatorProjection"
import type { CompactionProviderInput } from "../compaction/CompactionProviderInput"

function providerInput(messages: ClineStorageMessage[]): CompactionProviderInput {
	return {
		systemPrompt: "system prompt",
		messages,
		tools: [],
		serverTools: [],
	}
}

describe("ContextWindowIndicatorProjection", () => {
	it("decomposes one ordinary frozen input without overlapping the latest turn and environment", () => {
		const input = providerInput([
			{ role: "user", content: [{ type: "text", text: "durable user turn" }] },
			{ role: "assistant", content: [{ type: "text", text: "durable assistant turn" }] },
			{
				role: "user",
				content: [
					{ type: "text", text: "pending user turn" },
					{ type: "text", text: "<environment_details>dynamic environment snapshot</environment_details>" },
				],
			},
		])

		const segments = estimateContextWindowIndicatorSegments({ providerInput: input, durableMessageCount: 2 })

		expect(segments.durableContextTokens).toBeGreaterThan(0)
		expect(segments.pendingSendTokens).toBeGreaterThan(0)
		expect(segments.environmentTokens).toBeGreaterThan(0)
		expect(segments.durableContextTokens + segments.pendingSendTokens + segments.environmentTokens).toBe(segments.totalTokens)
		expect(segments.totalTokens).toBe(estimateContextWindowCandidate(input))
	})

	it("counts only the latest dynamic environment while historical environments remain durable", () => {
		const input = providerInput([
			{
				role: "user",
				content: [
					{ type: "text", text: "historical turn" },
					{ type: "text", text: "<environment_details>historical environment snapshot</environment_details>" },
				],
			},
			{ role: "assistant", content: [{ type: "text", text: "historical response" }] },
			{
				role: "user",
				content: [
					{ type: "text", text: "current turn" },
					{ type: "text", text: "<environment_details>current environment snapshot</environment_details>" },
				],
			},
		])
		const withoutLatestEnvironment = providerInput([
			...input.messages.slice(0, -1),
			{ role: "user", content: [{ type: "text", text: "current turn" }] },
		])
		const expectedCurrentEnvironmentTokens =
			estimateContextWindowCandidate(input) - estimateContextWindowCandidate(withoutLatestEnvironment)

		const segments = estimateContextWindowIndicatorSegments({ providerInput: input, durableMessageCount: 2 })

		expect(segments.environmentTokens).toBe(expectedCurrentEnvironmentTokens)
		expect(segments.durableContextTokens).toBeGreaterThan(expectedCurrentEnvironmentTokens)
		expect(segments.durableContextTokens + segments.pendingSendTokens + segments.environmentTokens).toBe(segments.totalTokens)
	})

	it("allocates an authoritative projected total without reusing the absolute local estimate", () => {
		expect(
			projectAuthoritativeContextWindowIndicatorSegments({
				projectedTotalTokens: 6_388,
				durableContextTokens: 5_800,
				estimatedEnvironmentTokens: 364,
			}),
		).toEqual({
			durableContextTokens: 5_800,
			pendingSendTokens: 224,
			environmentTokens: 364,
			totalTokens: 6_388,
		})
	})

	it("treats a cumulative summary as durable and the selected Pass batch as pending", () => {
		const input = providerInput([
			{ role: "user", content: [{ type: "text", text: "cumulative summary" }] },
			{ role: "user", content: [{ type: "text", text: "selected logical turn A" }] },
			{ role: "assistant", content: [{ type: "text", text: "selected logical turn A response" }] },
			{ role: "user", content: [{ type: "text", text: "summarize_task instruction" }] },
		])

		const segments = estimateContextWindowIndicatorSegments({ providerInput: input, durableMessageCount: 1 })

		expect(segments.durableContextTokens).toBeGreaterThan(0)
		expect(segments.pendingSendTokens).toBeGreaterThan(segments.durableContextTokens)
		expect(segments.environmentTokens).toBe(0)
		expect(segments.durableContextTokens + segments.pendingSendTokens).toBe(segments.totalTokens)
	})
})

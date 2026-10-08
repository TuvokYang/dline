import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { parseLegacyUsageMessages } from "./api-request-round-legacy-usage-parser"

function message(ts: number, say: UiMessage["say"], info: object, overrides: Partial<UiMessage> = {}): UiMessage {
	return { ts, type: "say", say, text: JSON.stringify(info), ...overrides }
}

describe("legacy API request usage parser", () => {
	it("extracts a completed legacy round without inventing Provider duration", () => {
		const result = parseLegacyUsageMessages("task-a", [
			message(1_000, "api_req_started", { request: "prompt" }, { conversationHistoryIndex: 7 }),
			message(2_000, "api_req_finished", {
				tokensIn: 1_200,
				tokensOut: 200,
				cacheWrites: 100,
				cacheReads: 300,
				cost: 0.12,
				currency: "USD",
			}),
		])

		expect(result.rounds).toEqual([
			expect.objectContaining({
				roundId: "task-a:legacy-ui:1000:provider:0",
				logicalRequestId: "legacy-ui:1000",
				apiIndex: 7,
				messageTs: 1_000,
				inputTokens: 1_200,
				outputTokens: 200,
				cacheWriteTokens: 100,
				cacheReadTokens: 300,
				cacheUsageReported: true,
				totalCost: 0.12,
				currency: "USD",
			}),
		])
		expect(result.aggregates).toEqual([])
		expect(result.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/)
	})

	it("keeps ambiguous legacy zero cache unavailable and normalizes recovered inclusive prompt tokens", () => {
		const result = parseLegacyUsageMessages("task-a", [
			message(1_000, "api_req_started", {
				request: "(recovered from API history)",
				tokensIn: 1_600,
				tokensOut: 200,
				cacheWrites: 100,
				cacheReads: 300,
			}),
			message(2_000, "api_req_started", { tokensIn: 100, tokensOut: 20, cacheWrites: 0, cacheReads: 0 }),
		])

		expect(result.rounds[0]).toMatchObject({ inputTokens: 1_200, cacheUsageReported: true })
		expect(result.rounds[1]).toMatchObject({ inputTokens: 100, cacheUsageReported: false })
	})

	it("separates aggregate-only usage and skips cancelled or malformed requests", () => {
		const result = parseLegacyUsageMessages("task-a", [
			message(1_000, "api_req_started", { tokensIn: 100, tokensOut: 20, cancelReason: "user_cancelled" }),
			{ ts: 2_000, type: "say", say: "api_req_started", text: "{" },
			message(3_000, "deleted_api_reqs", { tokensIn: 50, tokensOut: 5, cost: 0.01 }),
			message(4_000, "subagent_usage", { tokensIn: 70, tokensOut: 7, cacheReads: 30, cacheWrites: 0, cost: 0.02 }),
		])

		expect(result.rounds).toEqual([])
		expect(result.aggregates).toEqual([
			expect.objectContaining({ aggregateKind: "deleted_api_reqs", inputTokens: 50, outputTokens: 5 }),
			expect.objectContaining({ aggregateKind: "subagent_usage", inputTokens: 70, cacheReadTokens: 30 }),
		])
		expect(result.degraded).toBe(true)
	})
})

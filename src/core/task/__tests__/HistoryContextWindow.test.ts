import type { ContextWindowIndicatorSnapshot } from "@shared/context-window-indicator"
import { describe, expect, it } from "vitest"
import { readHistoryContextWindowIndicator } from "../HistoryContextWindow"

function snapshot(overrides: Partial<ContextWindowIndicatorSnapshot> = {}): ContextWindowIndicatorSnapshot {
	return {
		taskId: "task-1",
		revision: 12,
		epoch: 4,
		phase: "stable",
		durableContextTokens: 30_000,
		pendingSendTokens: 0,
		receivingTokens: 0,
		stagedTokens: 1_000,
		environmentTokens: 800,
		contextWindow: 200_000,
		profileId: "profile-1",
		profileName: "Profile",
		mode: "act",
		updatedAt: 1_700_000_000_000,
		lineage: { kind: "baseline" },
		...overrides,
	}
}

describe("readHistoryContextWindowIndicator", () => {
	it("keeps a stopped figure as the baseline a reopened task draws", () => {
		expect(readHistoryContextWindowIndicator(snapshot(), "task-1")).toEqual(snapshot())
	})

	it("drops the in-flight segments of a request the task closed during", () => {
		const restored = readHistoryContextWindowIndicator(
			snapshot({
				phase: "receiving",
				pendingSendTokens: 2_000,
				receivingTokens: 500,
				lineage: { kind: "ordinary", requestId: "turn-3", requestSequence: 3, attemptId: "turn-3" },
			}),
			"task-1",
		)

		expect(restored).toMatchObject({
			phase: "stable",
			pendingSendTokens: 0,
			receivingTokens: 0,
			durableContextTokens: 30_000,
			stagedTokens: 1_000,
			environmentTokens: 800,
			lineage: { kind: "baseline" },
		})
	})

	it.each([
		["another task's figure", snapshot({ taskId: "task-2" })],
		["a figure without a window", snapshot({ contextWindow: 0 })],
		["an unknown phase", { ...snapshot(), phase: "streaming" }],
		["an unknown mode", { ...snapshot(), mode: "debug" }],
		["a negative token count", snapshot({ durableContextTokens: -1 })],
		["a fractional token count", snapshot({ environmentTokens: 1.5 })],
		["something that is not a figure", "stable"],
		["nothing", undefined],
	])("rejects %s", (_name, input) => {
		expect(readHistoryContextWindowIndicator(input, "task-1")).toBeUndefined()
	})
})

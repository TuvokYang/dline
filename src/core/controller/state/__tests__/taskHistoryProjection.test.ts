import { describe, expect, it } from "vitest"
import { type HistoryItem, MAX_HISTORY_TASK_TEXT_LENGTH } from "@/shared/HistoryItem"
import { projectTaskHistory } from "../taskHistoryProjection"

function item(overrides: Partial<HistoryItem> = {}): HistoryItem {
	return {
		id: "task-1",
		ts: 1_700_000_000_000,
		task: "short task",
		tokensIn: 1,
		tokensOut: 2,
		totalCost: 0,
		...overrides,
	}
}

describe("projectTaskHistory", () => {
	it("returns an empty projection for missing history", () => {
		expect(projectTaskHistory(undefined)).toEqual({ items: [], truncatedCount: 0 })
		expect(projectTaskHistory([])).toEqual({ items: [], truncatedCount: 0 })
	})

	it("leaves entries within the limit untouched", () => {
		const entry = item({ task: "a".repeat(MAX_HISTORY_TASK_TEXT_LENGTH) })
		const { items, truncatedCount } = projectTaskHistory([entry])

		expect(truncatedCount).toBe(0)
		// Same reference: an unchanged entry must not be needlessly copied.
		expect(items[0]).toBe(entry)
	})

	it("shortens oversized task text to the limit", () => {
		const { items, truncatedCount } = projectTaskHistory([item({ task: "b".repeat(50_000) })])

		expect(truncatedCount).toBe(1)
		expect(items[0].task).toHaveLength(MAX_HISTORY_TASK_TEXT_LENGTH)
		expect(items[0].task).toBe("b".repeat(MAX_HISTORY_TASK_TEXT_LENGTH))
	})

	it("does not mutate the stored history entry", () => {
		// The input comes from the shared global state cache; shortening it in
		// place would destroy the stored text for every later reader.
		const original = item({ task: "c".repeat(50_000) })
		projectTaskHistory([original])

		expect(original.task).toHaveLength(50_000)
	})

	it("preserves every other field of a truncated entry", () => {
		const original = item({ id: "task-9", ts: 42, task: "d".repeat(50_000), isFavorited: true, totalCost: 1.5 })
		const [projected] = projectTaskHistory([original]).items

		expect(projected).toMatchObject({ id: "task-9", ts: 42, isFavorited: true, totalCost: 1.5 })
	})

	it("counts only the entries it actually shortened", () => {
		const { items, truncatedCount } = projectTaskHistory([
			item({ id: "a", task: "small" }),
			item({ id: "b", task: "e".repeat(50_000) }),
			item({ id: "c", task: "f".repeat(50_000) }),
		])

		expect(truncatedCount).toBe(2)
		expect(items).toHaveLength(3)
		expect(items[0].task).toBe("small")
	})

	it("keeps a non-string task value rather than throwing", () => {
		// Persisted history predates current typing; a malformed entry must not
		// break the state push for every other entry.
		const malformed = { ...item(), task: undefined as unknown as string }
		const { items, truncatedCount } = projectTaskHistory([malformed])

		expect(truncatedCount).toBe(0)
		expect(items[0]).toBe(malformed)
	})

	it("leaves the saved context-window figure out of the pushed list without touching the stored entry", () => {
		const contextWindowIndicator = {
			taskId: "task-1",
			revision: 3,
			epoch: 1,
			phase: "stable",
			durableContextTokens: 10,
			pendingSendTokens: 0,
			receivingTokens: 0,
			environmentTokens: 5,
			contextWindow: 100,
			mode: "act",
			updatedAt: 1,
			lineage: { kind: "baseline" },
		} as const
		const stored = item({ isFavorited: true, contextWindowIndicator })
		const [listed] = projectTaskHistory([stored]).items

		expect(listed).not.toHaveProperty("contextWindowIndicator")
		expect(listed).toMatchObject({ id: "task-1", task: "short task", isFavorited: true })
		expect(stored.contextWindowIndicator).toBe(contextWindowIndicator)
	})

	it("bounds a legacy history persisted before the write-time summary", () => {
		const history = Array.from({ length: 100 }, (_, index) => item({ id: `task-${index}`, task: "g".repeat(128 * 1024) }))
		const projectedBytes = Buffer.byteLength(JSON.stringify(projectTaskHistory(history).items), "utf8")

		expect(projectedBytes).toBeLessThan(1_000_000)
	})
})

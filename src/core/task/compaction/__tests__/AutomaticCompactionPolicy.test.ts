import { describe, expect, it } from "vitest"
import { createInitialTaskState, type TaskState } from "../../kernel"
import { shouldCompactAutomatically } from "../AutomaticCompactionPolicy"

const TRIGGER = 100_000

function running(overrides: Partial<TaskState> = {}): TaskState {
	return { ...createInitialTaskState("task-1"), flow: { phase: "running" }, ...overrides }
}

describe("automatic compaction policy", () => {
	it("compacts once a settled request reached the trigger", () => {
		expect(shouldCompactAutomatically(running(), { contextTokens: TRIGGER, compactTriggerTokens: TRIGGER })).toBe(true)
	})

	it("leaves a conversation that still fits alone", () => {
		// The shared projected-usage rule keeps the 2K estimation tolerance below the trigger.
		expect(shouldCompactAutomatically(running(), { contextTokens: TRIGGER - 2_001, compactTriggerTokens: TRIGGER })).toBe(
			false,
		)
	})

	it("compacts once projected usage reaches the trigger within the estimation tolerance", () => {
		expect(shouldCompactAutomatically(running(), { contextTokens: TRIGGER - 2_000, compactTriggerTokens: TRIGGER })).toBe(
			true,
		)
	})

	it("does not start a second run while one already owns the next summary", () => {
		const scheduled = running({
			flow: {
				phase: "running",
				compaction: { compactionId: "compaction:1", attempt: "compaction:1:1", contextRef: "ctx", status: "running" },
			},
		})
		expect(shouldCompactAutomatically(scheduled, { contextTokens: TRIGGER, compactTriggerTokens: TRIGGER })).toBe(false)
	})

	it("does not compact a task that has no next request to protect", () => {
		for (const phase of ["paused", "terminated", "completed", "error"] as const) {
			const stopped = running({ flow: { phase } })
			expect(shouldCompactAutomatically(stopped, { contextTokens: TRIGGER, compactTriggerTokens: TRIGGER })).toBe(false)
		}
	})

	it("ignores an unresolved trigger rather than compacting on every request", () => {
		expect(shouldCompactAutomatically(running(), { contextTokens: TRIGGER, compactTriggerTokens: 0 })).toBe(false)
	})
})

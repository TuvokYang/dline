/**
 * Tests for skip-order detection: warning → reject progression.
 *
 * Exercises updateFCListFromToolResponse() indirectly through FocusChainManager
 * to verify the full skip-order state machine across multiple calls.
 */

import { FocusChainSettings } from "@shared/FocusChainSettings"
import { describe, expect, it, vi } from "vitest"
import { TaskState } from "../../TaskState"
import { type FocusChainDependencies, FocusChainManager } from "../index"
import { FocusChainPrompts } from "../prompts"

/** Build a simple task_progress report string as AI would send. */
function report(items: { done: boolean; text: string }[]): string {
	return items.map((i) => (i.done ? `- [x] ${i.text}` : `- [ ] ${i.text}`)).join("\n")
}

/** Build a checklist with optional sections. */
function checklist(items: Array<{ text: string }>, sections?: string[]): string {
	let result = "# Test Plan\n"
	if (sections) {
		for (const s of sections) result += `## ${s}\n`
	}
	for (const item of items) {
		result += `- [ ] ${item.text}\n`
	}
	return result.trimEnd()
}

/** Create a fresh mock say function that records calls. */
function mockSay() {
	const calls: Array<{ type: string; text?: string }> = []
	const fn: FocusChainDependencies["say"] = vi.fn((type, text) => {
		calls.push({ type, text })
		return Promise.resolve(1)
	})
	return { fn, calls }
}

/** Create FocusChainManager with mocked dependencies. */
function createManager(taskState: TaskState, sayFn: FocusChainDependencies["say"]) {
	const deps = {
		taskId: "test-task-id",
		taskState,
		getMode: () => "act" as const,
		stateManager: {
			getGlobalSettingsKey: vi.fn((key: string) => {
				if (key === "mode") return "act"
				if (key === "maxConsecutiveMistakes") return 3
				return undefined
			}),
			getGlobalStateKey: vi.fn(),
			setGlobalState: vi.fn(),
		} as any,
		postStateToWebview: vi.fn(() => Promise.resolve()),
		say: sayFn,
		focusChainSettings: { enabled: true, remindClineInterval: 6 } as FocusChainSettings,
	}
	return new FocusChainManager(deps)
}

describe("skip-order detection via updateFCListFromToolResponse", () => {
	it("first skip-order violation: accepts with warning, preserves rejection for next prompt", async () => {
		const ts = new TaskState()
		// Set up initial checklist with 3 unchecked items
		ts.currentFocusChainChecklist = checklist([{ text: "Task A" }, { text: "Task B" }, { text: "Task C" }])
		const { fn: say, calls } = mockSay()
		const mgr = createManager(ts, say)

		// AI reports A done + C done (skipped B) + C as in-progress
		await mgr.updateFCListFromToolResponse(
			report([
				{ done: true, text: "Task A" },
				{ done: true, text: "Task C" },
				{ done: false, text: "Task B" },
			]),
		)

		// First offense: warning, accepted
		expect(ts.hasWarnedSkipOrder).toBe(true)
		expect(ts.focusChainRejectionMessage).toBe(FocusChainPrompts.skipOrderWarning)
		expect(ts.consecutiveMistakeCount).toBe(0) // reset on success despite warning
		// Checklist was updated (both A and C marked [x])
		expect(ts.currentFocusChainChecklist).toContain("- [x] Task A")
		expect(ts.currentFocusChainChecklist).toContain("- [x] Task C")
		// Warning was sent to webview
		expect(calls.some((c) => c.type === "error")).toBe(true)

		// generateFocusChainInstructions should return the warning and clear it
		const instructions = mgr.generateFocusChainInstructions()
		expect(instructions).toContain(FocusChainPrompts.skipOrderWarning)
		expect(ts.focusChainRejectionMessage).toBeNull() // cleared after read

		// Second call: no pending rejection
		const instructions2 = mgr.generateFocusChainInstructions()
		expect(instructions2).not.toContain(FocusChainPrompts.skipOrderWarning)
	})

	it("second skip-order violation: rejects update", async () => {
		const ts = new TaskState()
		ts.currentFocusChainChecklist = checklist([{ text: "Task A" }, { text: "Task B" }, { text: "Task C" }])
		ts.hasWarnedSkipOrder = true // simulate first offense already happened
		const { fn: say, calls } = mockSay()
		const mgr = createManager(ts, say)

		const previousChecklist = ts.currentFocusChainChecklist
		// AI tries to skip B again
		await mgr.updateFCListFromToolResponse(
			report([
				{ done: true, text: "Task A" },
				{ done: true, text: "Task C" },
			]),
		)

		// Second offense: rejected with a message other than the first-offense warning
		const rejection = ts.focusChainRejectionMessage
		expect(rejection).not.toBeNull()
		expect(rejection).not.toBe(FocusChainPrompts.skipOrderWarning)
		expect(ts.consecutiveMistakeCount).toBe(1)
		// Checklist was NOT changed (rejected)
		expect(ts.currentFocusChainChecklist).toBe(previousChecklist)
		expect(calls.some((c) => c.type === "error")).toBe(true)

		// Rejection message is preserved (not cleared by persistAndNotify — was rejected before persist)
		const instructions = mgr.generateFocusChainInstructions()
		expect(instructions).toContain(rejection as string)
	})

	it("does not commit a replacement current item when a skip-order update is rejected", async () => {
		const ts = new TaskState()
		ts.currentFocusChainChecklist = checklist([{ text: "Task A" }, { text: "Task B" }, { text: "Task C" }])
		ts.currentInProgressItemIndex = 0
		ts.hasWarnedSkipOrder = true
		const { fn: say } = mockSay()
		const mgr = createManager(ts, say)

		const previousChecklist = ts.currentFocusChainChecklist
		await mgr.updateFCListFromToolResponse(
			report([
				{ done: true, text: "Task A" },
				{ done: true, text: "Task C" },
				{ done: false, text: "Task B" },
			]),
		)

		expect(ts.focusChainRejectionMessage).not.toBeNull()
		expect(ts.currentFocusChainChecklist).toBe(previousChecklist)
		expect(ts.currentInProgressItemIndex).toBe(0)
	})

	it("cross-section skip-order: global counter applies", async () => {
		const ts = new TaskState()
		ts.currentFocusChainChecklist = checklist(
			[{ text: "S1-Task A" }, { text: "S1-Task B" }, { text: "S2-Task C" }],
			["Section 1", "Section 2"],
		)
		const { fn: say } = mockSay()
		const mgr = createManager(ts, say)

		// First skip: S1-Task A done + S2-Task C done (skipped S1-Task B)
		// — cross-section skip, but global counter applies
		await mgr.updateFCListFromToolResponse(
			report([
				{ done: true, text: "S1-Task A" },
				{ done: true, text: "S2-Task C" },
			]),
		)

		// First offense = warning
		expect(ts.hasWarnedSkipOrder).toBe(true)
		expect(ts.focusChainRejectionMessage).toBe(FocusChainPrompts.skipOrderWarning)
		expect(ts.currentFocusChainChecklist).toContain("- [x] S1-Task A")
		expect(ts.currentFocusChainChecklist).toContain("- [x] S2-Task C")
	})

	it("third skip-order violation: rejected with consecutiveMistakeCount accumulated", async () => {
		const ts = new TaskState()
		ts.currentFocusChainChecklist = checklist([{ text: "Task 1" }, { text: "Task 2" }, { text: "Task 3" }])
		ts.hasWarnedSkipOrder = true // first warning already happened
		// Simulate one previous rejection
		ts.consecutiveMistakeCount = 1
		const { fn: say } = mockSay()
		const mgr = createManager(ts, say)

		const previousChecklist = ts.currentFocusChainChecklist
		// Third offense: blocked again
		await mgr.updateFCListFromToolResponse(
			report([
				{ done: true, text: "Task 1" },
				{ done: true, text: "Task 3" },
			]),
		)

		expect(ts.focusChainRejectionMessage).not.toBeNull()
		expect(ts.consecutiveMistakeCount).toBe(2)
		expect(ts.currentFocusChainChecklist).toBe(previousChecklist)
	})

	it("warning rejection is injected into AI prompt via generateFocusChainInstructions", async () => {
		const ts = new TaskState()
		ts.currentFocusChainChecklist = checklist([{ text: "Task X" }, { text: "Task Y" }, { text: "Task Z" }])
		const { fn: say } = mockSay()
		const mgr = createManager(ts, say)

		// First skip: X done + Z done (skipped Y) → warning, goes through persistAndNotify
		await mgr.updateFCListFromToolResponse(
			report([
				{ done: true, text: "Task X" },
				{ done: true, text: "Task Z" },
				{ done: false, text: "Task Y" },
			]),
		)

		// Warning should be available for next API request
		expect(ts.focusChainRejectionMessage).toBe(FocusChainPrompts.skipOrderWarning)
		// shouldIncludeFocusChainInstructions must return true
		expect(mgr.shouldIncludeFocusChainInstructions()).toBe(true)
		// generateFocusChainInstructions must return the warning
		const injected = mgr.generateFocusChainInstructions()
		expect(injected).toContain(FocusChainPrompts.skipOrderWarning)
		// After read, cleared
		expect(ts.focusChainRejectionMessage).toBeNull()
	})

	it("clears the current item when that item is completed without a replacement", async () => {
		const ts = new TaskState()
		ts.currentFocusChainChecklist = checklist([{ text: "Task A" }, { text: "Task B" }])
		ts.currentInProgressItemIndex = 0
		const { fn: say } = mockSay()
		const mgr = createManager(ts, say)

		await mgr.updateFCListFromToolResponse(report([{ done: true, text: "Task A" }]))

		expect(ts.currentFocusChainChecklist).toContain("- [x] Task A")
		expect(ts.currentInProgressItemIndex).toBeNull()
	})

	it("switches current work when a completed update includes a new unchecked item", async () => {
		const ts = new TaskState()
		ts.currentFocusChainChecklist = checklist([{ text: "Task A" }, { text: "Task B" }, { text: "Task C" }])
		ts.currentInProgressItemIndex = 0
		const { fn: say } = mockSay()
		const mgr = createManager(ts, say)

		await mgr.updateFCListFromToolResponse(
			report([
				{ done: true, text: "Task A" },
				{ done: false, text: "Task B" },
				{ done: false, text: "Task C" },
			]),
		)

		expect(ts.currentInProgressItemIndex).toBe(1)
	})

	it("backfill of historically skipped item is accepted after first-skip warning", async () => {
		// Scenario: AI skipped B by completing A+D, got a warning.
		// Now AI tries to backfill B — the list is already A[x] B[ ] C[ ] D[x] E[ ].
		// The historical D[x] should NOT cause skipDetected because D was already [x] before.
		const ts = new TaskState()
		ts.currentFocusChainChecklist = checklist([
			{ text: "Task A" },
			{ text: "Task B" },
			{ text: "Task C" },
			{ text: "Task D" },
			{ text: "Task E" },
		])
		const { fn: say, calls } = mockSay()
		const mgr = createManager(ts, say)

		// Step 1: AI skips B+C, completes A+D → first skip warning
		await mgr.updateFCListFromToolResponse(
			report([
				{ done: true, text: "Task A" },
				{ done: true, text: "Task D" },
				{ done: false, text: "Task B" },
			]),
		)

		// First skip should be accepted with warning
		expect(ts.hasWarnedSkipOrder).toBe(true)
		expect(ts.currentFocusChainChecklist).toContain("- [x] Task A")
		expect(ts.currentFocusChainChecklist).toContain("- [x] Task D")
		expect(ts.currentFocusChainChecklist).toContain("- [ ] Task B")

		// Clear the rejection message to simulate next API cycle
		ts.focusChainRejectionMessage = null

		// Step 2: AI backfills Task B (the historically skipped item)
		// The checklist is: [x]A, [ ]B, [ ]C, [x]D, [ ]E
		// D is a pre-existing [x] — it should NOT trigger skipDetected for newly-completed B
		await mgr.updateFCListFromToolResponse(report([{ done: true, text: "Task B" }]))

		// Should be accepted — no rejection
		expect(ts.focusChainRejectionMessage).toBeNull()
		expect(ts.consecutiveMistakeCount).toBe(0)
		expect(ts.currentFocusChainChecklist).toContain("- [x] Task B")
		// hasWarnedSkipOrder stays true (already warned from first skip)
		expect(ts.hasWarnedSkipOrder).toBe(true)
	})

	it("backfill of historically skipped items does NOT reset skip warning for new skips", async () => {
		// After backfilling B (accepted), if AI tries to skip again (mark E while C is still [ ]),
		// it should still be rejected because hasWarnedSkipOrder is true.
		const ts = new TaskState()
		ts.currentFocusChainChecklist = checklist([
			{ text: "Task A" },
			{ text: "Task B" },
			{ text: "Task C" },
			{ text: "Task D" },
			{ text: "Task E" },
		])
		const { fn: say } = mockSay()
		const mgr = createManager(ts, say)

		// Step 1: First skip — A+D done, B skipped
		await mgr.updateFCListFromToolResponse(
			report([
				{ done: true, text: "Task A" },
				{ done: true, text: "Task D" },
				{ done: false, text: "Task B" },
			]),
		)
		ts.focusChainRejectionMessage = null

		// Step 2: Backfill B — accepted
		await mgr.updateFCListFromToolResponse(report([{ done: true, text: "Task B" }]))
		expect(ts.focusChainRejectionMessage).toBeNull()

		ts.focusChainRejectionMessage = null

		// Step 3: AI tries to skip C by completing E (newly completed E skips C)
		// Checklist is now: [x]A, [x]B, [ ]C, [x]D, [ ]E
		// hasWarnedSkipOrder is still true from step 1
		await mgr.updateFCListFromToolResponse(report([{ done: true, text: "Task E" }]))

		// Second skip SHOULD be rejected because hasWarnedSkipOrder is true
		// and E is a NEWLY completed item that skips C
		// skipOrderRejected renders the remaining unchecked items as examples.
		expect(ts.focusChainRejectionMessage).not.toBe(FocusChainPrompts.skipOrderWarning)
		expect(ts.focusChainRejectionMessage).toContain("Task C")
		expect(ts.consecutiveMistakeCount).toBeGreaterThanOrEqual(1)
		expect(ts.currentFocusChainChecklist).not.toContain("- [x] Task E")
	})
})

import { describe, expect, it } from "vitest"
import { createInitialTaskState, hydrate, type TaskEvent, type TaskState, type TransitionResult, transition } from ".."

function accepted(result: TransitionResult): Extract<TransitionResult, { kind: "accepted" }> {
	if (result.kind !== "accepted") throw new Error(`${result.reason}: ${result.diagnostic.message}`)
	return result
}

function apply(state: TaskState, ...events: readonly TaskEvent[]): TaskState {
	return events.reduce((current, event) => accepted(transition(current, event)).state, state)
}

const COMPACTION_ID = "compaction:1"

/** A running task whose manual compaction is waiting on the user's review. */
function reviewingCompaction(): TaskState {
	const running: TaskState = { ...createInitialTaskState("task-1"), flow: { phase: "running" } }
	return apply(
		running,
		{
			type: "compaction.requested",
			generation: 0,
			compactionId: COMPACTION_ID,
			attempt: `${COMPACTION_ID}:1`,
			contextRef: "ctx",
		},
		{ type: "compaction.started", generation: 0, compactionId: COMPACTION_ID, attempt: `${COMPACTION_ID}:1` },
		{
			type: "dialog.requested",
			generation: 0,
			interactionId: `${COMPACTION_ID}:1:review:0`,
			turnId: COMPACTION_ID,
			kind: "condense",
			presentationRef: "presentation",
			actionRules: [{ actionId: "confirm_utility", payloadPolicy: "none" }],
		},
	)
}

function cancel(state: TaskState): TaskState {
	let next = accepted(transition(state, { type: "user.cancel", generation: state.generation, haltId: "halt-1" })).state
	if (next.halt.status !== "stopping") throw new Error("expected stopping")
	for (const participantId of [...next.halt.pending]) {
		next = apply(next, { type: "halt.halted", generation: next.generation, haltId: "halt-1", participantId })
	}
	return next
}

describe("compaction abandoned by a halt", () => {
	it("expires the run so a later compaction is not refused as a duplicate", () => {
		const halted = cancel(reviewingCompaction())

		expect(halted.flow.phase).toBe("paused")
		expect(halted.flow.compaction).toMatchObject({ status: "expired", message: "compaction_cancelled" })
		const again = transition(halted, {
			type: "compaction.requested",
			generation: halted.generation,
			compactionId: "compaction:2",
			attempt: "compaction:2:1",
			contextRef: "ctx-2",
		})
		expect(again.kind).toBe("accepted")
	})

	it("withdraws the review that run opened, leaving room for the recovery offer", () => {
		const halted = cancel(reviewingCompaction())

		expect(halted.dialog.primary).toBeUndefined()
	})

	it("keeps a dialog that belongs to anything other than the abandoned run", () => {
		const running: TaskState = { ...createInitialTaskState("task-1"), flow: { phase: "running" } }
		const asking = apply(running, {
			type: "dialog.requested",
			generation: 0,
			interactionId: "question-1",
			turnId: "turn-1",
			kind: "followup",
			presentationRef: "presentation",
			actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
		})

		const halted = cancel(asking)

		expect(halted.dialog.primary?.interactionId).toBe("question-1")
	})
})

describe("compaction abandoned by a restart", () => {
	it("restores an interrupted task with the recovery offer instead of an orphaned review", () => {
		const result = hydrate({
			taskId: "task-1",
			snapshot: reviewingCompaction(),
			journalTail: { seq: 0 },
			openReason: "crash_recovery",
		})

		expect(result.kind).toBe("ready")
		if (result.kind !== "ready") return
		expect(result.state.dialog.primary).toMatchObject({ kind: "resume", status: "planned" })
		expect(result.state.flow.compaction).toBeUndefined()
	})

	it("expires a run recorded in a flow that survives restoration", () => {
		const errored: TaskState = {
			...reviewingCompaction(),
			flow: { ...reviewingCompaction().flow, phase: "error", error: "provider failed" },
		}

		const result = hydrate({ taskId: "task-1", snapshot: errored, journalTail: { seq: 0 }, openReason: "resume" })

		expect(result.kind).toBe("ready")
		if (result.kind !== "ready") return
		expect(result.state.flow.compaction).toMatchObject({ status: "expired", message: "compaction_interrupted" })
		expect(result.state.dialog.primary?.kind).toBe("error_retry")
	})
})

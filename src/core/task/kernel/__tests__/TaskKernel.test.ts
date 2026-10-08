import { describe, expect, it } from "vitest"
import { createInitialTaskState, hydrate, type TaskEvent, type TaskState, type TransitionResult, transition } from ".."

function accepted(result: TransitionResult): Extract<TransitionResult, { kind: "accepted" }> {
	expect(result.kind).toBe("accepted")
	return result as Extract<TransitionResult, { kind: "accepted" }>
}

function replay(initial: TaskState, events: readonly TaskEvent[], reducer = transition): TaskState {
	return events.reduce((state, event) => {
		const result = reducer(state, event)
		return result.kind === "accepted" ? result.state : state
	}, initial)
}

describe("task kernel", () => {
	it("rejects a stale generation without changing state or emitting commands", () => {
		const state = createInitialTaskState("task-1")
		const result = transition(state, { type: "user.submit", generation: 1, entryId: "entry-1", payloadRef: "payload-1" })
		expect(result).toMatchObject({ kind: "rejected", reason: "generation_mismatch", state })
		expect(result.state).toBe(state)
	})

	it("rejects stale attempts and duplicates without advancing revision", () => {
		const ready: TaskState = {
			...createInitialTaskState("task-1"),
			flow: { phase: "running" },
			turn: {
				turnId: "turn-1",
				mode: "serial",
				blocks: [
					{
						blockId: "block-1",
						index: 0,
						phase: "ready",
						attempt: "attempt-1",
						invocationRef: "invocation:block-1",
						lanes: [],
						turnEnding: false,
					},
				],
				manualApprovalBlockIds: [],
				automaticApprovalBlockIds: ["block-1"],
				executingBlockIds: [],
			},
		}
		const stale = transition(ready, {
			type: "tool.started",
			generation: 0,
			attempt: "attempt-old",
			turnId: "turn-1",
			blockId: "block-1",
		})
		expect(stale).toMatchObject({ kind: "rejected", reason: "stale_attempt", state: ready })
		expect(stale.state).toBe(ready)

		const acceptedInput = accepted(
			transition(createInitialTaskState("task-1"), {
				type: "user.submit",
				generation: 0,
				entryId: "entry-1",
				payloadRef: "payload-1",
			}),
		).state
		const duplicate = transition(acceptedInput, {
			type: "user.submit",
			generation: 0,
			entryId: "entry-1",
			payloadRef: "payload-1",
		})
		expect(duplicate).toMatchObject({ kind: "rejected", reason: "duplicate", state: acceptedInput })
		expect(duplicate.state).toBe(acceptedInput)
	})

	it("accepts input and emits one deterministic compose command", () => {
		const state = createInitialTaskState("task-1")
		const result = accepted(
			transition(state, { type: "user.submit", generation: 0, entryId: "entry-1", payloadRef: "payload-1" }),
		)
		expect(result.state.revision).toBe(1)
		expect(result.state.intake.queued).toEqual([
			{
				entryId: "entry-1",
				payloadRef: "payload-1",
				source: "user",
				mode: "queued",
				sequence: 1,
				state: "reserved",
			},
		])
		expect(result.commands).toEqual([
			{
				commandId: "task-1:1:0",
				originRevision: 1,
				generation: 0,
				type: "compose.round",
				turnId: "turn:task-1:1:0",
				admittedEntryIds: ["entry-1"],
			},
		])
	})

	it("reveals a dialog only after the prepared event is committed", () => {
		const state: TaskState = {
			...createInitialTaskState("task-1"),
			dialog: {
				primary: {
					interactionId: "i-1",
					turnId: "turn-1",
					kind: "question",
					status: "planned",
					createdRevision: 0,
					presentationRef: "question:1",
					actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
					prepare: { commandId: "prepare-1", originRevision: 0, status: "running" },
				},
				approvalsByBlock: {},
			},
		}
		const result = accepted(
			transition(state, {
				type: "dialog.prepared",
				generation: 0,
				commandId: "prepare-1",
				originRevision: 0,
				interactionId: "i-1",
				journalRef: "journal:1",
				receiverGeneration: 3,
			}),
		)
		expect(result.state.dialog.primary).toMatchObject({ status: "prepared", journalRef: "journal:1", receiverGeneration: 3 })
		expect(result.commands[0]).toMatchObject({ type: "dialog.reveal", interactionId: "i-1", journalRef: "journal:1" })
	})

	it("keeps a timed-out halt participant pending and visible until it really stops", () => {
		let state = accepted(
			transition(createInitialTaskState("task-1"), { type: "user.cancel", generation: 0, haltId: "halt-1" }),
		).state
		state = accepted(
			transition(state, {
				type: "lifecycle.halt_timeout",
				generation: state.generation,
				haltId: "halt-1",
				participantId: "provider",
			}),
		).state

		expect(state.halt).toMatchObject({ status: "stopping", timedOut: ["provider"] })
		if (state.halt.status !== "stopping") throw new Error("expected stopping")
		expect(state.halt.pending).toContain("provider")
		expect(state.flow.phase).not.toBe("paused")

		for (const participantId of [...state.halt.pending]) {
			state = accepted(
				transition(state, { type: "halt.halted", generation: state.generation, haltId: "halt-1", participantId }),
			).state
		}
		expect(state.flow.phase).toBe("paused")
		expect(state.halt.status).toBe("idle")
	})

	it("escalates an active cancel to a durable forced-closed termination verdict", () => {
		let state = accepted(
			transition(createInitialTaskState("task-1"), { type: "user.cancel", generation: 0, haltId: "halt-1" }),
		).state
		state = accepted(
			transition(state, {
				type: "lifecycle.halt_timeout",
				generation: state.generation,
				haltId: "halt-1",
				participantId: "provider",
			}),
		).state
		const pending = state.halt.status === "stopping" ? state.halt.pending : []

		const terminated = accepted(transition(state, { type: "user.terminate", generation: state.generation, haltId: "halt-1" }))

		expect(terminated.commands).toEqual([])
		expect(terminated.state).toMatchObject({
			generation: 2,
			flow: { phase: "terminated", forcedClosedParticipants: pending },
			halt: { status: "idle", generation: 2 },
		})
	})

	it("waits for all halt participants before reaching the terminal target", () => {
		let state = accepted(
			transition(createInitialTaskState("task-1"), { type: "user.cancel", generation: 0, haltId: "halt-1" }),
		).state
		expect(state.halt.status).toBe("stopping")
		if (state.halt.status !== "stopping") throw new Error("expected stopping")
		for (const participantId of [...state.halt.pending]) {
			state = accepted(
				transition(state, { type: "halt.halted", generation: state.generation, haltId: "halt-1", participantId }),
			).state
		}
		expect(state.flow.phase).toBe("paused")
		expect(state.halt.status).toBe("idle")
		const restored = hydrate({
			taskId: "task-1",
			snapshot: state,
			journalTail: { seq: 0 },
			openReason: "crash_recovery",
		})
		expect(restored.kind).toBe("ready")
	})

	it("discards a snapshot that belongs to another task and rebuilds this one", () => {
		const snapshot = createInitialTaskState("task-other")
		const result = hydrate({ taskId: "task-1", snapshot, journalTail: { seq: 0 }, openReason: "resume" })
		expect(result).toMatchObject({ kind: "ready", form: "interrupted", rebuilt: true, state: { taskId: "task-1" } })
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("task_identity_mismatch")
	})

	it("hydrates conservatively and re-emits only prepared dialog reveals", () => {
		const snapshot: TaskState = {
			...createInitialTaskState("task-1"),
			revision: 8,
			turn: {
				turnId: "turn-1",
				mode: "parallel",
				blocks: [
					{
						blockId: "block-1",
						index: 0,
						phase: "executing",
						attempt: "attempt-1",
						invocationRef: "invocation:block-1",
						lanes: [],
						turnEnding: false,
					},
				],
				manualApprovalBlockIds: [],
				automaticApprovalBlockIds: [],
				executingBlockIds: ["block-1"],
			},
			dialog: {
				primary: {
					interactionId: "i-1",
					turnId: "turn-1",
					kind: "question",
					status: "prepared",
					createdRevision: 7,
					presentationRef: "question:1",
					actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
					journalRef: "journal:1",
					receiverGeneration: 0,
				},
				approvalsByBlock: {},
			},
		}
		const result = hydrate({ taskId: "task-1", snapshot, journalTail: { seq: 12 }, openReason: "crash_recovery" })
		expect(result.kind).toBe("ready")
		if (result.kind !== "ready") return
		expect(result.form).toBe("interrupted")
		expect(result.state.turn.executingBlockIds).toEqual([])
		expect(result.state.turn.blocks[0].phase).toBe("cancelled")
		expect(result.initialCommands).toHaveLength(1)
		expect(result.initialCommands[0]).toMatchObject({ type: "dialog.reveal", interactionId: "i-1" })
	})

	it("has a replay oracle that fails under an intentionally mutated transition", () => {
		const events: TaskEvent[] = [
			{ type: "user.submit", generation: 0, entryId: "entry-1", payloadRef: "payload-1" },
			{ type: "background.ready", generation: 0, entryId: "bg-1", payloadRef: "payload-bg" },
		]
		const expected = replay(createInitialTaskState("task-1"), events)
		const mutated = replay(createInitialTaskState("task-1"), events, (state, event) =>
			event.type === "user.submit" ? { kind: "accepted", state, commands: [] } : transition(state, event),
		)
		expect(mutated).not.toEqual(expected)
	})
})

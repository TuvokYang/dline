import { describe, expect, it } from "vitest"
import { transition } from "../transition"
import type { ComposeRoundCommand, KernelBlock, ProviderStartCommand, TaskState, TransitionResult } from "../types"
import { createInitialTaskState } from "../types"

function accepted(result: TransitionResult): Extract<TransitionResult, { kind: "accepted" }> {
	expect(result.kind).toBe("accepted")
	if (result.kind !== "accepted") throw new Error(result.diagnostic.message)
	return result
}

function block(blockId: string, index: number, phase: KernelBlock["phase"]): KernelBlock {
	return { blockId, index, phase, attempt: `attempt-${blockId}`, lanes: [], turnEnding: false }
}

function running(): TaskState {
	return {
		...createInitialTaskState("task-1"),
		flow: { phase: "running" },
		turn: {
			turnId: "turn-1",
			mode: "serial",
			blocks: [],
			manualApprovalBlockIds: [],
			automaticApprovalBlockIds: [],
			executingBlockIds: [],
		},
	}
}

function activeCompose() {
	const requested = accepted(
		transition(running(), { type: "user.submit", generation: 0, entryId: "entry-1", payloadRef: "input:1" }),
	)
	const command = requested.commands.find((candidate): candidate is ComposeRoundCommand => candidate.type === "compose.round")
	if (!command) throw new Error("expected compose command")
	return { state: requested.state, command }
}

describe("task kernel executor flow", () => {
	it("closes compose.completed into one provider.start command", () => {
		const compose = activeCompose()
		const result = accepted(
			transition(compose.state, {
				type: "compose.completed",
				generation: 0,
				commandId: compose.command.commandId,
				originRevision: compose.command.originRevision,
				turnId: "turn-1",
				draftRef: "draft:1",
			}),
		)
		expect(result.commands).toEqual([
			expect.objectContaining({ type: "provider.start", draftRef: "draft:1", turnId: "turn-1" }),
		])
		expect(result.state.flow.compose?.status).toBe("completed")
		expect(result.state.flow.provider).toMatchObject({ status: "running", commandId: result.commands[0].commandId })
	})

	it("emits compose.round exactly when the final active tool block settles", () => {
		const state: TaskState = {
			...running(),
			turn: {
				turnId: "turn-1",
				mode: "serial",
				blocks: [block("b1", 0, "completed"), block("b2", 1, "executing")],
				manualApprovalBlockIds: [],
				automaticApprovalBlockIds: [],
				executingBlockIds: ["b2"],
			},
		}
		const result = accepted(
			transition(state, {
				type: "tool.completed",
				generation: 0,
				turnId: "turn-1",
				blockId: "b2",
				attempt: "attempt-b2",
			}),
		)
		expect(result.commands).toEqual([
			expect.objectContaining({ type: "compose.round", turnId: "turn-1", admittedEntryIds: [] }),
		])
	})

	it("turns compose failure into an error-recovery presentation command", () => {
		const compose = activeCompose()
		const result = accepted(
			transition(compose.state, {
				type: "compose.failed",
				generation: 0,
				commandId: compose.command.commandId,
				originRevision: compose.command.originRevision,
				turnId: "turn-1",
				message: "compose failed",
			}),
		)
		expect(result.state.flow).toMatchObject({ phase: "error", error: "compose failed" })
		expect(result.state.dialog.primary).toMatchObject({ kind: "error_retry", status: "planned" })
		expect(result.commands).toEqual([expect.objectContaining({ type: "dialog.prepare", kind: "error_retry" })])
	})

	it("rejects stale, duplicate, and post-halt compose/provider feedback", () => {
		const compose = activeCompose()
		const stale = transition(compose.state, {
			type: "compose.completed",
			generation: 0,
			commandId: "stale-command",
			originRevision: compose.command.originRevision,
			turnId: "turn-1",
			draftRef: "draft:stale",
		})
		expect(stale).toMatchObject({ kind: "rejected", reason: "identity_mismatch" })

		const composed = accepted(
			transition(compose.state, {
				type: "compose.completed",
				generation: 0,
				commandId: compose.command.commandId,
				originRevision: compose.command.originRevision,
				turnId: "turn-1",
				draftRef: "draft:1",
			}),
		)
		const provider = composed.commands.find(
			(candidate): candidate is ProviderStartCommand => candidate.type === "provider.start",
		)
		if (!provider) throw new Error("expected provider command")
		const ready = accepted(
			transition(composed.state, {
				type: "provider.turn_ready",
				generation: 0,
				commandId: provider.commandId,
				originRevision: provider.originRevision,
				turnId: "turn-1",
				finalPayloadRef: "answer:1",
			}),
		)
		const duplicate = transition(ready.state, {
			type: "provider.failed",
			generation: 0,
			commandId: provider.commandId,
			originRevision: provider.originRevision,
			turnId: "turn-1",
			message: "late failure",
		})
		expect(duplicate).toMatchObject({ kind: "rejected", reason: "duplicate" })

		const second = activeCompose()
		const stopping = accepted(transition(second.state, { type: "user.cancel", generation: 0, haltId: "halt-1" }))
		const late = transition(stopping.state, {
			type: "compose.completed",
			generation: 0,
			commandId: second.command.commandId,
			originRevision: second.command.originRevision,
			turnId: "turn-1",
			draftRef: "draft:late",
		})
		expect(late).toMatchObject({ kind: "rejected", reason: "generation_mismatch" })
	})

	it("tracks compaction retry attempts and rejects late feedback", () => {
		let state = accepted(
			transition(running(), {
				type: "compaction.requested",
				generation: 0,
				compactionId: "compact-1",
				attempt: "attempt-1",
				contextRef: "manual:ctx",
			}),
		).state
		expect(state.flow.compaction).toMatchObject({ status: "scheduled", attempt: "attempt-1" })
		state = accepted(
			transition(state, { type: "compaction.started", generation: 0, compactionId: "compact-1", attempt: "attempt-1" }),
		).state
		state = accepted(
			transition(state, {
				type: "compaction.failed",
				generation: 0,
				compactionId: "compact-1",
				attempt: "attempt-1",
				message: "retryable",
			}),
		).state
		const retry = accepted(
			transition(state, {
				type: "compaction.requested",
				generation: 0,
				compactionId: "compact-1",
				attempt: "attempt-2",
				contextRef: "manual:ctx",
			}),
		)
		expect(retry.commands).toEqual([expect.objectContaining({ type: "compaction.run", attempt: "attempt-2" })])
		state = accepted(
			transition(retry.state, {
				type: "compaction.started",
				generation: 0,
				compactionId: "compact-1",
				attempt: "attempt-2",
			}),
		).state
		const late = transition(state, {
			type: "compaction.completed",
			generation: 0,
			compactionId: "compact-1",
			attempt: "attempt-1",
			resultRef: "summary:late",
		})
		expect(late).toMatchObject({ kind: "rejected", reason: "stale_attempt" })
		expect(late.state).toBe(state)
	})

	it("accepts only causally owned lifecycle spawn feedback", () => {
		const requested = accepted(
			transition(running(), {
				type: "lifecycle.spawn_requested",
				generation: 0,
				spawnAttempt: "spawn-1",
				handoffRef: "handoff:1",
			}),
		)
		const command = requested.commands[0]
		if (command?.type !== "task.spawn") throw new Error("expected task.spawn")
		const spawned = accepted(
			transition(requested.state, {
				type: "lifecycle.spawned",
				generation: 0,
				commandId: command.commandId,
				originRevision: command.originRevision,
				spawnAttempt: command.spawnAttempt,
				childTaskId: "child-1",
			}),
		)
		expect(spawned.state.flow.spawn).toMatchObject({ status: "completed", childTaskId: "child-1" })

		const second = accepted(
			transition(spawned.state, {
				type: "lifecycle.spawn_requested",
				generation: 0,
				spawnAttempt: "spawn-2",
				handoffRef: "handoff:2",
			}),
		)
		const secondCommand = second.commands[0]
		if (secondCommand?.type !== "task.spawn") throw new Error("expected second task.spawn")
		const failed = accepted(
			transition(second.state, {
				type: "lifecycle.spawn_failed",
				generation: 0,
				commandId: secondCommand.commandId,
				originRevision: secondCommand.originRevision,
				spawnAttempt: secondCommand.spawnAttempt,
				message: "spawn failed",
			}),
		)
		expect(failed.state.flow).toMatchObject({ phase: "error", error: "spawn failed", spawn: { status: "failed" } })
	})
})

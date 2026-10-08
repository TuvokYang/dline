import { describe, expect, it } from "vitest"
import { toolTerminalManifestPayload } from "../machines/turn"
import { transition } from "../transition"
import type { ComposeRoundCommand, KernelBlock, ProviderStartCommand, TaskState, TransitionResult } from "../types"
import { createInitialTaskState } from "../types"

function accepted(result: TransitionResult): Extract<TransitionResult, { kind: "accepted" }> {
	expect(result.kind).toBe("accepted")
	if (result.kind !== "accepted") throw new Error(result.diagnostic.message)
	return result
}

function block(blockId: string, index: number, phase: KernelBlock["phase"]): KernelBlock {
	return {
		blockId,
		index,
		phase,
		attempt: `attempt-${blockId}`,
		invocationRef: `invocation:${blockId}`,
		lanes: [],
		turnEnding: false,
	}
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
		const retire = result.commands.find((command) => command.type === "tool.retire")
		const compose = result.commands.find((command) => command.type === "compose.round")
		expect(retire).toMatchObject({ type: "tool.retire", turnId: "turn-1" })
		expect(compose).toMatchObject({ type: "compose.round", admittedEntryIds: [] })
		if (!compose || compose.type !== "compose.round") throw new Error("expected next compose command")
		expect(compose.toolTerminals).toEqual({
			turnId: "turn-1",
			blocks: [
				{ blockId: "b1", phase: "completed", invocationRef: "invocation:b1" },
				{ blockId: "b2", phase: "completed", invocationRef: "invocation:b2" },
			],
		})
		expect(compose.turnId).toBe(`turn:${compose.commandId}`)
		expect(compose.turnId).not.toBe("turn-1")
	})

	it("freezes every terminal phase in stable block order without reordering kernel state", () => {
		const turn: TaskState["turn"] = {
			turnId: "turn-1",
			mode: "parallel",
			blocks: [
				block("b3", 3, "cancelled"),
				{ ...block("b1", 1, "rejected"), approvalFeedbackRef: "feedback:b1" },
				block("b4", 4, "skipped"),
				block("b0", 0, "completed"),
				block("b2", 2, "failed"),
			],
			manualApprovalBlockIds: [],
			automaticApprovalBlockIds: [],
			executingBlockIds: [],
		}

		expect(toolTerminalManifestPayload(turn)).toEqual({
			toolTerminals: {
				turnId: "turn-1",
				blocks: [
					{ blockId: "b0", phase: "completed", invocationRef: "invocation:b0" },
					{
						blockId: "b1",
						phase: "rejected",
						invocationRef: "invocation:b1",
						approvalFeedbackRef: "feedback:b1",
					},
					{ blockId: "b2", phase: "failed", invocationRef: "invocation:b2" },
					{ blockId: "b3", phase: "cancelled", invocationRef: "invocation:b3" },
					{ blockId: "b4", phase: "skipped", invocationRef: "invocation:b4" },
				],
			},
		})
		expect(turn.blocks.map((candidate) => candidate.blockId)).toEqual(["b3", "b1", "b4", "b0", "b2"])
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

	it("presents a compose failure in the words of the domain that failed", () => {
		const compose = activeCompose()
		const result = accepted(
			transition(compose.state, {
				type: "compose.failed",
				generation: 0,
				commandId: compose.command.commandId,
				originRevision: compose.command.originRevision,
				turnId: "turn-1",
				message: "automatic_compaction_failed",
				presentation: "Provider rejected the compaction Pass",
			}),
		)
		expect(result.state.dialog.primary).toMatchObject({
			kind: "error_retry",
			presentationRef: "Provider rejected the compaction Pass",
		})
	})

	// The chat renders the presentation as the failure itself: the provider's
	// own description (a 403 naming the invalid Profile) must reach it, not an
	// interaction id that names no cause.
	it("presents a provider failure in the provider's own words", () => {
		const provider = (presentation?: string) => {
			const compose = activeCompose()
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
			const start = composed.commands.find(
				(candidate): candidate is ProviderStartCommand => candidate.type === "provider.start",
			)
			if (!start) throw new Error("expected provider command")
			return accepted(
				transition(composed.state, {
					type: "provider.failed",
					generation: 0,
					commandId: start.commandId,
					originRevision: start.originRevision,
					turnId: "turn-1",
					message: "provider execution failed (Error)",
					...(presentation === undefined ? {} : { presentation }),
				}),
			)
		}

		const described = provider('{"message":"Profile not valid","status":403}')
		expect(described.state.dialog.primary).toMatchObject({
			kind: "error_retry",
			presentationRef: '{"message":"Profile not valid","status":403}',
		})
		expect(described.commands).toEqual([
			expect.objectContaining({
				type: "dialog.prepare",
				presentationRef: '{"message":"Profile not valid","status":403}',
			}),
		])
		// Without a description the interaction still opens, under its own id.
		const undescribed = provider()
		expect(undescribed.state.dialog.primary?.presentationRef).toBe(undescribed.state.dialog.primary?.interactionId)
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
				journalWatermark: { seq: 1 },
				turnPlan: { mode: "serial", blocks: [] },
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
})

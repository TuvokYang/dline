import { describe, expect, it } from "vitest"
import { transition } from "../transition"
import type { ComposeRoundCommand, TaskState, TransitionResult } from "../types"
import { createInitialTaskState } from "../types"

function accepted(result: TransitionResult): Extract<TransitionResult, { kind: "accepted" }> {
	expect(result.kind).toBe("accepted")
	if (result.kind !== "accepted") throw new Error(result.diagnostic.message)
	return result
}

function composing() {
	const initial: TaskState = { ...createInitialTaskState("task-1"), flow: { phase: "running" } }
	const submitted = accepted(
		transition(initial, { type: "user.submit", generation: 0, entryId: "entry-1", payloadRef: "input:1" }),
	)
	const command = submitted.commands.find((candidate): candidate is ComposeRoundCommand => candidate.type === "compose.round")
	if (!command) throw new Error("expected compose command")
	return { state: submitted.state, command }
}

/**
 * A round withdrawn at its barrier - a `/compact` the user stopped or whose
 * review they withdrew - must neither reach the provider nor open an error to
 * retry: the user made that decision, and the task waits for them. A `/compact`
 * that failed is not withdrawn; it fails the round so Retry is offered.
 */
describe("task kernel compose.withdrawn", () => {
	it("settles the round without a provider request or an error dialog", () => {
		const compose = composing()
		const result = accepted(
			transition(compose.state, {
				type: "compose.withdrawn",
				generation: 0,
				commandId: compose.command.commandId,
				originRevision: compose.command.originRevision,
				reason: "manual_compaction_withdrawn",
			}),
		)

		expect(result.commands).toEqual([])
		expect(result.state.flow.phase).toBe("waiting")
		expect(result.state.flow.error).toBeUndefined()
		expect(result.state.flow.compose?.status).toBe("cancelled")
		expect(result.state.dialog.primary).toBeUndefined()
		// The input is released, not re-admitted by the next round.
		expect(result.state.intake.queued[0]?.state).toBe("released")
	})

	it("lets the next submission open a fresh round", () => {
		const compose = composing()
		const withdrawn = accepted(
			transition(compose.state, {
				type: "compose.withdrawn",
				generation: 0,
				commandId: compose.command.commandId,
				originRevision: compose.command.originRevision,
				reason: "manual_compaction_withdrawn",
			}),
		)
		const next = accepted(
			transition(withdrawn.state, { type: "user.submit", generation: 0, entryId: "entry-2", payloadRef: "input:2" }),
		)

		expect(next.commands).toEqual([expect.objectContaining({ type: "compose.round", admittedEntryIds: ["entry-2"] })])
	})

	it("refuses a withdrawal from a round that is no longer active", () => {
		const compose = composing()
		const result = transition(compose.state, {
			type: "compose.withdrawn",
			generation: 0,
			commandId: "compose:stale",
			originRevision: compose.command.originRevision,
			reason: "manual_compaction_withdrawn",
		})

		expect(result).toMatchObject({ kind: "rejected", reason: "identity_mismatch" })
	})
})

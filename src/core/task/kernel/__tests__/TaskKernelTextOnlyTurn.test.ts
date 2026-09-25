import { describe, expect, it } from "vitest"
import { transition } from "../transition"
import type { Command, ProviderTurnBlockPlan, TaskState, TransitionResult } from "../types"
import { createInitialTaskState } from "../types"

function accepted(result: TransitionResult): Extract<TransitionResult, { kind: "accepted" }> {
	expect(result.kind).toBe("accepted")
	if (result.kind !== "accepted") throw new Error(result.diagnostic.message)
	return result
}

function toolBlock(blockId: string): ProviderTurnBlockPlan {
	return {
		blockId,
		attempt: `attempt-${blockId}`,
		index: 0,
		lanes: [],
		turnEnding: false,
		invocationRef: `invocation:${blockId}`,
		approval: { kind: "none" },
	}
}

/** A task whose provider command is live, which is what `provider.turn_ready` answers. */
function awaitingProvider(streak?: number): TaskState {
	const base = createInitialTaskState("task-1")
	return {
		...base,
		revision: 4,
		flow: {
			phase: "running",
			...(streak === undefined ? {} : { textOnlyTurnStreak: streak }),
			provider: { commandId: "provider:1", originRevision: 4, status: "running", turnId: "turn-1" },
		},
	}
}

function turnReady(blocks: readonly ProviderTurnBlockPlan[]) {
	return {
		type: "provider.turn_ready" as const,
		generation: 0,
		commandId: "provider:1",
		originRevision: 4,
		turnId: "turn-1",
		finalPayloadRef: "final:1",
		journalWatermark: { seq: 3 },
		turnPlan: { mode: "serial" as const, blocks },
	}
}

function composeRounds(commands: readonly Command[]) {
	return commands.filter((command) => command.type === "compose.round")
}

describe("kernel continuation after a turn that used no tool", () => {
	it("opens the next round and names why, so a plain answer does not end the task", () => {
		const result = accepted(transition(awaitingProvider(), turnReady([])))
		expect(composeRounds(result.commands)).toEqual([
			expect.objectContaining({ type: "compose.round", admittedEntryIds: [], continuation: "no_tools_used" }),
		])
		expect(result.state.flow.compose?.status).toBe("running")
		expect(result.state.flow.textOnlyTurnStreak).toBe(1)
	})

	it("does not continue a turn that planned a tool, because the block will settle it", () => {
		const result = accepted(transition(awaitingProvider(), turnReady([toolBlock("b1")])))
		expect(composeRounds(result.commands)).toEqual([])
		expect(result.commands).toEqual([expect.objectContaining({ type: "tool.run", turnId: "turn-1" })])
		expect(result.state.flow.textOnlyTurnStreak).toBe(0)
	})

	it("hands the task back once the streak passes its bound, instead of looping forever", () => {
		// Each round is answered by a fresh provider command, so the streak is the
		// only thing that grows; the fourth answer is where continuing stops.
		let state = awaitingProvider()
		for (let turn = 1; turn <= 4; turn++) {
			const result = accepted(transition(state, turnReady([])))
			expect(result.state.flow.textOnlyTurnStreak).toBe(turn)
			expect(composeRounds(result.commands)).toHaveLength(turn <= 3 ? 1 : 0)
			state = { ...awaitingProvider(result.state.flow.textOnlyTurnStreak), revision: result.state.revision }
		}
	})

	it("stays silent while a question is awaiting the user, whose turn it is to speak", () => {
		const waiting: TaskState = {
			...awaitingProvider(),
			dialog: {
				approvalsByBlock: {},
				primary: {
					interactionId: "ask-1",
					turnId: "turn-1",
					kind: "followup",
					status: "awaiting",
					createdRevision: 3,
					presentationRef: "presentation:ask-1",
					actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
				},
			},
		}
		expect(composeRounds(accepted(transition(waiting, turnReady([]))).commands)).toEqual([])
	})

	it("resets the streak when the user submits, since the reason for the bound is gone", () => {
		const continued = accepted(transition(awaitingProvider(3), turnReady([])))
		expect(continued.state.flow.textOnlyTurnStreak).toBe(4)
		const submitted = accepted(
			transition(continued.state, { type: "user.submit", generation: 0, entryId: "entry-1", payloadRef: "input:1" }),
		)
		expect(submitted.state.flow.textOnlyTurnStreak).toBe(0)
	})

	it("carries an entry that arrived mid-turn into the round it opens", () => {
		// A submission during a live round is accepted but cannot open one, so the
		// round opened when that round ends is its only way to reach a request.
		const waiting: TaskState = {
			...awaitingProvider(),
			intake: {
				queued: [
					{ entryId: "entry-2", payloadRef: "input:2", source: "user", mode: "queued", sequence: 1, state: "accepted" },
				],
				background: [],
				coTask: [],
			},
		}
		expect(composeRounds(accepted(transition(waiting, turnReady([]))).commands)).toEqual([
			expect.objectContaining({ type: "compose.round", admittedEntryIds: ["entry-2"] }),
		])
	})

	it("carries a waiting entry even after the text-only budget is spent, because the user spoke", () => {
		const waiting: TaskState = {
			...awaitingProvider(MAX_TEXT_ONLY_STREAK),
			intake: {
				queued: [
					{ entryId: "entry-2", payloadRef: "input:2", source: "user", mode: "queued", sequence: 1, state: "accepted" },
				],
				background: [],
				coTask: [],
			},
		}
		const result = accepted(transition(waiting, turnReady([])))
		// The budget alone would have stopped here; the waiting entry is a new
		// request from the user, so it is not what the budget was meant to bound.
		expect(composeRounds(accepted(transition(awaitingProvider(MAX_TEXT_ONLY_STREAK), turnReady([]))).commands)).toEqual([])
		expect(composeRounds(result.commands)).toEqual([
			expect.objectContaining({ type: "compose.round", admittedEntryIds: ["entry-2"] }),
		])
	})

	it("reserves the entry it admitted, so the next round cannot admit it twice", () => {
		const waiting: TaskState = {
			...awaitingProvider(),
			intake: {
				queued: [
					{ entryId: "entry-2", payloadRef: "input:2", source: "user", mode: "queued", sequence: 1, state: "accepted" },
				],
				background: [],
				coTask: [],
			},
		}
		expect(accepted(transition(waiting, turnReady([]))).state.intake.queued[0].state).toBe("reserved")
	})
})

/** The streak value at which the kernel stops continuing on its own. */
const MAX_TEXT_ONLY_STREAK = 4

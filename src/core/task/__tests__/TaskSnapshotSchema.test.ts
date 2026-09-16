import { describe, expect, it } from "vitest"
import { BlockPhase } from "../BlockPhaseMachine"
import { type ActiveInteraction } from "../interaction/InteractionReducer"
import { createTaskRuntimeState, type TaskRuntimeState, type TurnState } from "../runtime/TaskRuntimeState"
import { TaskPhase } from "../TaskPhase"
import { createSnapshot, hydrateSnapshot, TaskSnapshotIdentityError } from "../TaskSnapshot"

/** Create one canonical turn with a focus-chain approval block. */
function focusChainTurn(): TurnState {
	return {
		turnId: "turn-1",
		assistantApiIndex: 4,
		mode: "serial",
		activeDlineTid: "tid-1",
		blocks: [
			{
				dlineTid: "tid-1",
				functionId: "call-1",
				toolName: "change_todo_list",
				phase: BlockPhase.AWAITING_APPROVAL,
				ts: 100,
				requiresApproval: true,
				conversationHistoryIndex: 4,
			},
		],
	}
}

/** Create the active interaction associated with the canonical turn. */
function focusChainInteraction(): ActiveInteraction {
	return {
		taskId: "task-1",
		turnId: "turn-1",
		interactionId: "interaction-1",
		kind: "change_todo_list",
		status: "awaiting",
		createdRevision: 7,
	}
}

/** Create runtime state containing canonical turn and interaction identity. */
function runtimeState(): TaskRuntimeState {
	return {
		taskId: "task-1",
		phase: TaskPhase.AWAITING_APPROVAL,
		revision: 7,
		anchor: {
			apiIndex: 4,
			uiMessageTs: 100,
			turnId: "turn-1",
			interactionId: "interaction-1",
		},
		turn: focusChainTurn(),
		interaction: focusChainInteraction(),
	}
}

describe("TaskSnapshot v2 schema", () => {
	it("round-trips canonical turn and active interaction", () => {
		const state = runtimeState()
		const snapshot = createSnapshot(state, 200)

		expect(snapshot).toMatchObject({
			version: 2,
			taskId: "task-1",
			revision: 7,
			anchor: { apiIndex: 4, uiMessageTs: 100, turnId: "turn-1", interactionId: "interaction-1" },
			turn: { activeDlineTid: "tid-1" },
			interaction: { kind: "change_todo_list", status: "awaiting" },
		})
		expect(hydrateSnapshot(snapshot)).toEqual(state)
	})

	it("round-trips the explicit Profile recovery input admission", () => {
		const state = createTaskRuntimeState({
			taskId: "task-1",
			phase: TaskPhase.BETWEEN_TURNS,
			revision: 8,
			anchor: { apiIndex: 4 },
		})
		state.ordinaryInput = { kind: "profile_recovery" }

		const snapshot = createSnapshot(state, 200)
		const hydrated = hydrateSnapshot(snapshot)

		expect(snapshot.ordinaryInput).toEqual({ kind: "profile_recovery" })
		expect(hydrated.ordinaryInput).toEqual({ kind: "profile_recovery" })
		expect(hydrated.ordinaryInput).not.toBe(snapshot.ordinaryInput)
	})

	it("rejects an ordinary input admission outside the between-turns recovery boundary", () => {
		const snapshot = createSnapshot(runtimeState(), 200)
		snapshot.ordinaryInput = { kind: "profile_recovery" }

		expect(() => hydrateSnapshot(snapshot)).toThrowError("invalid_ordinary_input_admission")
	})

	it("ignores a legacy persisted Profile validity error during hydration", () => {
		const snapshot = createSnapshot(runtimeState(), 200)
		snapshot.profileInvalid = {
			profileId: "profile-deleted",
			displayName: "deleted-profile",
			reason: "missing",
			message: 'Profile not valid: "deleted-profile" no longer exists.',
		}

		expect(hydrateSnapshot(snapshot)).not.toHaveProperty("profileInvalid")
	})

	it("round-trips an interrupting interaction and its hidden original without shared anchors", () => {
		const state = runtimeState()
		state.revision = 8
		state.anchor = {
			apiIndex: 4,
			uiMessageTs: 200,
			turnId: "condense-turn",
			interactionId: "condense-1",
		}
		state.interruptedInteraction = {
			...focusChainInteraction(),
			anchor: { messageTs: 100, messageType: "ask" },
		}
		state.interaction = {
			taskId: "task-1",
			turnId: "condense-turn",
			interactionId: "condense-1",
			kind: "condense",
			status: "awaiting",
			createdRevision: 8,
			anchor: { messageTs: 200, messageType: "ask" },
		}

		const snapshot = createSnapshot(state, 250)
		const hydrated = hydrateSnapshot(snapshot)

		expect(snapshot).toMatchObject({
			interaction: { kind: "condense", interactionId: "condense-1" },
			interruptedInteraction: { kind: "change_todo_list", interactionId: "interaction-1" },
		})
		expect(snapshot.interaction).not.toBe(state.interaction)
		expect(snapshot.interaction?.anchor).not.toBe(state.interaction.anchor)
		expect(snapshot.interruptedInteraction).not.toBe(state.interruptedInteraction)
		expect(snapshot.interruptedInteraction?.anchor).not.toBe(state.interruptedInteraction.anchor)
		expect(hydrated.interaction).not.toBe(snapshot.interaction)
		expect(hydrated.interaction?.anchor).not.toBe(snapshot.interaction?.anchor)
		expect(hydrated.interruptedInteraction).not.toBe(snapshot.interruptedInteraction)
		expect(hydrated.interruptedInteraction?.anchor).not.toBe(snapshot.interruptedInteraction?.anchor)
		expect(hydrated).toEqual(state)
	})

	it("rejects missing interrupted interaction identity", () => {
		const snapshot = createSnapshot(runtimeState(), 200)
		snapshot.interruptedInteraction = {
			...focusChainInteraction(),
			interactionId: "",
		}

		expect(() => hydrateSnapshot(snapshot)).toThrowError("invalid_snapshot_identity: interactionId")
	})

	it("round-trips only the consumed New Task identity for crash recovery", () => {
		const state = createTaskRuntimeState({
			taskId: "task-1",
			phase: TaskPhase.ABORTED,
			revision: 9,
			anchor: { apiIndex: 4, turnId: "turn-new-task" },
		})
		state.newTaskConsumed = {
			functionId: "function-new-task",
			dlineTid: "tid-new-task",
		}

		const snapshot = createSnapshot(state, 200)
		const hydrated = hydrateSnapshot(snapshot)

		expect(snapshot).toMatchObject({
			phase: TaskPhase.ABORTED,
			newTaskConsumed: {
				functionId: "function-new-task",
				dlineTid: "tid-new-task",
			},
		})
		expect(snapshot).not.toHaveProperty("pendingReplacement")
		expect(hydrated.newTaskConsumed).toEqual(state.newTaskConsumed)
		expect(hydrated.newTaskConsumed).not.toBe(state.newTaskConsumed)
	})

	it("round-trips the accepted response required by a resolving interaction", () => {
		const state = runtimeState()
		state.interaction = {
			...focusChainInteraction(),
			status: "resolving",
			acceptedResponse: {
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "interaction-1",
				actionId: "approve",
				stateRevision: 7,
				draft: { text: "Approved", images: ["image"], files: ["file"] },
				selection: { values: ["item"] },
			},
		}

		const hydrated = hydrateSnapshot(createSnapshot(state, 200))

		expect(hydrated.interaction?.acceptedResponse).toEqual(state.interaction.acceptedResponse)
		expect(hydrated.interaction?.acceptedResponse).not.toBe(state.interaction.acceptedResponse)
		expect(hydrated.interaction?.acceptedResponse?.draft?.images).not.toBe(state.interaction.acceptedResponse?.draft?.images)
	})

	it("rejects a resolving interaction without its accepted response", () => {
		const state = runtimeState()
		state.interaction = { ...focusChainInteraction(), status: "resolving" }

		expect(() => createSnapshot(state, 200)).toThrowError("invalid_resolving_interaction")
	})

	it("rejects a resolving response with mismatched causal identity", () => {
		const state = runtimeState()
		state.interaction = {
			...focusChainInteraction(),
			status: "resolving",
			acceptedResponse: {
				taskId: "other-task",
				turnId: "turn-1",
				interactionId: "interaction-1",
				actionId: "approve",
				stateRevision: 7,
				draft: { text: "", images: [], files: [] },
			},
		}

		expect(() => createSnapshot(state, 200)).toThrowError("invalid_resolving_interaction_identity")
	})

	it("rejects a turn block without canonical dline identity", () => {
		const snapshot = createSnapshot(runtimeState(), 200)
		if (!snapshot.turn) {
			throw new Error("Expected snapshot turn")
		}
		snapshot.turn.blocks[0] = { ...snapshot.turn.blocks[0], dlineTid: "" }

		expect(() => hydrateSnapshot(snapshot)).toThrowError(TaskSnapshotIdentityError)
		expect(() => hydrateSnapshot(snapshot)).toThrowError("invalid_snapshot_identity: dlineTid")
	})

	it("rejects missing turn identity", () => {
		const snapshot = createSnapshot(runtimeState(), 200)
		if (!snapshot.turn) {
			throw new Error("Expected snapshot turn")
		}
		snapshot.turn.turnId = ""

		expect(() => hydrateSnapshot(snapshot)).toThrowError("invalid_snapshot_identity: turnId")
	})

	it("rejects missing interaction identity", () => {
		const snapshot = createSnapshot(runtimeState(), 200)
		if (!snapshot.interaction) {
			throw new Error("Expected snapshot interaction")
		}
		snapshot.interaction.interactionId = ""

		expect(() => hydrateSnapshot(snapshot)).toThrowError("invalid_snapshot_identity: interactionId")
	})
})

import { describe, expect, it } from "vitest"
import { TaskPhase } from "../../TaskPhase"
import { reduceTask } from "../TaskReducer"
import { createTaskRuntimeState, type TaskRuntimeState } from "../TaskRuntimeState"

function profileErrorState(kind: "error_retry" | "tool_approval" = "error_retry"): TaskRuntimeState {
	return {
		...createTaskRuntimeState({
			taskId: "task-1",
			phase: TaskPhase.AWAITING_APPROVAL,
			revision: 4,
			anchor: { apiIndex: 2, uiMessageTs: 100, turnId: "retry-1", interactionId: "retry-1" },
		}),
		interaction: {
			taskId: "task-1",
			turnId: "retry-1",
			interactionId: "retry-1",
			kind,
			status: "awaiting",
			createdRevision: 4,
			anchor: { messageTs: 100, messageType: "ask" },
		},
	}
}

describe("Task Profile recovery runtime", () => {
	it("closes the matching Profile error interaction after a durable replacement commit", () => {
		const result = reduceTask(profileErrorState(), {
			type: "PROFILE_RECOVERY_COMMITTED",
			interactionId: "retry-1",
		})

		expect(result.accepted).toBe(true)
		expect(result.next.phase).toBe(TaskPhase.BETWEEN_TURNS)
		expect(result.next.interaction).toBeUndefined()
		expect(result.next.ordinaryInput).toEqual({ kind: "profile_recovery" })
		expect(result.next.anchor).toEqual({ apiIndex: 2, uiMessageTs: 100 })
		expect(result.effects.map((effect) => effect.type)).toEqual(["POST_TASK_VIEW", "PERSIST_SNAPSHOT"])
	})

	it("admits exactly one ordinary reply after Profile recovery", () => {
		const recovered = reduceTask(profileErrorState(), {
			type: "PROFILE_RECOVERY_COMMITTED",
			interactionId: "retry-1",
		})
		const event = {
			type: "PROFILE_RECOVERY_INPUT_RECEIVED" as const,
			draft: { text: "continue with this profile", images: ["image"], files: ["file"] },
		}

		const claimed = reduceTask(recovered.next, event)
		const duplicate = reduceTask(claimed.next, event)

		expect(claimed.accepted).toBe(true)
		expect(claimed.next.revision).toBe(recovered.next.revision + 1)
		expect(claimed.next.ordinaryInput).toBeUndefined()
		expect(claimed.effects.map((effect) => effect.type)).toEqual(["APPEND_SAY", "POST_TASK_VIEW", "PERSIST_SNAPSHOT"])
		expect(claimed.effects[0]).toMatchObject({
			type: "APPEND_SAY",
			taskSay: "user_feedback",
			presentation: "continue with this profile",
			images: ["image"],
			files: ["file"],
			userInputKind: "direct",
		})
		expect(duplicate.accepted).toBe(false)
		expect(duplicate.next).toBe(claimed.next)
		expect(duplicate.effects).toEqual([])
	})

	it("clears Profile recovery input admission when another interaction opens", () => {
		const recovered = reduceTask(profileErrorState(), {
			type: "PROFILE_RECOVERY_COMMITTED",
			interactionId: "retry-1",
		})

		const opened = reduceTask(recovered.next, {
			type: "INTERACTION_OPEN_REQUESTED",
			turnId: "followup-turn",
			interactionId: "followup-1",
			kind: "followup",
			presentation: "Need more information",
		})

		expect(opened.accepted).toBe(true)
		expect(opened.next.interaction).toMatchObject({ interactionId: "followup-1", kind: "followup" })
		expect(opened.next.ordinaryInput).toBeUndefined()
	})

	it("does not clear a non-error interaction", () => {
		const state = profileErrorState("tool_approval")
		const result = reduceTask(state, {
			type: "PROFILE_RECOVERY_COMMITTED",
			interactionId: "retry-1",
		})

		expect(result.accepted).toBe(false)
		expect(result.next).toBe(state)
	})
})

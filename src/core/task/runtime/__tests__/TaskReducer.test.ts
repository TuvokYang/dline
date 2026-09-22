import { describe, expect, it } from "vitest"
import { BlockPhase } from "../../BlockPhaseMachine"
import { TaskPhase } from "../../TaskPhase"
import { reduceTask } from "../TaskReducer"
import { createTaskRuntimeState, type TaskRuntimeState } from "../TaskRuntimeState"

/** Create a runtime state restored to a focused test phase. */
function stateAt(phase: TaskPhase) {
	return createTaskRuntimeState({ taskId: "task-1", phase })
}

/** Create runtime state awaiting one causal tool approval response. */
function awaitingInteraction(): TaskRuntimeState & { interaction: NonNullable<TaskRuntimeState["interaction"]> } {
	return {
		...createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.AWAITING_APPROVAL, revision: 4 }),
		interaction: {
			taskId: "task-1",
			turnId: "turn-1",
			interactionId: "interaction-1",
			kind: "tool_approval",
			status: "awaiting" as const,
			createdRevision: 4,
			anchor: { messageTs: 100, messageType: "ask" as const },
		},
	}
}

describe("reduceTask lifecycle events", () => {
	it("initializes an idle task", () => {
		const result = reduceTask(stateAt(TaskPhase.IDLE), { type: "TASK_INITIALIZE_REQUESTED" })

		expect(result).toMatchObject({ accepted: true, next: { phase: TaskPhase.INITIALIZING, revision: 1 } })
		expect(result.effects.map((effect) => effect.type)).toEqual(["POST_TASK_VIEW", "PERSIST_SNAPSHOT"])
	})

	it("moves initialization to waiting when no task is supplied", () => {
		const result = reduceTask(stateAt(TaskPhase.INITIALIZING), {
			type: "TASK_INITIALIZED",
			anchor: { apiIndex: -1 },
			hasTask: false,
		})

		expect(result).toMatchObject({ accepted: true, next: { phase: TaskPhase.WAITING_FOR_TASK } })
		expect(result.next.anchor).toEqual({ apiIndex: -1 })
	})

	it("starts API streaming from initialization", () => {
		const result = reduceTask(stateAt(TaskPhase.INITIALIZING), { type: "API_REQUEST_STARTED", apiIndex: 3 })

		expect(result).toMatchObject({ accepted: true, next: { phase: TaskPhase.STREAMING } })
		expect(result.next.anchor.apiIndex).toBe(3)
		expect(result.effects.map((effect) => effect.type)).toEqual(["POST_TASK_VIEW", "PERSIST_SNAPSHOT"])
	})

	it("starts exactly one reconciled API continuation through an ordered effect", () => {
		const result = reduceTask(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING, anchor: { apiIndex: 3 } }),
			{
				type: "RESUME_API_CONTINUATION_REQUESTED",
				apiIndex: 3,
				draft: { text: "Continue", images: ["image"], files: ["file"] },
			},
		)

		expect(result).toMatchObject({ accepted: true, next: { phase: TaskPhase.STREAMING } })
		expect(result.effects.map((effect) => effect.type)).toEqual(["POST_TASK_VIEW", "START_API", "PERSIST_SNAPSHOT"])
		expect(result.effects[1]).toMatchObject({
			type: "START_API",
			apiIndex: 3,
			draft: { text: "Continue", images: ["image"], files: ["file"] },
		})
	})

	it("continues an approved restored Hosted Web request through exactly one persisted-request effect", () => {
		const interactionId = "hosted-web:task-1:3"
		const state = {
			...createTaskRuntimeState({
				taskId: "task-1",
				phase: TaskPhase.STREAMING,
				revision: 5,
				anchor: { apiIndex: 3, turnId: interactionId, interactionId },
			}),
			interaction: {
				taskId: "task-1",
				turnId: interactionId,
				interactionId,
				kind: "hosted_web_approval" as const,
				status: "resolving" as const,
				createdRevision: 4,
				anchor: { messageTs: 100, messageType: "ask" as const },
				acceptedResponse: {
					taskId: "task-1",
					turnId: interactionId,
					interactionId,
					actionId: "approve" as const,
					stateRevision: 4,
					draft: { text: "", images: [], files: [] },
				},
			},
		}

		const result = reduceTask(state, {
			type: "HOSTED_WEB_REQUEST_CONTINUATION_REQUESTED",
			interactionId,
			apiIndex: 3,
		})

		expect(result).toMatchObject({
			accepted: true,
			next: { phase: TaskPhase.STREAMING, interaction: undefined, anchor: { apiIndex: 3 } },
		})
		expect(result.effects.map((effect) => effect.type)).toEqual(["POST_TASK_VIEW", "START_API", "PERSIST_SNAPSHOT"])
		expect(result.effects.filter((effect) => effect.type === "START_API")).toHaveLength(1)
		expect(result.effects[1]).toMatchObject({
			type: "START_API",
			apiIndex: 3,
			persistedRequest: true,
		})
	})

	it("rejects an API continuation while an unfinished restored turn still owns execution", () => {
		const state = createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING, anchor: { apiIndex: 3 } })
		state.turn = {
			turnId: "stale-turn",
			assistantApiIndex: 2,
			mode: "serial",
			blocks: [
				{
					dlineTid: "stale-tid",
					functionId: "stale-call",
					toolName: "status_update",
					phase: BlockPhase.AWAITING_APPROVAL,
					ts: 90,
					requiresApproval: true,
					conversationHistoryIndex: 2,
				},
			],
		}

		const result = reduceTask(state, { type: "RESUME_API_CONTINUATION_REQUESTED", apiIndex: 3 })

		expect(result).toMatchObject({ accepted: false, error: { code: "invalid_runtime_event" } })
	})

	it("normalizes only reconciled pending blocks before replay", () => {
		const result = reduceTask(
			{
				...createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.AWAITING_APPROVAL, revision: 4 }),
				turn: {
					turnId: "turn-1",
					assistantApiIndex: 2,
					mode: "serial",
					activeDlineTid: "tid-1",
					blocks: [
						{
							dlineTid: "tid-1",
							functionId: "call-1",
							toolName: "write_to_file",
							phase: BlockPhase.AWAITING_APPROVAL,
							ts: 90,
							requiresApproval: true,
							conversationHistoryIndex: 2,
						},
						{
							dlineTid: "tid-2",
							functionId: "call-2",
							toolName: "read_file",
							phase: BlockPhase.COMPLETED,
							ts: 91,
							requiresApproval: false,
							conversationHistoryIndex: 2,
						},
					],
				},
			},
			{ type: "RESUME_BLOCK_REPLAY_REQUESTED", turnId: "turn-1", dlineTids: ["tid-1"] },
		)

		expect(result).toMatchObject({
			accepted: true,
			next: {
				phase: TaskPhase.STREAMING,
				turn: { activeDlineTid: undefined, blocks: [{ phase: "streaming" }, { phase: "completed" }] },
			},
		})
	})

	it("opens an approval checkpoint from streaming", () => {
		const result = reduceTask(stateAt(TaskPhase.STREAMING), {
			type: "APPROVAL_REQUIRED",
			turnId: "turn-1",
			interactionId: "interaction-1",
		})

		expect(result).toMatchObject({
			accepted: true,
			next: {
				phase: TaskPhase.AWAITING_APPROVAL,
				anchor: { turnId: "turn-1", interactionId: "interaction-1" },
			},
		})
	})

	it("opens and presents one canonical interaction without message inference", () => {
		const opened = reduceTask(stateAt(TaskPhase.STREAMING), {
			type: "INTERACTION_OPEN_REQUESTED",
			turnId: "turn-1",
			interactionId: "interaction-1",
			kind: "qna_response",
			presentation: JSON.stringify({ response: "Answer" }),
			existingTs: 100,
		})

		expect(opened).toMatchObject({
			accepted: true,
			next: {
				revision: 1,
				interaction: {
					taskId: "task-1",
					turnId: "turn-1",
					interactionId: "interaction-1",
					kind: "qna_response",
					status: "opening",
					createdRevision: 1,
				},
			},
		})
		expect(opened.effects).toEqual([
			expect.objectContaining({
				type: "APPEND_ASK",
				interactionId: "interaction-1",
				taskAsk: "qna_respond",
				presentation: JSON.stringify({ response: "Answer" }),
				existingTs: 100,
			}),
		])

		const presented = reduceTask(opened.next, {
			type: "INTERACTION_PRESENTED",
			interactionId: "interaction-1",
			messageTs: 100,
		})
		expect(presented).toMatchObject({
			accepted: true,
			next: {
				revision: 2,
				anchor: { uiMessageTs: 100, turnId: "turn-1", interactionId: "interaction-1" },
				interaction: { status: "awaiting", anchor: { messageTs: 100, messageType: "ask" } },
			},
		})
		expect(presented.effects.map((effect) => effect.type)).toEqual(["POST_TASK_VIEW", "PERSIST_SNAPSHOT"])
	})

	it("temporarily replaces one awaiting interaction and restores its causal anchor", () => {
		const original = awaitingInteraction()
		const interrupted = reduceTask(original, {
			type: "INTERACTION_INTERRUPT_REQUESTED",
			turnId: "condense-turn",
			interactionId: "condense-1",
			kind: "condense",
			presentation: "Compaction review",
		})

		expect(interrupted).toMatchObject({
			accepted: true,
			next: {
				anchor: { turnId: "condense-turn", interactionId: "condense-1" },
				interaction: { kind: "condense", status: "opening", interactionId: "condense-1" },
				interruptedInteraction: { kind: "tool_approval", status: "awaiting", interactionId: "interaction-1" },
			},
		})

		const presented = reduceTask(interrupted.next, {
			type: "INTERACTION_PRESENTED",
			interactionId: "condense-1",
			messageTs: 200,
		})
		const responded = reduceTask(presented.next, {
			type: "INTERACTION_RESPONDED",
			response: {
				taskId: "task-1",
				turnId: "condense-turn",
				interactionId: "condense-1",
				actionId: "confirm_utility",
				stateRevision: presented.next.revision,
			},
		})
		const restored = reduceTask(responded.next, {
			type: "INTERACTION_RESOLVED",
			interactionId: "condense-1",
		})

		expect(restored).toMatchObject({
			accepted: true,
			next: {
				anchor: { uiMessageTs: 100, turnId: "turn-1", interactionId: "interaction-1" },
				interaction: { kind: "tool_approval", status: "awaiting", interactionId: "interaction-1" },
				interruptedInteraction: undefined,
			},
		})
	})

	it.each(["opening", "resolving"] as const)("rejects interruption while the active interaction is %s", (status) => {
		const awaiting = awaitingInteraction()
		const state = { ...awaiting, interaction: { ...awaiting.interaction, status } }
		const result = reduceTask(state, {
			type: "INTERACTION_INTERRUPT_REQUESTED",
			turnId: "condense-turn",
			interactionId: "condense-1",
			kind: "condense",
			presentation: "Compaction review",
		})

		expect(result).toMatchObject({ accepted: false, error: { code: "invalid_runtime_event" } })
		expect(result.next).toBe(state)
	})

	it("rejects a nested interaction interruption", () => {
		const interrupted = reduceTask(awaitingInteraction(), {
			type: "INTERACTION_INTERRUPT_REQUESTED",
			turnId: "condense-turn",
			interactionId: "condense-1",
			kind: "condense",
			presentation: "Compaction review",
		})
		const nested = reduceTask(interrupted.next, {
			type: "INTERACTION_INTERRUPT_REQUESTED",
			turnId: "nested-turn",
			interactionId: "nested-1",
			kind: "condense",
			presentation: "Nested review",
		})

		expect(nested).toMatchObject({ accepted: false, error: { code: "invalid_runtime_event" } })
		expect(nested.next).toBe(interrupted.next)
	})

	it("clears both active and interrupted interactions when cancellation starts", () => {
		const interrupted = reduceTask(awaitingInteraction(), {
			type: "INTERACTION_INTERRUPT_REQUESTED",
			turnId: "condense-turn",
			interactionId: "condense-1",
			kind: "condense",
			presentation: "Compaction review",
		})
		const cancelled = reduceTask(interrupted.next, { type: "TASK_CANCEL_REQUESTED", source: "user" })

		expect(cancelled).toMatchObject({ accepted: true, next: { phase: TaskPhase.CANCELLING } })
		expect(cancelled.next.interaction).toBeUndefined()
		expect(cancelled.next.interruptedInteraction).toBeUndefined()
	})

	it("resolves only the matching active interaction", () => {
		const awaiting = awaitingInteraction()
		const state = { ...awaiting, interaction: { ...awaiting.interaction, status: "resolving" as const } }
		const result = reduceTask(state, {
			type: "INTERACTION_RESOLVED",
			interactionId: "interaction-1",
		})

		expect(result).toMatchObject({ accepted: true, next: { revision: 5 } })
		expect(result.next.interaction).toBeUndefined()
		expect(result.effects.map((effect) => effect.type)).toEqual(["POST_TASK_VIEW", "PERSIST_SNAPSHOT"])
	})

	it("commits a causal interaction response without changing task phase", () => {
		const result = reduceTask(awaitingInteraction(), {
			type: "INTERACTION_RESPONDED",
			response: {
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "interaction-1",
				actionId: "approve",
				stateRevision: 4,
				draft: { text: "", images: [], files: [] },
			},
		})

		expect(result).toMatchObject({
			accepted: true,
			next: { phase: TaskPhase.AWAITING_APPROVAL, revision: 5, interaction: { status: "resolving" } },
		})
		expect(result.effects.map((effect) => effect.type)).toEqual(["POST_TASK_VIEW", "PERSIST_SNAPSHOT"])
	})

	it("persists accepted interaction input before the continuation consumes it", () => {
		const result = reduceTask(awaitingInteraction(), {
			type: "INTERACTION_RESPONDED",
			response: {
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "interaction-1",
				actionId: "approve",
				stateRevision: 4,
				draft: { text: "Approval note", images: ["image"], files: ["file"] },
			},
		})

		expect(result.effects.map((effect) => effect.type)).toEqual(["APPEND_SAY", "POST_TASK_VIEW", "PERSIST_SNAPSHOT"])
		expect(result.effects[0]).toMatchObject({
			type: "APPEND_SAY",
			interactionId: "interaction-1",
			taskSay: "user_feedback",
			presentation: "Approval note",
			images: ["image"],
			files: ["file"],
			feedbackAcknowledgment: "yesButtonClicked",
		})
	})

	it("keeps queued model guidance out of the persisted user presentation", () => {
		const result = reduceTask(awaitingInteraction(), {
			type: "INTERACTION_RESPONDED",
			response: {
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "interaction-1",
				actionId: "approve",
				stateRevision: 4,
				draft: { text: "internal guidance\n\n你好", images: [], files: [] },
				presentationDraft: { text: "你好", images: [], files: [] },
				userInputKind: "queued",
				queuedInputMode: "queued",
			},
		})

		expect(result.effects[0]).toMatchObject({
			type: "APPEND_SAY",
			presentation: "你好",
			userInputKind: "queued",
			queuedInputMode: "queued",
			feedbackAcknowledgmentText: "internal guidance\n\n你好",
		})
	})

	it("rejects stale interaction revision without mutation", () => {
		const state = awaitingInteraction()
		const result = reduceTask(state, {
			type: "INTERACTION_RESPONDED",
			response: {
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "interaction-1",
				actionId: "approve",
				stateRevision: 3,
				draft: { text: "", images: [], files: [] },
			},
		})

		expect(result).toMatchObject({ accepted: false, error: { code: "stale_interaction" } })
		expect(result.next).toBe(state)
	})

	it("accepts the interaction revision that opened the request after unrelated state advances", () => {
		const initial = awaitingInteraction()
		const state = { ...initial, revision: initial.revision + 2 }
		const result = reduceTask(state, {
			type: "INTERACTION_RESPONDED",
			response: {
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "interaction-1",
				actionId: "approve",
				stateRevision: initial.interaction?.createdRevision ?? initial.revision,
				draft: { text: "", images: [], files: [] },
			},
		})

		expect(result.accepted).toBe(true)
	})

	it("rejects interaction payload mismatch without mutation", () => {
		const state = awaitingInteraction()
		const result = reduceTask(state, {
			type: "INTERACTION_RESPONDED",
			response: {
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "interaction-1",
				actionId: "approve",
				stateRevision: 4,
			},
		})

		expect(result).toMatchObject({ accepted: false, error: { code: "invalid_interaction_payload" } })
		expect(result.next).toBe(state)
	})

	it("turns TASK_CANCEL_REQUESTED into cancelling state and ordered effects", () => {
		const result = reduceTask(stateAt(TaskPhase.STREAMING), {
			type: "TASK_CANCEL_REQUESTED",
			source: "user",
		})

		expect(result.next).toMatchObject({
			phase: TaskPhase.CANCELLING,
			cancellation: { source: "user", fromPhase: TaskPhase.STREAMING },
		})
		expect(result.effects.map((effect) => effect.type)).toEqual(["POST_TASK_VIEW", "CANCEL_RUNTIME", "PERSIST_SNAPSHOT"])
	})

	it("opens a durable Resume interaction for the rejected pending Hosted Web request", () => {
		const result = reduceTask(
			createTaskRuntimeState({
				taskId: "task-1",
				phase: TaskPhase.PAUSED,
				revision: 7,
				anchor: {
					apiIndex: 0,
					turnId: "hosted-web:task-1:3",
					interactionId: "hosted-web:task-1:3",
				},
			}),
			{
				type: "HOSTED_WEB_REQUEST_REJECTED",
				apiIndex: 3,
				turnId: "hosted-web-rejected:task-1:3",
				interactionId: "hosted-web-rejected:task-1:3",
				presentation: "Hosted Web Search was rejected. Resume when you are ready to continue without this request.",
			},
		)

		expect(result).toMatchObject({
			accepted: true,
			next: {
				phase: TaskPhase.PAUSED,
				interaction: {
					kind: "resume",
					status: "opening",
					interactionId: "hosted-web-rejected:task-1:3",
				},
				anchor: { apiIndex: 3, interactionId: "hosted-web-rejected:task-1:3" },
			},
		})
		expect(result.effects).toMatchObject([
			{
				type: "APPEND_ASK",
				interactionId: "hosted-web-rejected:task-1:3",
				taskAsk: "resume_task",
			},
		])
	})

	it("rejects a Hosted Web recovery event that does not own the current approval anchor", () => {
		const state = createTaskRuntimeState({
			taskId: "task-1",
			phase: TaskPhase.PAUSED,
			revision: 7,
			anchor: {
				apiIndex: 0,
				turnId: "hosted-web:task-1:4",
				interactionId: "hosted-web:task-1:4",
			},
		})

		const result = reduceTask(state, {
			type: "HOSTED_WEB_REQUEST_REJECTED",
			apiIndex: 3,
			turnId: "hosted-web-rejected:task-1:3",
			interactionId: "hosted-web-rejected:task-1:3",
			presentation: "Hosted Web Search was rejected. Resume when you are ready to continue without this request.",
		})

		expect(result).toMatchObject({ accepted: false, error: { code: "invalid_runtime_event" } })
		expect(result.next).toBe(state)
	})

	it("completes cancellation into paused state", () => {
		const result = reduceTask(stateAt(TaskPhase.CANCELLING), { type: "TASK_CANCELLED" })

		expect(result).toMatchObject({ accepted: true, next: { phase: TaskPhase.PAUSED } })
		expect(result.effects.map((effect) => effect.type)).toEqual(["POST_TASK_VIEW", "PERSIST_SNAPSHOT"])
	})

	it("keeps cancellation causal when an effect from an older revision fails late", () => {
		const state = {
			...createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.CANCELLING, revision: 6 }),
			cancellation: { source: "user" as const, fromPhase: TaskPhase.EXECUTING },
			supersededEffectRevision: 5,
		}

		const failure = reduceTask(state, {
			type: "EFFECT_FAILED",
			effectId: "task-effect-5-2",
			effectType: "EXECUTE_TOOL",
			originRevision: 5,
			message: "Dline instance aborted",
		})
		const cancelled = reduceTask(failure.next, { type: "TASK_CANCELLED" })

		expect(failure).toEqual({ accepted: true, next: state, effects: [] })
		expect(cancelled).toMatchObject({ accepted: true, next: { phase: TaskPhase.PAUSED } })
	})

	it("still surfaces a failure owned by the current cancellation revision", () => {
		const state = {
			...createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.CANCELLING, revision: 6 }),
			cancellation: { source: "user" as const, fromPhase: TaskPhase.EXECUTING },
			supersededEffectRevision: 5,
		}

		const result = reduceTask(state, {
			type: "EFFECT_FAILED",
			effectId: "task-effect-6-2",
			effectType: "CANCEL_RUNTIME",
			originRevision: 6,
			message: "cancel failed",
		})

		expect(result).toMatchObject({
			accepted: true,
			next: { phase: TaskPhase.PAUSED, error: { effectType: "CANCEL_RUNTIME", message: "cancel failed" } },
		})
	})

	it("starts resume only from a causal resolving resume interaction", () => {
		const draft = { text: "Continue", images: [], files: [] }
		const result = reduceTask(
			{
				...stateAt(TaskPhase.PAUSED),
				anchor: { apiIndex: 1, turnId: "resume-turn", interactionId: "resume-1" },
				interaction: {
					taskId: "task-1",
					turnId: "resume-turn",
					interactionId: "resume-1",
					kind: "resume",
					status: "resolving",
					createdRevision: 1,
					anchor: { messageTs: 100, messageType: "ask" },
					acceptedResponse: {
						taskId: "task-1",
						turnId: "resume-turn",
						interactionId: "resume-1",
						actionId: "resume",
						stateRevision: 1,
						draft,
					},
				},
			},
			{
				type: "TASK_RESUME_REQUESTED",
				interactionId: "resume-1",
				draft,
			},
		)

		expect(result).toMatchObject({
			accepted: true,
			next: {
				phase: TaskPhase.RESUMING,
				anchor: { interactionId: "resume-1" },
				interaction: {
					kind: "resume",
					status: "resolving",
					acceptedResponse: { actionId: "resume", draft },
				},
			},
		})
		expect(result.effects.map((effect) => effect.type)).toEqual([
			"POST_TASK_VIEW",
			"PREPARE_RESUME",
			"APPEND_SAY",
			"START_API",
			"PERSIST_SNAPSHOT",
		])
		expect(result.effects[2]).toMatchObject({
			type: "APPEND_SAY",
			taskSay: "user_feedback",
			presentation: "Continue",
		})
		expect(result.effects[3]).toMatchObject({
			type: "START_API",
			apiIndex: 1,
			draft,
		})

		const admitted = reduceTask(result.next, { type: "API_REQUEST_STARTED", apiIndex: 1 })
		expect(admitted).toMatchObject({
			accepted: true,
			next: { phase: TaskPhase.STREAMING, anchor: { interactionId: undefined } },
		})
		expect(admitted.next.interaction).toBeUndefined()
	})

	it("does not append an empty timeline message when resume has no draft content", () => {
		const result = reduceTask(
			{
				...stateAt(TaskPhase.PAUSED),
				anchor: { apiIndex: 1, turnId: "resume-turn", interactionId: "resume-1" },
				interaction: {
					taskId: "task-1",
					turnId: "resume-turn",
					interactionId: "resume-1",
					kind: "resume",
					status: "resolving",
					createdRevision: 1,
					anchor: { messageTs: 100, messageType: "ask" },
				},
			},
			{
				type: "TASK_RESUME_REQUESTED",
				interactionId: "resume-1",
				draft: { text: "", images: [], files: [] },
			},
		)

		expect(result.effects.map((effect) => effect.type)).toEqual([
			"POST_TASK_VIEW",
			"PREPARE_RESUME",
			"START_API",
			"PERSIST_SNAPSHOT",
		])
	})

	it("abandons an unfinished pre-resume turn before starting a new API turn", () => {
		const state = {
			...stateAt(TaskPhase.PAUSED),
			anchor: { apiIndex: 1, turnId: "resume-turn", interactionId: "resume-1" },
			interaction: {
				taskId: "task-1",
				turnId: "resume-turn",
				interactionId: "resume-1",
				kind: "resume" as const,
				status: "resolving" as const,
				createdRevision: 1,
				anchor: { messageTs: 100, messageType: "ask" as const },
			},
			turn: {
				turnId: "stale-turn",
				assistantApiIndex: 2,
				mode: "serial" as const,
				activeDlineTid: "stale-tid",
				blocks: [
					{
						dlineTid: "stale-tid",
						functionId: "stale-call",
						toolName: "execute_command",
						phase: BlockPhase.EXECUTING,
						ts: 90,
						requiresApproval: false,
						conversationHistoryIndex: 2,
					},
				],
			},
		}

		const result = reduceTask(state, {
			type: "TASK_RESUME_REQUESTED",
			interactionId: "resume-1",
			draft: { text: "Continue", images: [], files: [] },
		})

		expect(result).toMatchObject({
			accepted: true,
			next: {
				phase: TaskPhase.RESUMING,
				turn: { activeDlineTid: undefined, blocks: [{ phase: BlockPhase.CANCELLED }] },
			},
		})
	})

	it("records normal completion", () => {
		const result = reduceTask(stateAt(TaskPhase.STREAMING), {
			type: "TASK_COMPLETED",
			completionId: "completion-1",
		})

		expect(result).toMatchObject({
			accepted: true,
			next: { phase: TaskPhase.COMPLETED, completion: { completionId: "completion-1" } },
		})
	})

	it("turns effect failures into explicit recovery state", () => {
		const result = reduceTask(stateAt(TaskPhase.STREAMING), {
			type: "EFFECT_FAILED",
			effectId: "effect-1",
			effectType: "START_API",
			originRevision: 0,
			message: "provider unavailable",
		})

		expect(result).toMatchObject({
			accepted: true,
			next: {
				phase: TaskPhase.PAUSED,
				interaction: {
					kind: "resume",
					status: "opening",
				},
				error: { effectId: "effect-1", effectType: "START_API", message: "provider unavailable" },
			},
		})
		expect(result.effects.map((effect) => effect.type)).toEqual(["PERSIST_SNAPSHOT", "APPEND_ASK"])
	})

	it("persists an opening Resume without retrying a failed ask presentation", () => {
		const state = {
			...stateAt(TaskPhase.STREAMING),
			interaction: {
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "question-1",
				kind: "qna_response" as const,
				status: "opening" as const,
				createdRevision: 1,
			},
		}

		const result = reduceTask(state, {
			type: "EFFECT_FAILED",
			effectId: "effect-ask",
			effectType: "APPEND_ASK",
			originRevision: 1,
			message: "ask persistence failed",
		})

		expect(result).toMatchObject({
			accepted: true,
			next: { phase: TaskPhase.PAUSED, interaction: { kind: "resume", status: "opening" } },
		})
		expect(result.effects.map((effect) => effect.type)).toEqual(["PERSIST_SNAPSHOT", "POST_TASK_VIEW"])
	})

	it("keeps an anchored approval actionable when only snapshot persistence fails", () => {
		const state = awaitingInteraction()
		const result = reduceTask(state, {
			type: "EFFECT_FAILED",
			effectId: "effect-snapshot",
			effectType: "PERSIST_SNAPSHOT",
			originRevision: state.revision,
			message: "snapshot unavailable",
		})

		expect(result).toMatchObject({
			accepted: true,
			next: {
				phase: TaskPhase.AWAITING_APPROVAL,
				interaction: { kind: "tool_approval", status: "awaiting", anchor: { messageType: "ask" } },
			},
		})
		expect(result.effects.map((effect) => effect.type)).toEqual(["POST_TASK_VIEW"])
	})

	it("does not let an older terminated effect replace a newer awaiting error retry", () => {
		const state = {
			...stateAt(TaskPhase.AWAITING_APPROVAL),
			revision: 12,
			interaction: {
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "retry-1",
				kind: "error_retry" as const,
				status: "awaiting" as const,
				createdRevision: 11,
				persistedRequest: false,
				anchor: { messageTs: 123, messageType: "ask" as const },
			},
		}
		const result = reduceTask(state, {
			type: "EFFECT_FAILED",
			effectId: "effect-api",
			effectType: "START_API",
			originRevision: 10,
			message: "task_terminated",
		})

		expect(result).toMatchObject({
			accepted: true,
			next: {
				phase: TaskPhase.AWAITING_APPROVAL,
				interaction: {
					interactionId: "retry-1",
					kind: "error_retry",
					status: "awaiting",
					persistedRequest: false,
				},
			},
		})
		expect(result.effects.map((effect) => effect.type)).toEqual(["PERSIST_SNAPSHOT", "POST_TASK_VIEW"])
	})

	it.each([
		{
			kind: "resume" as const,
			actionId: "resume" as const,
			phase: TaskPhase.RESUMING,
			failedPhase: TaskPhase.PAUSED,
		},
		{
			kind: "error_retry" as const,
			actionId: "retry" as const,
			phase: TaskPhase.STREAMING,
			failedPhase: TaskPhase.AWAITING_APPROVAL,
		},
		{
			kind: "mistake_limit" as const,
			actionId: "process_anyway" as const,
			phase: TaskPhase.STREAMING,
			failedPhase: TaskPhase.AWAITING_APPROVAL,
		},
	])("reopens $kind after its admitted START_API effect fails", ({ kind, actionId, phase, failedPhase }) => {
		const draft = { text: "keep this draft", images: ["image"], files: ["file"] }
		const state = {
			...stateAt(phase),
			revision: 6,
			interaction: {
				taskId: "task-1",
				turnId: "continuation-turn",
				interactionId: "continuation-1",
				kind,
				status: "resolving" as const,
				createdRevision: 4,
				anchor: { messageTs: 100, messageType: "ask" as const },
				acceptedResponse: {
					taskId: "task-1",
					turnId: "continuation-turn",
					interactionId: "continuation-1",
					actionId,
					stateRevision: 5,
					draft,
				},
			},
		}

		const result = reduceTask(state, {
			type: "EFFECT_FAILED",
			effectId: "effect-1",
			effectType: "START_API",
			originRevision: 6,
			message: "provider unavailable",
		})

		expect(result).toMatchObject({
			accepted: true,
			next: {
				phase: failedPhase,
				interaction: {
					kind,
					status: "awaiting",
					createdRevision: 7,
					acceptedResponse: { actionId, draft },
				},
				error: { effectType: "START_API", message: "provider unavailable" },
			},
		})
	})

	it("rejects an invalid event without mutation or effects", () => {
		const state = stateAt(TaskPhase.IDLE)
		const result = reduceTask(state, { type: "TASK_CANCEL_REQUESTED", source: "user" })

		expect(result).toEqual({
			accepted: false,
			next: state,
			effects: [],
			error: {
				code: "invalid_runtime_event",
				eventType: "TASK_CANCEL_REQUESTED",
				phase: TaskPhase.IDLE,
			},
		})
	})
})

// ── BLOCK_EXECUTION_COMPLETED — conversational tool path ──

describe("BLOCK_EXECUTION_COMPLETED — conversational tool lifecycle", () => {
	/** Create state with one turn and block in the given phase. */
	function stateWithBlock(blockPhase: BlockPhase, requiresApproval = false) {
		return {
			...createTaskRuntimeState({
				taskId: "task-1",
				phase: TaskPhase.EXECUTING,
				revision: 4,
				anchor: { apiIndex: 0, turnId: "turn-1" },
			}),
			turn: {
				turnId: "turn-1",
				assistantApiIndex: 2,
				mode: "serial" as const,
				activeDlineTid: blockPhase === BlockPhase.AWAITING_APPROVAL ? "tid-1" : undefined,
				blocks: [
					{
						dlineTid: "tid-1",
						functionId: "call-1",
						toolName: "qna_respond",
						phase: blockPhase,
						ts: 100,
						requiresApproval,
						conversationHistoryIndex: 2,
					},
				],
			},
		}
	}

	it("RED: BLOCK_EXECUTION_COMPLETED is rejected when block is AWAITING_APPROVAL (current bug symptom)", () => {
		const state = stateWithBlock(BlockPhase.AWAITING_APPROVAL, true)
		const result = reduceTask(state, {
			type: "BLOCK_EXECUTION_COMPLETED",
			turnId: "turn-1",
			dlineTid: "tid-1",
		})

		// This is the CORRECT behavior — reducer SHOULD reject completion for AWAITING_APPROVAL.
		// The bug is in the caller (index.ts) dispatching COMPLETED when block is AWAITING_APPROVAL.
		// This test documents the contract that callers must respect.
		expect(result).toMatchObject({ accepted: false })
		expect(result.error?.code).toBe("invalid_runtime_event")
	})

	it("BLOCK_EXECUTION_COMPLETED is accepted when block is AUTO_EXECUTING (expected path after fix)", () => {
		// After the fix, conversational tools will be auto-approved → AUTO_EXECUTING phase.
		// BLOCK_EXECUTION_COMPLETED should be accepted in this state.
		const state = stateWithBlock(BlockPhase.AUTO_EXECUTING, false)
		const result = reduceTask(state, {
			type: "BLOCK_EXECUTION_COMPLETED",
			turnId: "turn-1",
			dlineTid: "tid-1",
		})

		expect(result).toMatchObject({ accepted: true })
		expect(result.next.turn?.blocks[0]?.phase).toBe(BlockPhase.COMPLETED)
	})

	it("clears the approval owner when an approved block completes", () => {
		const state = stateWithBlock(BlockPhase.EXECUTING, true)
		state.turn.activeDlineTid = "tid-1"

		const result = reduceTask(state, {
			type: "BLOCK_EXECUTION_COMPLETED",
			turnId: "turn-1",
			dlineTid: "tid-1",
		})

		expect(result).toMatchObject({ accepted: true })
		expect(result.next.turn).toMatchObject({
			activeDlineTid: undefined,
			blocks: [{ dlineTid: "tid-1", phase: BlockPhase.COMPLETED }],
		})
	})

	it("preserves another block's approval owner when an automatic block completes", () => {
		const state = stateWithBlock(BlockPhase.AWAITING_APPROVAL, true)
		state.phase = TaskPhase.AWAITING_APPROVAL
		state.turn.activeDlineTid = "tid-1"
		state.turn.blocks.push({
			dlineTid: "tid-2",
			functionId: "fn-2",
			toolName: "read_file",
			phase: BlockPhase.AUTO_EXECUTING,
			ts: 2,
			requiresApproval: false,
			conversationHistoryIndex: 1,
		})

		const result = reduceTask(state, {
			type: "BLOCK_EXECUTION_COMPLETED",
			turnId: "turn-1",
			dlineTid: "tid-2",
		})

		expect(result).toMatchObject({ accepted: true })
		expect(result.next.turn).toMatchObject({
			activeDlineTid: "tid-1",
			blocks: [
				{ dlineTid: "tid-1", phase: BlockPhase.AWAITING_APPROVAL },
				{ dlineTid: "tid-2", phase: BlockPhase.COMPLETED },
			],
		})
	})
})

// ── Approval ownership separated from execution ownership ──

describe("turn approval and execution ownership", () => {
	/** Build a turn whose blocks are all still streaming. */
	function streamingTurn(
		blocks: Array<{ dlineTid: string; requiresApproval: boolean }>,
		phase: TaskPhase = TaskPhase.STREAMING,
	) {
		return {
			...createTaskRuntimeState({
				taskId: "task-1",
				phase,
				revision: 4,
				anchor: { apiIndex: 0, turnId: "turn-1" },
			}),
			turn: {
				turnId: "turn-1",
				assistantApiIndex: 2,
				mode: "serial" as const,
				activeDlineTid: undefined as string | undefined,
				blocks: blocks.map((block, index) => ({
					dlineTid: block.dlineTid,
					functionId: `call-${index + 1}`,
					toolName: block.requiresApproval ? "write_to_file" : "read_file",
					phase: BlockPhase.STREAMING,
					ts: index + 1,
					requiresApproval: block.requiresApproval,
					conversationHistoryIndex: index,
				})),
			},
		}
	}

	function requireLegacyBlock(state: ReturnType<typeof streamingTurn>, index: number) {
		const block = state.turn.blocks[index]
		if (!block) throw new Error(`Legacy test block is missing at index ${index}`)
		return block
	}

	it("rejects a second manual approval while one is already pending", () => {
		const state = streamingTurn([
			{ dlineTid: "tid-1", requiresApproval: true },
			{ dlineTid: "tid-2", requiresApproval: true },
		])

		const first = reduceTask(state, { type: "BLOCK_APPROVAL_REQUIRED", turnId: "turn-1", dlineTid: "tid-1" })
		expect(first).toMatchObject({ accepted: true })
		expect(first.next.turn?.approval?.manual).toEqual({ dlineTid: "tid-1", stage: "admission" })

		const second = reduceTask(first.next, { type: "BLOCK_APPROVAL_REQUIRED", turnId: "turn-1", dlineTid: "tid-2" })

		expect(second).toMatchObject({ accepted: false })
		expect(second.error?.code).toBe("invalid_runtime_event")
		expect(second.next.turn?.approval?.manual).toEqual({ dlineTid: "tid-1", stage: "admission" })
	})

	it("resolves several automatic approvals at once without touching the manual slot", () => {
		const state = streamingTurn([
			{ dlineTid: "tid-1", requiresApproval: false },
			{ dlineTid: "tid-2", requiresApproval: false },
			{ dlineTid: "tid-3", requiresApproval: false },
		])

		const admitted = ["tid-1", "tid-2", "tid-3"].reduce<TaskRuntimeState>((current, dlineTid) => {
			const result = reduceTask(current, { type: "BLOCK_READY", turnId: "turn-1", dlineTid })
			expect(result).toMatchObject({ accepted: true })
			return result.next
		}, state)

		expect(admitted.turn?.approval?.automatic).toEqual(["tid-1", "tid-2", "tid-3"])
		expect(admitted.turn?.executing).toEqual([])
		// No automatic approval may consume the single user-facing slot.
		expect(admitted.turn?.approval?.manual).toBeUndefined()
		expect(admitted.turn?.activeDlineTid).toBeUndefined()
	})

	it("returns an approved-but-unstarted automatic block to admission when its grant is revoked", () => {
		const state = streamingTurn([{ dlineTid: "tid-1", requiresApproval: false }])
		const admitted = reduceTask(state, { type: "BLOCK_READY", turnId: "turn-1", dlineTid: "tid-1" })

		expect(admitted.next.turn?.approval?.automatic).toEqual(["tid-1"])
		expect(admitted.next.turn?.executing).toEqual([])
		const revoked = reduceTask(admitted.next, {
			type: "BLOCK_ADMISSION_REVOKED",
			turnId: "turn-1",
			dlineTid: "tid-1",
		})

		expect(revoked).toMatchObject({ accepted: true, next: { phase: TaskPhase.STREAMING } })
		expect(revoked.next.turn?.blocks[0]?.phase).toBe(BlockPhase.STREAMING)
		expect(revoked.next.turn?.approval?.automatic).toEqual([])
		expect(revoked.next.turn?.executing).toEqual([])
	})

	it("does not revoke an automatic block after execution has started", () => {
		const state = streamingTurn([{ dlineTid: "tid-1", requiresApproval: false }])
		const admitted = reduceTask(state, { type: "BLOCK_READY", turnId: "turn-1", dlineTid: "tid-1" })
		const running = reduceTask(admitted.next, {
			type: "BLOCK_EXECUTION_STARTED",
			turnId: "turn-1",
			dlineTid: "tid-1",
		})

		const revoked = reduceTask(running.next, {
			type: "BLOCK_ADMISSION_REVOKED",
			turnId: "turn-1",
			dlineTid: "tid-1",
		})

		expect(revoked).toMatchObject({ accepted: false, error: { code: "invalid_runtime_event" } })
		expect(revoked.next.turn?.executing).toEqual(["tid-1"])
	})

	it("releases the approval slot when approval is granted, not when execution ends", () => {
		const state = streamingTurn([
			{ dlineTid: "tid-1", requiresApproval: true },
			{ dlineTid: "tid-2", requiresApproval: true },
		])

		const pending = reduceTask(state, { type: "BLOCK_APPROVAL_REQUIRED", turnId: "turn-1", dlineTid: "tid-1" })
		const approved = reduceTask(pending.next, { type: "BLOCK_APPROVED", turnId: "turn-1", dlineTid: "tid-1" })

		expect(approved).toMatchObject({ accepted: true })
		// Approval releases the slot but does not claim execution ownership.
		expect(approved.next.turn?.approval?.manual).toBeUndefined()
		expect(approved.next.turn?.executing).toEqual([])
		expect(approved.next.turn?.blocks[0]?.phase).toBe(BlockPhase.EXECUTING)

		// The approved block may still be queued, yet the next one can be presented.
		const next = reduceTask(approved.next, { type: "BLOCK_APPROVAL_REQUIRED", turnId: "turn-1", dlineTid: "tid-2" })

		expect(next).toMatchObject({ accepted: true })
		expect(next.next.turn?.approval?.manual).toEqual({ dlineTid: "tid-2", stage: "admission" })
		expect(next.next.turn?.executing).toEqual([])
	})

	it("does not let one block's execution rejection release another block's slot", () => {
		// With parallel execution the rejected block is usually not the slot
		// owner. Clearing the projection unconditionally would free a live
		// approval and let a second prompt claim it.
		const state = streamingTurn([
			{ dlineTid: "tid-1", requiresApproval: false },
			{ dlineTid: "tid-2", requiresApproval: true },
		])
		const admitted = reduceTask(state, { type: "BLOCK_READY", turnId: "turn-1", dlineTid: "tid-1" })
		const running = reduceTask(admitted.next, { type: "BLOCK_EXECUTION_STARTED", turnId: "turn-1", dlineTid: "tid-1" })
		const owned = reduceTask(running.next, { type: "BLOCK_APPROVAL_REQUIRED", turnId: "turn-1", dlineTid: "tid-2" })
		expect(owned.next.turn?.approval?.manual).toEqual({ dlineTid: "tid-2", stage: "admission" })

		const rejected = reduceTask(owned.next, { type: "BLOCK_EXECUTION_REJECTED", turnId: "turn-1", dlineTid: "tid-1" })

		expect(rejected).toMatchObject({ accepted: true })
		expect(rejected.next.turn?.approval?.manual).toEqual({ dlineTid: "tid-2", stage: "admission" })
		expect(rejected.next.turn?.activeDlineTid).toBe("tid-2")
	})

	it("keeps an approved block out of the automatic set", () => {
		const state = streamingTurn([{ dlineTid: "tid-1", requiresApproval: true }])
		const pending = reduceTask(state, { type: "BLOCK_APPROVAL_REQUIRED", turnId: "turn-1", dlineTid: "tid-1" })
		const approved = reduceTask(pending.next, { type: "BLOCK_APPROVED", turnId: "turn-1", dlineTid: "tid-1" })

		expect(approved.next.turn?.approval?.automatic).toEqual([])
	})

	it("restores execution ownership without scheduling a duplicate tool effect", () => {
		const state = streamingTurn([{ dlineTid: "tid-1", requiresApproval: true }])
		const pending = reduceTask(state, { type: "BLOCK_APPROVAL_REQUIRED", turnId: "turn-1", dlineTid: "tid-1" })
		const approved = reduceTask(pending.next, { type: "BLOCK_APPROVED", turnId: "turn-1", dlineTid: "tid-1" })
		const restored = reduceTask(approved.next, {
			type: "RESTORED_BLOCK_EXECUTION_STARTED",
			turnId: "turn-1",
			dlineTid: "tid-1",
		})

		expect(restored.accepted).toBe(true)
		expect(restored.next.turn?.executing).toEqual(["tid-1"])
		expect(restored.effects).not.toContainEqual(expect.objectContaining({ type: "EXECUTE_TOOL" }))
	})

	it("drops a block from both ownership sets when it completes", () => {
		const state = streamingTurn([{ dlineTid: "tid-1", requiresApproval: false }])
		const admitted = reduceTask(state, { type: "BLOCK_READY", turnId: "turn-1", dlineTid: "tid-1" })
		const running = reduceTask(admitted.next, { type: "BLOCK_EXECUTION_STARTED", turnId: "turn-1", dlineTid: "tid-1" })
		const done = reduceTask(running.next, { type: "BLOCK_EXECUTION_COMPLETED", turnId: "turn-1", dlineTid: "tid-1" })

		expect(done).toMatchObject({ accepted: true })
		expect(done.next.turn?.executing).toEqual([])
		expect(done.next.turn?.approval?.automatic).toEqual([])
	})

	it.each([
		["BLOCK_EXECUTION_CANCELLED" as const, BlockPhase.CANCELLED],
		["BLOCK_EXECUTION_SKIPPED" as const, BlockPhase.SKIPPED],
	])("commits %s as a terminal phase and clears approved-but-unstarted ownership", (type, phase) => {
		const state = streamingTurn([{ dlineTid: "tid-1", requiresApproval: false }])
		const admitted = reduceTask(state, { type: "BLOCK_READY", turnId: "turn-1", dlineTid: "tid-1" })
		const terminal = reduceTask(admitted.next, { type, turnId: "turn-1", dlineTid: "tid-1" })

		expect(terminal).toMatchObject({ accepted: true })
		expect(terminal.next.turn?.blocks[0]?.phase).toBe(phase)
		expect(terminal.next.turn?.executing).toEqual([])
		expect(terminal.next.turn?.approval?.automatic).toEqual([])
	})

	it("keeps activeDlineTid equal to the manual approval owner", () => {
		const state = streamingTurn([
			{ dlineTid: "tid-1", requiresApproval: true },
			{ dlineTid: "tid-2", requiresApproval: false },
		])

		const pending = reduceTask(state, { type: "BLOCK_APPROVAL_REQUIRED", turnId: "turn-1", dlineTid: "tid-1" })
		const withAutomatic = reduceTask(pending.next, { type: "BLOCK_READY", turnId: "turn-1", dlineTid: "tid-2" })

		expect(withAutomatic.next.turn?.activeDlineTid).toBe("tid-1")
		expect(withAutomatic.next.turn?.approval?.manual?.dlineTid).toBe("tid-1")
	})

	it("adopts a legacy turn that records execution only as a block phase", () => {
		// A snapshot written before ownership was explicit carries neither set.
		const legacy = streamingTurn([{ dlineTid: "tid-1", requiresApproval: false }], TaskPhase.EXECUTING)
		requireLegacyBlock(legacy, 0).phase = BlockPhase.AUTO_EXECUTING

		const result = reduceTask(legacy, { type: "BLOCK_EXECUTION_STARTED", turnId: "turn-1", dlineTid: "tid-1" })

		expect(result).toMatchObject({ accepted: true })
		expect(result.next.turn?.executing).toEqual(["tid-1"])
		expect(result.next.turn?.approval?.automatic).toEqual(["tid-1"])
	})

	it("does not record a legacy approval-requiring block as automatically approved", () => {
		// It was executing, so it had been approved — but by the user, not by
		// policy. Recording it as automatic would invent a permission.
		const legacy = streamingTurn([{ dlineTid: "tid-1", requiresApproval: true }], TaskPhase.EXECUTING)
		requireLegacyBlock(legacy, 0).phase = BlockPhase.EXECUTING

		const result = reduceTask(legacy, { type: "BLOCK_EXECUTION_STARTED", turnId: "turn-1", dlineTid: "tid-1" })

		expect(result).toMatchObject({ accepted: true })
		expect(result.next.turn?.executing).toEqual(["tid-1"])
		expect(result.next.turn?.approval?.automatic).toEqual([])
	})

	it("drops a legacy approval owner that points at a terminal block", () => {
		const legacy = streamingTurn([{ dlineTid: "tid-1", requiresApproval: true }], TaskPhase.EXECUTING)
		requireLegacyBlock(legacy, 0).phase = BlockPhase.COMPLETED
		legacy.turn.activeDlineTid = "tid-1"
		legacy.turn.blocks.push({
			dlineTid: "tid-2",
			functionId: "call-2",
			toolName: "read_file",
			phase: BlockPhase.AUTO_EXECUTING,
			ts: 9,
			requiresApproval: false,
			conversationHistoryIndex: 1,
		})

		const result = reduceTask(legacy, { type: "BLOCK_EXECUTION_STARTED", turnId: "turn-1", dlineTid: "tid-2" })

		expect(result).toMatchObject({ accepted: true })
		expect(result.next.turn?.activeDlineTid).toBeUndefined()
		expect(result.next.turn?.approval?.manual).toBeUndefined()
	})

	it("drops a legacy approval owner that names no block at all", () => {
		const legacy = streamingTurn([{ dlineTid: "tid-1", requiresApproval: false }], TaskPhase.EXECUTING)
		requireLegacyBlock(legacy, 0).phase = BlockPhase.AUTO_EXECUTING
		legacy.turn.activeDlineTid = "tid-missing"

		const result = reduceTask(legacy, { type: "BLOCK_EXECUTION_STARTED", turnId: "turn-1", dlineTid: "tid-1" })

		expect(result).toMatchObject({ accepted: true })
		expect(result.next.turn?.activeDlineTid).toBeUndefined()
	})

	it("carries several executing blocks through a legacy turn", () => {
		const legacy = streamingTurn(
			[
				{ dlineTid: "tid-1", requiresApproval: false },
				{ dlineTid: "tid-2", requiresApproval: false },
			],
			TaskPhase.EXECUTING,
		)
		requireLegacyBlock(legacy, 0).phase = BlockPhase.AUTO_EXECUTING
		requireLegacyBlock(legacy, 1).phase = BlockPhase.AUTO_EXECUTING

		const result = reduceTask(legacy, { type: "BLOCK_EXECUTION_STARTED", turnId: "turn-1", dlineTid: "tid-1" })

		expect(result).toMatchObject({ accepted: true })
		expect(result.next.turn?.executing).toEqual(["tid-1", "tid-2"])
	})
})

// ── Approval reachability is independent of sibling execution ──

describe("manual approval under concurrent automatic execution", () => {
	/**
	 * Reproduce the parallel turn a user actually approves in: one block needs
	 * no approval and is already running, which puts the task in EXECUTING,
	 * while a second block holds the single manual slot and waits for an answer.
	 */
	function parallelTurnAwaitingApproval(): TaskRuntimeState {
		const base = createTaskRuntimeState({
			taskId: "task-1",
			phase: TaskPhase.STREAMING,
			revision: 4,
			anchor: { apiIndex: 0, turnId: "turn-1" },
		})
		const turn = {
			turnId: "turn-1",
			assistantApiIndex: 2,
			mode: "parallel" as const,
			activeDlineTid: undefined as string | undefined,
			blocks: [
				{
					dlineTid: "auto-1",
					functionId: "call-1",
					toolName: "read_file",
					phase: BlockPhase.STREAMING,
					ts: 1,
					requiresApproval: false,
					conversationHistoryIndex: 0,
				},
				{
					dlineTid: "manual-1",
					functionId: "call-2",
					toolName: "write_to_file",
					phase: BlockPhase.STREAMING,
					ts: 2,
					requiresApproval: true,
					conversationHistoryIndex: 0,
				},
			],
		}

		// Drive the same event order the runtime produces, so the state under
		// test is reachable rather than hand-written.
		const ready = reduceTask({ ...base, turn }, { type: "BLOCK_READY", turnId: "turn-1", dlineTid: "auto-1" })
		expect(ready).toMatchObject({ accepted: true })
		const required = reduceTask(ready.next, { type: "BLOCK_APPROVAL_REQUIRED", turnId: "turn-1", dlineTid: "manual-1" })
		expect(required).toMatchObject({ accepted: true })
		const running = reduceTask(required.next, {
			type: "BLOCK_EXECUTION_STARTED",
			turnId: "turn-1",
			dlineTid: "auto-1",
		})
		expect(running).toMatchObject({ accepted: true, next: { phase: TaskPhase.EXECUTING } })

		const state = running.next
		return {
			...state,
			interaction: {
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "manual-1",
				kind: "tool_approval",
				status: "awaiting",
				createdRevision: state.revision,
				anchor: { messageTs: 200, messageType: "ask" },
			},
		}
	}

	/**
	 * Build the response a user click produces for the pending manual block.
	 *
	 * Both approval actions declare a `draft` payload policy, so the draft is
	 * part of a well-formed response even when the user typed nothing.
	 */
	function approvalResponse(state: TaskRuntimeState, actionId: "approve" | "reject") {
		return {
			type: "INTERACTION_RESPONDED" as const,
			response: {
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "manual-1",
				actionId,
				stateRevision: state.revision,
				draft: { text: "", images: [], files: [] },
			},
		}
	}

	it("accepts a manual approval while a sibling automatic block is executing", () => {
		const state = parallelTurnAwaitingApproval()
		expect(state.phase).toBe(TaskPhase.EXECUTING)
		expect(state.turn?.executing).toEqual(["auto-1"])
		expect(state.turn?.approval?.manual).toEqual({ dlineTid: "manual-1", stage: "admission" })

		const result = reduceTask(state, approvalResponse(state, "approve"))

		expect(result).toMatchObject({ accepted: true, next: { phase: TaskPhase.EXECUTING } })
		expect(result.next.interaction?.status).toBe("resolving")
	})

	it("releases the manual slot and starts the approved block without disturbing the running one", () => {
		const state = parallelTurnAwaitingApproval()

		const result = reduceTask(state, approvalResponse(state, "approve"))

		expect(result.accepted).toBe(true)
		// The slot is freed the moment permission is granted, so a later block
		// can be presented while this one runs.
		expect(result.next.turn?.approval?.manual).toBeUndefined()
		expect(result.next.turn?.activeDlineTid).toBeUndefined()
		expect(result.next.turn?.blocks.find((block) => block.dlineTid === "manual-1")?.phase).toBe(BlockPhase.EXECUTING)
		// Approval and execution are separate ownership boundaries: the block is
		// approved but not yet started, so it joins `executing` only when
		// BLOCK_EXECUTION_STARTED is accepted.
		expect(result.next.turn?.executing).toEqual(["auto-1"])
		const started = reduceTask(result.next, { type: "BLOCK_EXECUTION_STARTED", turnId: "turn-1", dlineTid: "manual-1" })
		expect(started).toMatchObject({ accepted: true })
		expect(started.next.turn?.executing).toEqual(["auto-1", "manual-1"])
		// The sibling that was already running is untouched throughout.
		expect(started.next.turn?.blocks.find((block) => block.dlineTid === "auto-1")?.phase).toBe(BlockPhase.AUTO_EXECUTING)
	})

	it("keeps the persisted draft effect order when an approval carries feedback", () => {
		const state = parallelTurnAwaitingApproval()
		const response = approvalResponse(state, "approve")

		const result = reduceTask(state, {
			...response,
			response: { ...response.response, draft: { text: "Approval note", images: [], files: [] } },
		})

		expect(result.accepted).toBe(true)
		expect(result.effects.map((effect) => effect.type)).toEqual(["APPEND_SAY", "POST_TASK_VIEW", "PERSIST_SNAPSHOT"])
		expect(result.effects[0]).toMatchObject({ type: "APPEND_SAY", interactionId: "manual-1", presentation: "Approval note" })
	})

	it("still rejects the block from the same state, leaving the running sibling alone", () => {
		const state = parallelTurnAwaitingApproval()

		const result = reduceTask(state, approvalResponse(state, "reject"))

		expect(result).toMatchObject({ accepted: true, next: { phase: TaskPhase.BETWEEN_TURNS } })
		expect(result.next.turn?.blocks.find((block) => block.dlineTid === "manual-1")?.phase).toBe(BlockPhase.REJECTED)
		expect(result.next.turn?.executing).toEqual(["auto-1"])
	})

	it("reaches the same committed state through BLOCK_APPROVED, proving one shared rule", () => {
		// Approval has two entry points that must agree: a user response and the
		// approver-facing event a future AI approver also resolves through. A
		// difference here is what let one of them be rejected while the other
		// succeeded from the identical state.
		const state = parallelTurnAwaitingApproval()

		const viaInteraction = reduceTask(state, approvalResponse(state, "approve"))
		const viaBlockEvent = reduceTask(state, { type: "BLOCK_APPROVED", turnId: "turn-1", dlineTid: "manual-1" })

		expect(viaInteraction.accepted).toBe(true)
		expect(viaBlockEvent.accepted).toBe(true)
		expect(viaInteraction.next.phase).toBe(viaBlockEvent.next.phase)
		expect(viaInteraction.next.turn?.executing).toEqual(viaBlockEvent.next.turn?.executing)
		expect(viaInteraction.next.turn?.approval).toEqual(viaBlockEvent.next.turn?.approval)
		expect(viaInteraction.next.turn?.blocks).toEqual(viaBlockEvent.next.turn?.blocks)
	})
})

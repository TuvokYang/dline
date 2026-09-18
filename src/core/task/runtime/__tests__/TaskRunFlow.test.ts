import { describe, expect, it, vi } from "vitest"
import { BlockPhase } from "../../BlockPhaseMachine"
import { TaskPhase } from "../../TaskPhase"
import type { TaskEffectPorts } from "../TaskEffectRunner"
import type { TaskEvent } from "../TaskEvent"
import { TaskRuntime } from "../TaskRuntime"
import { createTaskRuntimeState } from "../TaskRuntimeState"

/** Create observable effect ports for one runtime flow. */
function createPorts(sequence: string[]): TaskEffectPorts {
	return {
		postView: vi.fn(async () => undefined),
		persistSnapshot: vi.fn(async () => undefined),
		cancelRuntime: vi.fn(async () => undefined),
		prepareResume: vi.fn(async () => undefined),
		startApi: vi.fn(async (effect) => {
			sequence.push(`effect:${effect.type}:${effect.apiIndex}`)
		}),
		executeTool: vi.fn(async (effect) => {
			sequence.push(`effect:${effect.type}:${effect.dlineTid}`)
		}),
		appendSay: vi.fn(async () => undefined),
		appendAsk: vi.fn(async () => ({ uiMessageTs: 100 })),
		startNewTask: vi.fn(async () => undefined),
	}
}

/** Dispatch one event and require it to be accepted. */
async function dispatch(runtime: TaskRuntime, sequence: string[], event: TaskEvent): Promise<void> {
	const result = await runtime.dispatch(event)
	sequence.push(event.type)
	expect(result.accepted).toBe(true)
}

describe("TaskRuntime main flow", () => {
	it("drives one approved tool turn through events and ordered effects", async () => {
		const sequence: string[] = []
		const runtime = new TaskRuntime(createTaskRuntimeState({ taskId: "task-1" }), createPorts(sequence))

		await dispatch(runtime, sequence, { type: "TASK_INITIALIZE_REQUESTED" })
		await dispatch(runtime, sequence, {
			type: "TASK_INITIALIZED",
			anchor: { apiIndex: -1 },
			hasTask: true,
		})
		await dispatch(runtime, sequence, { type: "API_REQUEST_STARTED", apiIndex: 0 })
		await dispatch(runtime, sequence, {
			type: "TURN_CREATED",
			turnId: "turn-1",
			assistantApiIndex: 1,
			mode: "serial",
			blocks: [
				{
					dlineTid: "tid-write",
					functionId: "call-write",
					toolName: "write_to_file",
					ts: 10,
					requiresApproval: true,
					conversationHistoryIndex: 1,
				},
			],
		})
		await dispatch(runtime, sequence, { type: "BLOCK_READY", turnId: "turn-1", dlineTid: "tid-write" })
		await dispatch(runtime, sequence, { type: "BLOCK_APPROVAL_REQUIRED", turnId: "turn-1", dlineTid: "tid-write" })
		await dispatch(runtime, sequence, { type: "BLOCK_APPROVED", turnId: "turn-1", dlineTid: "tid-write" })
		await dispatch(runtime, sequence, { type: "BLOCK_EXECUTION_STARTED", turnId: "turn-1", dlineTid: "tid-write" })
		await dispatch(runtime, sequence, {
			type: "BLOCK_EXECUTION_COMPLETED",
			turnId: "turn-1",
			dlineTid: "tid-write",
		})
		await dispatch(runtime, sequence, { type: "TURN_COMPLETED", turnId: "turn-1" })

		expect(sequence).toContain("effect:EXECUTE_TOOL:tid-write")
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.BETWEEN_TURNS,
			turn: {
				turnId: "turn-1",
				blocks: [{ dlineTid: "tid-write", phase: BlockPhase.COMPLETED }],
			},
		})
	})

	it("commits approval interaction response before handler continuation", async () => {
		const sequence: string[] = []
		const runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({
					taskId: "task-1",
					phase: TaskPhase.AWAITING_APPROVAL,
					revision: 4,
					anchor: { apiIndex: 1, turnId: "turn-approval", interactionId: "tid-write" },
				}),
				turn: {
					turnId: "turn-approval",
					assistantApiIndex: 1,
					mode: "serial",
					activeDlineTid: "tid-write",
					blocks: [
						{
							dlineTid: "tid-write",
							functionId: "call-write",
							toolName: "write_to_file",
							phase: BlockPhase.AWAITING_APPROVAL,
							ts: 10,
							requiresApproval: true,
							conversationHistoryIndex: 1,
						},
					],
				},
				interaction: {
					taskId: "task-1",
					turnId: "turn-approval",
					interactionId: "tid-write",
					kind: "tool_approval",
					status: "awaiting",
					createdRevision: 3,
					anchor: { messageTs: 100, messageType: "ask" },
				},
			},
			createPorts(sequence),
		)

		await dispatch(runtime, sequence, {
			type: "INTERACTION_RESPONDED",
			response: {
				taskId: "task-1",
				turnId: "turn-approval",
				interactionId: "tid-write",
				actionId: "approve",
				stateRevision: 4,
				draft: { text: "", images: [], files: [] },
			},
		})

		// Granting permission releases the slot without claiming execution; the
		// pool owns the later BLOCK_EXECUTION_STARTED transition.
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.EXECUTING,
			turn: { activeDlineTid: undefined, executing: [], blocks: [{ phase: BlockPhase.EXECUTING }] },
			interaction: { status: "resolving" },
		})
	})

	it("serializes approval and cascades rejection without executing later approval blocks", async () => {
		const sequence: string[] = []
		const runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING, anchor: { apiIndex: 0 } }),
			createPorts(sequence),
		)

		await dispatch(runtime, sequence, {
			type: "TURN_CREATED",
			turnId: "turn-2",
			assistantApiIndex: 1,
			mode: "serial",
			blocks: [
				{
					dlineTid: "tid-first",
					functionId: "call-first",
					toolName: "write_to_file",
					ts: 20,
					requiresApproval: true,
					conversationHistoryIndex: 1,
				},
				{
					dlineTid: "tid-second",
					functionId: "call-second",
					toolName: "apply_patch",
					ts: 21,
					requiresApproval: true,
					conversationHistoryIndex: 1,
				},
				{
					dlineTid: "tid-read",
					functionId: "call-read",
					toolName: "read_file",
					ts: 22,
					requiresApproval: false,
					conversationHistoryIndex: 1,
				},
			],
		})
		await dispatch(runtime, sequence, { type: "BLOCK_READY", turnId: "turn-2", dlineTid: "tid-first" })
		await dispatch(runtime, sequence, { type: "BLOCK_APPROVAL_REQUIRED", turnId: "turn-2", dlineTid: "tid-first" })

		const waiting = await runtime.dispatch({ type: "BLOCK_READY", turnId: "turn-2", dlineTid: "tid-second" })
		expect(waiting.accepted).toBe(true)
		expect(runtime.getState().turn?.blocks[1]?.phase).toBe(BlockPhase.STREAMING)

		await dispatch(runtime, sequence, { type: "BLOCK_REJECTED", turnId: "turn-2", dlineTid: "tid-first" })
		await dispatch(runtime, sequence, { type: "TURN_COMPLETED", turnId: "turn-2" })

		expect(runtime.getState().turn?.blocks.map((block) => block.phase)).toEqual([
			BlockPhase.REJECTED,
			BlockPhase.SKIPPED,
			BlockPhase.SKIPPED,
		])
		expect(sequence).not.toContain("effect:EXECUTE_TOOL:tid-second")
		expect(sequence).not.toContain("effect:EXECUTE_TOOL:tid-read")
	})
})

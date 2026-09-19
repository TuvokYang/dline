import { describe, expect, it } from "vitest"
import { type BlockLifecycle, BlockPhase } from "../../../BlockPhaseMachine"
import { createInitialTaskState, type KernelBlock, type TaskState } from "../../../kernel"
import { ALL_HALT_PARTICIPANTS } from "../../../kernel/machines/halt"
import { InMemoryCommandPublicationStore, InMemoryStateVault, InMemoryTaskViewPort } from "../../../stores"
import { TaskPhase } from "../../../TaskPhase"
import { reduceTask } from "../../TaskReducer"
import { createTaskRuntimeState, type TaskRuntimeState } from "../../TaskRuntimeState"
import { TaskRuntimeV2 } from "../TaskRuntimeV2"
import { RecordingExecutor } from "./support"

function legacyBlock(): BlockLifecycle {
	return {
		dlineTid: "b1",
		functionId: "call-b1",
		toolName: "read_file",
		phase: BlockPhase.STREAMING,
		ts: 1,
		requiresApproval: false,
		conversationHistoryIndex: 0,
	}
}

function kernelBlock(): KernelBlock {
	return {
		blockId: "b1",
		index: 0,
		phase: "pending",
		attempt: "attempt-b1-1",
		lanes: [],
		turnEnding: false,
		policy: {
			commandId: "policy:b1",
			originRevision: 0,
			status: "running",
			interactionId: "policy:b1",
			policyRevision: 1,
		},
	}
}

function legacyTurn(): TaskRuntimeState {
	return {
		...createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING, anchor: { apiIndex: 0, turnId: "turn-1" } }),
		turn: {
			turnId: "turn-1",
			assistantApiIndex: 1,
			mode: "serial",
			blocks: [legacyBlock()],
			approval: { automatic: [] },
			executing: [],
		},
	}
}

function kernelTurn(): TaskState {
	return {
		...createInitialTaskState("task-1"),
		flow: { phase: "running" },
		turn: {
			turnId: "turn-1",
			mode: "serial",
			blocks: [kernelBlock()],
			manualApprovalBlockIds: [],
			automaticApprovalBlockIds: [],
			executingBlockIds: [],
		},
	}
}

function runtime(initialState: TaskState, executors: RecordingExecutor[]) {
	return new TaskRuntimeV2({
		initialState,
		vault: new InMemoryStateVault(),
		taskView: new InMemoryTaskViewPort(),
		publications: new InMemoryCommandPublicationStore(),
		executors,
	})
}

describe("TaskRuntimeV2 legacy replay", () => {
	it("matches legacy cancellation checkpoints while routing one halt command", async () => {
		const legacyStopping = reduceTask(createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING }), {
			type: "TASK_CANCEL_REQUESTED",
			source: "user",
		})
		const legacyPaused = reduceTask(legacyStopping.next, { type: "TASK_CANCELLED" })
		const halt = new RecordingExecutor("halt")
		const subject = runtime({ ...createInitialTaskState("task-1"), flow: { phase: "running" } }, [halt])
		await subject.submit({ type: "user.cancel", generation: 0, haltId: "halt-1" })
		expect(subject.getState().halt.status).toBe("stopping")
		expect(legacyStopping.next.phase).toBe(TaskPhase.CANCELLING)
		for (const participantId of ALL_HALT_PARTICIPANTS)
			await subject.submit({
				type: "halt.halted",
				generation: subject.getState().generation,
				haltId: "halt-1",
				participantId,
			})
		await subject.waitForQuiescence()
		expect(subject.getState().flow.phase).toBe("paused")
		expect(legacyPaused.next.phase).toBe(TaskPhase.PAUSED)
		expect(halt.commands).toHaveLength(1)
		expect(legacyStopping.effects.filter((effect) => effect.type === "CANCEL_RUNTIME")).toHaveLength(1)
	})

	it("matches legacy automatic tool ownership and terminal cleanup", async () => {
		const legacyReady = reduceTask(legacyTurn(), { type: "BLOCK_READY", turnId: "turn-1", dlineTid: "b1" })
		const legacyStarted = reduceTask(legacyReady.next, { type: "BLOCK_EXECUTION_STARTED", turnId: "turn-1", dlineTid: "b1" })
		const legacyCompleted = reduceTask(legacyStarted.next, {
			type: "BLOCK_EXECUTION_COMPLETED",
			turnId: "turn-1",
			dlineTid: "b1",
		})
		const tool = new RecordingExecutor("tool")
		const subject = runtime(kernelTurn(), [tool])
		await subject.submit({
			type: "approval.evaluated",
			generation: 0,
			commandId: "policy:b1",
			originRevision: 0,
			attempt: "attempt-b1-1",
			interactionId: "policy:b1",
			policyRevision: 1,
			blockId: "b1",
			approved: true,
		})
		await subject.submit({ type: "tool.started", generation: 0, attempt: "attempt-b1-1", turnId: "turn-1", blockId: "b1" })
		await subject.submit({ type: "tool.completed", generation: 0, attempt: "attempt-b1-1", turnId: "turn-1", blockId: "b1" })
		await subject.waitForQuiescence()

		expect(subject.getState().turn.blocks[0].phase).toBe("completed")
		expect(subject.getState().turn.automaticApprovalBlockIds).toEqual([])
		expect(subject.getState().turn.executingBlockIds).toEqual([])
		expect(legacyCompleted.next.turn?.blocks[0].phase).toBe(BlockPhase.COMPLETED)
		expect(legacyCompleted.next.turn?.approval?.automatic ?? []).toEqual([])
		expect(legacyCompleted.next.turn?.executing ?? []).toEqual([])
		expect(tool.commands).toHaveLength(1)
		expect(legacyStarted.effects.filter((effect) => effect.type === "EXECUTE_TOOL")).toHaveLength(1)
	})
})

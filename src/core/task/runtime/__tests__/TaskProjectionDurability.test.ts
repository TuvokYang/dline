import { describe, expect, it, vi } from "vitest"
import { BlockPhase } from "../../BlockPhaseMachine"
import { TaskPhase } from "../../TaskPhase"
import type { PersistSnapshotEffect, PostTaskViewEffect, SnapshotDurability, TaskEffect } from "../TaskEffect"
import type { TaskEffectPorts } from "../TaskEffectRunner"
import { TaskEffectRunner } from "../TaskEffectRunner"
import type { TaskEvent } from "../TaskEvent"
import { reduceTask } from "../TaskReducer"
import { TaskRuntime } from "../TaskRuntime"
import { createTaskRuntimeState, type TaskRuntimeState } from "../TaskRuntimeState"

/** One block declaration for a turn under test. */
function blockAt(index: number) {
	return {
		dlineTid: `tid-${index}`,
		functionId: `call-${index}`,
		toolName: "read_file",
		ts: 10 + index,
		requiresApproval: false,
		conversationHistoryIndex: 1,
	}
}

/** Resolve the durability the effect runner would apply. */
function durabilityOf(effect: TaskEffect): SnapshotDurability | undefined {
	if (effect.type !== "POST_TASK_VIEW" && effect.type !== "PERSIST_SNAPSHOT") return undefined
	return (effect as PostTaskViewEffect | PersistSnapshotEffect).durability ?? "flushed"
}

/** Collect the durability of each projection effect a transition emits. */
function projectionDurabilities(effects: readonly TaskEffect[]): SnapshotDurability[] {
	return effects.map(durabilityOf).filter((value): value is SnapshotDurability => value !== undefined)
}

/** A runtime state that is guaranteed to carry a turn. */
type TurnState = TaskRuntimeState & { turn: NonNullable<TaskRuntimeState["turn"]> }

/** Advance a state to an executing turn whose blocks are ready to start. */
function executingTurnState(blockCount: number): TurnState {
	return {
		...createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.EXECUTING, revision: 5 }),
		turn: {
			turnId: "turn-1",
			assistantApiIndex: 1,
			mode: "parallel",
			blocks: Array.from({ length: blockCount }, (_, index) => ({
				...blockAt(index),
				phase: BlockPhase.AUTO_EXECUTING,
			})),
			activeDlineTid: undefined,
			approval: { automatic: Array.from({ length: blockCount }, (_, index) => `tid-${index}`) },
			executing: [],
		},
	} as unknown as TurnState
}

describe("snapshot durability is decided by the reducer", () => {
	it("marks a block start as coalesced so admission does not await a durable write", () => {
		const state = executingTurnState(1)

		const result = reduceTask(state, {
			type: "BLOCK_EXECUTION_STARTED",
			turnId: "turn-1",
			dlineTid: "tid-0",
		})

		expect(result.accepted).toBe(true)
		expect(projectionDurabilities(result.effects)).toEqual(["scheduled", "scheduled"])
		expect(result.effects.map((effect) => effect.type)).toEqual(["POST_TASK_VIEW", "PERSIST_SNAPSHOT", "EXECUTE_TOOL"])
	})

	it("keeps every block start coalesced across a parallel turn", () => {
		let state: TaskRuntimeState = executingTurnState(8)

		for (let index = 0; index < 8; index++) {
			const result = reduceTask(state, {
				type: "BLOCK_EXECUTION_STARTED",
				turnId: "turn-1",
				dlineTid: `tid-${index}`,
			})
			expect(result.accepted).toBe(true)
			expect(projectionDurabilities(result.effects)).toEqual(["scheduled", "scheduled"])
			state = result.next
		}
	})

	it.each<[string, TaskEvent]>([
		["approval presentation", { type: "BLOCK_APPROVAL_REQUIRED", turnId: "turn-1", dlineTid: "tid-0" }],
		["block completion", { type: "BLOCK_EXECUTION_COMPLETED", turnId: "turn-1", dlineTid: "tid-0" }],
		["block cancellation", { type: "BLOCK_EXECUTION_CANCELLED", turnId: "turn-1", dlineTid: "tid-0" }],
		["turn-ending sibling suppression", { type: "BLOCK_EXECUTION_SKIPPED", turnId: "turn-1", dlineTid: "tid-0" }],
	])("keeps %s durable", (_label, event) => {
		const base = executingTurnState(1)
		const state =
			event.type === "BLOCK_APPROVAL_REQUIRED"
				? ({
						...base,
						phase: TaskPhase.STREAMING,
						turn: {
							...base.turn,
							blocks: [{ ...blockAt(0), phase: BlockPhase.STREAMING, requiresApproval: true }],
						},
					} as TaskRuntimeState)
				: ({ ...base, turn: { ...base.turn, executing: ["tid-0"] } } as TaskRuntimeState)

		const result = reduceTask(state, event)

		expect(result.accepted).toBe(true)
		const durabilities = projectionDurabilities(result.effects)
		expect(durabilities.length).toBeGreaterThan(0)
		expect(durabilities.every((value) => value === "flushed")).toBe(true)
	})

	it("keeps turn completion durable so a crash cannot lose the closed turn", () => {
		const base = executingTurnState(1)
		const state = {
			...base,
			turn: { ...base.turn, blocks: [{ ...blockAt(0), phase: BlockPhase.COMPLETED }] },
		} as TaskRuntimeState

		const result = reduceTask(state, { type: "TURN_COMPLETED", turnId: "turn-1" })

		expect(result.accepted).toBe(true)
		expect(projectionDurabilities(result.effects).every((value) => value === "flushed")).toBe(true)
	})

	it("keeps cancellation durable", () => {
		const result = reduceTask(createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING }), {
			type: "TASK_CANCEL_REQUESTED",
			source: "user",
		})

		expect(result.accepted).toBe(true)
		expect(projectionDurabilities(result.effects).every((value) => value === "flushed")).toBe(true)
	})

	it("keeps task completion durable", () => {
		const result = reduceTask(createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.BETWEEN_TURNS }), {
			type: "TASK_COMPLETED",
			completionId: "completion-1",
		})

		expect(result.accepted).toBe(true)
		expect(projectionDurabilities(result.effects).every((value) => value === "flushed")).toBe(true)
	})
})

describe("the effect runner honours the reducer's durability", () => {
	function createPorts(): TaskEffectPorts & {
		postView: ReturnType<typeof vi.fn>
		persistSnapshot: ReturnType<typeof vi.fn>
	} {
		return {
			postView: vi.fn(async () => undefined),
			persistSnapshot: vi.fn(async () => undefined),
			cancelRuntime: vi.fn(async () => undefined),
			prepareResume: vi.fn(async () => undefined),
			startApi: vi.fn(async () => undefined),
			executeTool: vi.fn(async () => undefined),
			appendSay: vi.fn(async () => undefined),
			appendAsk: vi.fn(async () => ({ uiMessageTs: 100 })),
			startNewTask: vi.fn(async () => undefined),
		} as never
	}

	it("passes the coalesced durability through to both projection ports", async () => {
		const ports = createPorts()
		const state = createTaskRuntimeState({ taskId: "task-1" })

		await new TaskEffectRunner(ports).run(
			[
				{ id: "e1", type: "POST_TASK_VIEW", durability: "scheduled" },
				{ id: "e2", type: "PERSIST_SNAPSHOT", durability: "scheduled" },
			],
			state,
		)

		// The origin travels with the effect so deferred work stays attributable.
		expect(ports.postView).toHaveBeenCalledWith(state, "scheduled", { effectId: "e1", originRevision: state.revision })
		expect(ports.persistSnapshot).toHaveBeenCalledWith(state, "scheduled", {
			effectId: "e2",
			originRevision: state.revision,
		})
	})

	it("treats an unclassified projection effect as durable", async () => {
		const ports = createPorts()
		const state = createTaskRuntimeState({ taskId: "task-1" })

		await new TaskEffectRunner(ports).run(
			[
				{ id: "e1", type: "POST_TASK_VIEW" },
				{ id: "e2", type: "PERSIST_SNAPSHOT" },
			],
			state,
		)

		expect(ports.postView).toHaveBeenCalledWith(state, "flushed", { effectId: "e1", originRevision: state.revision })
		expect(ports.persistSnapshot).toHaveBeenCalledWith(state, "flushed", {
			effectId: "e2",
			originRevision: state.revision,
		})
	})

	it("still reaches the tool after a coalesced block start", async () => {
		const ports = createPorts()
		const runtime = new TaskRuntime(executingTurnState(1), ports)

		const result = await runtime.dispatch({
			type: "BLOCK_EXECUTION_STARTED",
			turnId: "turn-1",
			dlineTid: "tid-0",
		})

		expect(result.accepted).toBe(true)
		expect(ports.persistSnapshot).toHaveBeenCalledWith(
			expect.anything(),
			"scheduled",
			expect.objectContaining({ originRevision: expect.any(Number) }),
		)
		expect(ports.executeTool).toHaveBeenCalledWith(expect.objectContaining({ dlineTid: "tid-0" }))
	})
})

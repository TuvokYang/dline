import { describe, expect, it } from "vitest"
import { type BlockLifecycle, BlockPhase } from "../../BlockPhaseMachine"
import { reduceTask } from "../../runtime/TaskReducer"
import { createTaskRuntimeState, type TaskRuntimeState } from "../../runtime/TaskRuntimeState"
import { TaskPhase } from "../../TaskPhase"
import { type Command, createInitialTaskState, type KernelBlock, type TaskEvent, type TaskState, transition } from ".."
import { ALL_HALT_PARTICIPANTS } from "../machines/halt"

type LegacyEvent = Parameters<typeof reduceTask>[1]

function legacyBlock(blockId: string, index: number, requiresApproval: boolean): BlockLifecycle {
	return {
		dlineTid: blockId,
		functionId: `call-${blockId}`,
		toolName: requiresApproval ? "write_to_file" : "read_file",
		phase: BlockPhase.STREAMING,
		ts: 100 + index,
		requiresApproval,
		conversationHistoryIndex: index,
	}
}

function kernelBlock(blockId: string, index: number): KernelBlock {
	return { blockId, index, phase: "pending", attempt: `attempt-${blockId}-1`, lanes: ["tool"], turnEnding: false }
}

function legacyTurnState(blocks: BlockLifecycle[]): TaskRuntimeState {
	return {
		...createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING, anchor: { apiIndex: 0, turnId: "turn-1" } }),
		turn: { turnId: "turn-1", assistantApiIndex: 1, mode: "serial", blocks, approval: { automatic: [] }, executing: [] },
	}
}

function kernelTurnState(blocks: KernelBlock[]): TaskState {
	return {
		...createInitialTaskState("task-1"),
		flow: { phase: "running" },
		turn: {
			turnId: "turn-1",
			mode: "serial",
			blocks,
			manualApprovalBlockIds: [],
			automaticApprovalBlockIds: [],
			executingBlockIds: [],
		},
	}
}

function runLegacy(initial: TaskRuntimeState, events: readonly LegacyEvent[]) {
	let state = initial
	const states = [state]
	const effects = [] as ReturnType<typeof reduceTask>["effects"][number][]
	for (const event of events) {
		const result = reduceTask(state, event)
		expect(result.accepted, event.type).toBe(true)
		state = result.next
		states.push(state)
		effects.push(...result.effects)
	}
	return { states, effects }
}

function runKernel(initial: TaskState, events: readonly TaskEvent[]) {
	let state = initial
	const states = [state]
	const commands: Command[] = []
	for (const event of events) {
		const result = transition(state, event)
		expect(result.kind, event.type).toBe("accepted")
		if (result.kind !== "accepted") throw new Error(result.diagnostic.message)
		state = result.state
		states.push(state)
		commands.push(...result.commands)
	}
	return { states, commands }
}

function legacyLifecycle(state: TaskRuntimeState): string {
	if (state.phase === TaskPhase.CANCELLING) return "stopping"
	if (state.phase === TaskPhase.PAUSED) return "paused"
	if (state.phase === TaskPhase.BETWEEN_TURNS || state.phase === TaskPhase.WAITING_FOR_TASK) return "waiting"
	return "running"
}

function projectLegacyTurn(state: TaskRuntimeState) {
	const turn = state.turn
	if (!turn) return undefined
	const executing = new Set(turn.executing ?? [])
	return {
		blocks: turn.blocks.map((block) => ({ blockId: block.dlineTid, phase: projectLegacyBlock(block, executing) })),
		manual: turn.approval?.manual?.dlineTid ?? turn.activeDlineTid,
		automatic: [...(turn.approval?.automatic ?? [])].sort(),
		executing: [...executing].sort(),
	}
}

function projectLegacyBlock(block: BlockLifecycle, executing: ReadonlySet<string>): string {
	switch (block.phase) {
		case BlockPhase.STREAMING:
			return "pending"
		case BlockPhase.AWAITING_APPROVAL:
			return "awaiting_approval"
		case BlockPhase.AUTO_EXECUTING:
		case BlockPhase.EXECUTING:
			return executing.has(block.dlineTid) ? "executing" : "ready"
		default:
			return block.phase
	}
}

function projectKernelTurn(state: TaskState) {
	return {
		blocks: state.turn.blocks.map((block) => ({ blockId: block.blockId, phase: block.phase })),
		manual: state.turn.manualApprovalBlockIds[0],
		automatic: [...state.turn.automaticApprovalBlockIds].sort(),
		executing: [...state.turn.executingBlockIds].sort(),
	}
}

describe("task kernel legacy replay", () => {
	it("matches legacy cancellation checkpoints and stop command", () => {
		const legacy = runLegacy(createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING }), [
			{ type: "TASK_CANCEL_REQUESTED", source: "user" },
			{ type: "TASK_CANCELLED" },
		])
		const kernelEvents: TaskEvent[] = [
			{ type: "user.cancel", generation: 0, haltId: "halt-1" },
			...ALL_HALT_PARTICIPANTS.map((participantId) => ({
				type: "halt.halted" as const,
				generation: 1,
				haltId: "halt-1",
				participantId,
			})),
		]
		const kernel = runKernel({ ...createInitialTaskState("task-1"), flow: { phase: "running" } }, kernelEvents)

		expect(legacyLifecycle(legacy.states[1])).toBe("stopping")
		expect(kernel.states[1].halt.status).toBe("stopping")
		expect(legacyLifecycle(legacy.states[2])).toBe("paused")
		expect(kernel.states.at(-1)?.flow.phase).toBe("paused")
		expect(legacy.effects.filter((effect) => effect.type === "CANCEL_RUNTIME")).toHaveLength(1)
		expect(kernel.commands.filter((command) => command.type === "halt.stop")).toEqual([
			expect.objectContaining({
				type: "halt.stop",
				haltId: "halt-1",
				reason: "cancel",
				participantIds: ALL_HALT_PARTICIPANTS,
			}),
		])
	})

	it.each([
		["completed", "BLOCK_EXECUTION_COMPLETED", "tool.completed"],
		["cancelled", "BLOCK_EXECUTION_CANCELLED", "tool.cancelled"],
	] as const)("matches legacy automatic tool lifecycle ending in %s", (_phase, legacyTerminal, kernelTerminal) => {
		const legacy = runLegacy(legacyTurnState([legacyBlock("b1", 0, false)]), [
			{ type: "BLOCK_READY", turnId: "turn-1", dlineTid: "b1" },
			{ type: "BLOCK_EXECUTION_STARTED", turnId: "turn-1", dlineTid: "b1" },
			{ type: legacyTerminal, turnId: "turn-1", dlineTid: "b1" },
		])
		const policyCommandId = "policy:b1"
		const kernel = runKernel(
			kernelTurnState([
				{
					...kernelBlock("b1", 0),
					policy: {
						commandId: policyCommandId,
						originRevision: 0,
						status: "running",
						interactionId: "policy:b1",
						policyRevision: 1,
					},
				},
			]),
			[
				{
					type: "approval.evaluated",
					generation: 0,
					commandId: policyCommandId,
					originRevision: 0,
					attempt: "attempt-b1-1",
					interactionId: "policy:b1",
					policyRevision: 1,
					blockId: "b1",
					approved: true,
				},
				{ type: "tool.started", generation: 0, attempt: "attempt-b1-1", turnId: "turn-1", blockId: "b1" },
				{ type: kernelTerminal, generation: 0, attempt: "attempt-b1-1", turnId: "turn-1", blockId: "b1" },
			],
		)

		for (const index of [1, 2, 3])
			expect(projectKernelTurn(kernel.states[index])).toEqual(projectLegacyTurn(legacy.states[index]))
		expect(legacy.effects.filter((effect) => effect.type === "EXECUTE_TOOL")).toHaveLength(1)
		expect(kernel.commands.filter((command) => command.type === "tool.run")).toEqual([
			expect.objectContaining({
				type: "tool.run",
				turnId: "turn-1",
				blocks: [expect.objectContaining({ blockId: "b1", attempt: "attempt-b1-1" })],
			}),
		])
	})

	it("matches legacy manual rejection and skips every later unstarted block", () => {
		const legacy = runLegacy(
			legacyTurnState([legacyBlock("b1", 0, true), legacyBlock("b2", 1, true), legacyBlock("b3", 2, false)]),
			[
				{ type: "BLOCK_APPROVAL_REQUIRED", turnId: "turn-1", dlineTid: "b1" },
				{ type: "BLOCK_REJECTED", turnId: "turn-1", dlineTid: "b1" },
			],
		)
		const kernel = runKernel(kernelTurnState([kernelBlock("b1", 0), kernelBlock("b2", 1), kernelBlock("b3", 2)]), [
			{
				type: "approval.requested",
				generation: 0,
				turnId: "turn-1",
				blockId: "b1",
				interactionId: "b1",
				kind: "tool_approval",
				presentationRef: "approval:b1",
				actionRules: [
					{ actionId: "approve", payloadPolicy: "draft" },
					{ actionId: "reject", payloadPolicy: "draft" },
				],
			},
			{
				type: "dialog.prepared",
				generation: 0,
				commandId: "task-1:1:0",
				originRevision: 1,
				interactionId: "b1",
				journalRef: "journal:0:1",
				receiverGeneration: 0,
			},
			{
				type: "dialog.presented",
				generation: 0,
				commandId: "task-1:2:0",
				originRevision: 2,
				interactionId: "b1",
			},
			{
				type: "dialog.responded",
				generation: 0,
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "b1",
				stateRevision: 3,
				receiverGeneration: 0,
				actionId: "reject",
				draftRef: "draft:reject",
			},
			{ type: "approval.responded", generation: 0, turnId: "turn-1", blockId: "b1", interactionId: "b1", approved: false },
		])

		expect(projectKernelTurn(kernel.states[1])).toEqual(projectLegacyTurn(legacy.states[1]))
		expect(projectKernelTurn(kernel.states.at(-1)!)).toEqual(projectLegacyTurn(legacy.states[2]))
		expect(kernel.states.at(-1)?.flow.phase).toBe("waiting")
		expect(kernel.commands.filter((command) => command.type === "tool.run")).toEqual([])
	})
})

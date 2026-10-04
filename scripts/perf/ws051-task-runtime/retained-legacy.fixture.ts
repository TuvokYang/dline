import { BlockPhase, BlockPhaseMachine } from "@perf/legacy-block-phase"
import { TaskRuntime } from "@perf/legacy-runtime"
import { hydrateSnapshot } from "@perf/legacy-snapshot"
import { TaskPhase } from "@perf/legacy-task-phase"
import { TaskState } from "@perf/legacy-task-state"

export const BLOCKS_PER_FIXTURE = 250
export const FIXTURE_REPLICAS = 128

export interface LegacyRuntimeAuthorities {
	readonly runtime: TaskRuntime
	readonly blockPhase: BlockPhaseMachine
	readonly taskState: TaskState
}

export function makeDenseFixture(seed: string): LegacyRuntimeAuthorities {
	const blocks = Array.from({ length: BLOCKS_PER_FIXTURE }, (_, index) => ({
		dlineTid: `block-${seed}-${index}`,
		functionId: `function-${seed}-${index}`,
		toolName: `tool-${index % 8}`,
		phase: BlockPhase.CANCELLED,
		ts: index + 1,
		requiresApproval: false,
		conversationHistoryIndex: index,
	}))
	const state = hydrateSnapshot({
		version: 2,
		taskId: `legacy-${seed}`,
		phase: TaskPhase.RESUMING,
		apiIndex: 0,
		timestamp: 0,
		revision: BLOCKS_PER_FIXTURE,
		anchor: { apiIndex: 0, turnId: `turn-${seed}` },
		turn: {
			turnId: `turn-${seed}`,
			assistantApiIndex: 0,
			blocks,
			mode: "parallel",
			approval: { automatic: [] },
			executing: [],
		},
	})
	const blockPhase = new BlockPhaseMachine()
	blockPhase.restoreTurn(state.turn?.blocks ?? [])
	return {
		runtime: new TaskRuntime(state, {} as never),
		blockPhase,
		taskState: new TaskState(),
	}
}

export function validateDenseFixture(value: LegacyRuntimeAuthorities): void {
	const state = value.runtime.getState()
	if (state.turn?.blocks.length !== BLOCKS_PER_FIXTURE || value.blockPhase.getBlocks().length !== BLOCKS_PER_FIXTURE) {
		throw new Error("Legacy recovered runtime authorities are incomplete")
	}
	if (state.turn.blocks.some((block) => block.phase !== BlockPhase.CANCELLED)) {
		throw new Error("Legacy recovered runtime retained a live effect")
	}
}

import { TaskRuntime } from "@perf/candidate-runtime"
import { InMemoryCommandPublicationStore, InMemoryStateVault, InMemoryTaskViewPort } from "@perf/candidate-stores"
import { createInitialTaskState, hydrate, type TaskState } from "@perf/kernel"

export const BLOCKS_PER_FIXTURE = 250
export const FIXTURE_REPLICAS = 128

export interface CandidateRuntimeAuthorities {
	readonly runtime: TaskRuntime
}

function denseSnapshot(seed: string): TaskState {
	const base = createInitialTaskState(`candidate-${seed}`)
	const blocks = Array.from({ length: BLOCKS_PER_FIXTURE }, (_, index) => ({
		blockId: `block-${seed}-${index}`,
		index,
		phase: "executing" as const,
		attempt: `attempt-${seed}-${index}`,
		lanes: [`lane-${index % 4}`],
		turnEnding: false,
		invocationRef: `invocation-${seed}-${index}`,
	}))
	return {
		...base,
		revision: BLOCKS_PER_FIXTURE,
		flow: { phase: "running" },
		turn: {
			turnId: `turn-${seed}`,
			mode: "parallel",
			blocks,
			manualApprovalBlockIds: [],
			automaticApprovalBlockIds: [],
			executingBlockIds: blocks.map((block) => block.blockId),
		},
		journalWatermark: { seq: BLOCKS_PER_FIXTURE },
	}
}

export function makeDenseFixture(seed: string): CandidateRuntimeAuthorities {
	const snapshot = denseSnapshot(seed)
	const hydrated = hydrate({
		taskId: snapshot.taskId,
		snapshot,
		journalTail: snapshot.journalWatermark,
		openReason: "crash_recovery",
	})
	if (hydrated.kind !== "ready") throw new Error("Candidate runtime fixture did not hydrate")
	return {
		runtime: new TaskRuntime({
			initialState: hydrated.state,
			vault: new InMemoryStateVault(),
			taskView: new InMemoryTaskViewPort(),
			publications: new InMemoryCommandPublicationStore(),
			executors: [],
			deferRestoredCommands: true,
			restoredOutbox: [],
		}),
	}
}

export function validateDenseFixture(value: CandidateRuntimeAuthorities): void {
	const state = value.runtime.getState()
	if (state.turn.blocks.length !== BLOCKS_PER_FIXTURE || state.turn.executingBlockIds.length !== 0) {
		throw new Error("Candidate recovered runtime authorities are incomplete")
	}
	if (state.turn.blocks.some((block) => block.phase !== "cancelled")) {
		throw new Error("Candidate recovered runtime retained a live effect")
	}
}

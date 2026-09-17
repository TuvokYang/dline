import type { AssistantMessageContent, ToolUse } from "@core/assistant-message"
import { Task } from "@core/task"
import { BlockPhase } from "@core/task/BlockPhaseMachine"
import type { TaskEffectPorts } from "@core/task/runtime/TaskEffectRunner"
import { TaskRuntime } from "@core/task/runtime/TaskRuntime"
import { createTaskRuntimeState } from "@core/task/runtime/TaskRuntimeState"
import { TaskPhase } from "@core/task/TaskPhase"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"

/**
 * Observes how many tool effects are in flight at the same time.
 *
 * Peak overlap is the discriminating measurement: asserting that every block
 * eventually ran passes under a serial loop too. Only the maximum number
 * simultaneously in flight separates real concurrency from fast sequencing.
 */
function createOverlapRecorder() {
	let inFlight = 0
	let peak = 0
	const release: Array<() => void> = []
	const admitted: string[] = []

	return {
		admitted,
		get peak() {
			return peak
		},
		/** Let every effect currently parked finish. */
		releaseAll() {
			for (const resolve of release.splice(0)) {
				resolve()
			}
		},
		/** An effect that parks until released, so overlap is observable. */
		async enter(dlineTid: string): Promise<void> {
			admitted.push(dlineTid)
			inFlight += 1
			peak = Math.max(peak, inFlight)
			await new Promise<void>((resolve) => release.push(resolve))
			inFlight -= 1
		},
	}
}

interface TurnOptions {
	blockCount: number
	parallel: boolean
	configuredLimit?: number
	executeTool?: (effect: { dlineTid: string }) => Promise<void>
	requiresApproval?: boolean
	/** Tool to fill the turn with. Defaults to one that holds no lane. */
	toolName?: ClineDefaultTool
	/** Parameters given to every block, used to exercise lane derivation. */
	params?: Record<string, string>
	/** Whether the whole turn is known to need no user approval. */
	autoApproved?: boolean
}

/**
 * Build a Task double whose turn contains `blockCount` auto-approved reads.
 *
 * Mirrors the fixture used by Task.processNativeToolCalls tests: the runtime,
 * phase machine and block identities are real, while the surrounding host is
 * reduced to what one finalized turn touches.
 */
function createTurn({
	blockCount,
	parallel,
	configuredLimit,
	executeTool,
	requiresApproval = false,
	// list_files holds no static lane, so overlap is decided by the pool's
	// capacity rather than by lane exclusivity. Using read_file here would
	// measure the shared file-read lane instead of the wiring under test.
	toolName = ClineDefaultTool.LIST_FILES,
	params,
	autoApproved = true,
}: TurnOptions) {
	const toolBlocks: ToolUse[] = Array.from({ length: blockCount }, (_, index) => ({
		type: "tool_use",
		name: toolName,
		params: params ?? { path: `dir-${index + 1}` },
		partial: false,
		isNativeToolCall: true,
		function_id: `call-read-${index + 1}`,
		dline_tid: `dline-read-${index + 1}`,
		ts: 500 + index,
	}))
	const runtimeBlocks = toolBlocks.map((block, index) => ({
		dlineTid: `dline-read-${index + 1}`,
		functionId: block.function_id,
		toolName,
		phase: BlockPhase.STREAMING,
		ts: 500 + index,
		requiresApproval,
		conversationHistoryIndex: 1,
	}))

	const ports: TaskEffectPorts = {
		postView: vi.fn(async () => undefined),
		persistSnapshot: vi.fn(async () => undefined),
		cancelRuntime: vi.fn(async () => undefined),
		prepareResume: vi.fn(async () => undefined),
		startApi: vi.fn(async () => undefined),
		executeTool: vi.fn(executeTool ?? (async () => undefined)),
		appendSay: vi.fn(async () => undefined),
		appendAsk: vi.fn(async () => ({ uiMessageTs: 1 })),
		startNewTask: vi.fn(async () => undefined),
	}
	const runtime = new TaskRuntime(
		createTaskRuntimeState({
			taskId: "task-concurrency",
			phase: TaskPhase.STREAMING,
			anchor: { apiIndex: 1 },
		}),
		ports,
	)

	const fakeTask = Object.assign(Object.create(Task.prototype), {
		taskId: "task-concurrency",
		controller: { task: { taskId: "task-concurrency" } },
		initialCheckpointCommitPromise: undefined,
		reRenderUpdatedPartialBlocks: async () => undefined,
		isParallelToolCallingEnabled: () => parallel,
		stateManager: {
			getGlobalSettingsKey: (key: string) => (key === "maxParallelToolCalls" ? configuredLimit : undefined),
		},
		dispatchRuntime: runtime.dispatch.bind(runtime),
		taskController: {
			buildTurn: vi.fn(),
			getBlocks: () => runtimeBlocks,
			hasAnyRejection: () => false,
			shouldSkip: () => false,
		},
		toolExecutor: {
			isBlockApproved: () => true,
			executeTool: vi.fn(async () => undefined),
			takePostCommitDirective: () => undefined,
			isTurnFullyAutoApproved: async () => autoApproved,
		},
		taskRuntime: runtime,
		messageStateHandler: { apiConversationHistory: [{ role: "user" }, { role: "assistant" }] },
		taskState: {
			abort: false,
			assistantMessageContent: toolBlocks as AssistantMessageContent[],
			currentStreamingContentIndex: 0,
			didAlreadyUseTool: false,
			didCompleteReadingStream: true,
			lastRenderedPartialByTs: new Map<number, string>(),
			partialToolLifecycleByTs: new Map<number, "partial-shown" | "complete-running" | "complete-done">(),
			presentAssistantMessageHasPendingUpdates: false,
			presentAssistantMessageLocked: false,
			userMessageContentReady: false,
		},
		markFinalizedToolPresented: vi.fn(),
	})

	return { fakeTask, runtime, ports }
}

function runTurn(fakeTask: unknown): Promise<void> {
	return (
		Task.prototype as unknown as { executeFinalizedAssistantTurn: () => Promise<void> }
	).executeFinalizedAssistantTurn.call(fakeTask)
}

describe("finalized turn tool concurrency", () => {
	it("runs parallel-turn blocks with real overlap rather than one at a time", async () => {
		const recorder = createOverlapRecorder()
		const { fakeTask } = createTurn({
			blockCount: 4,
			parallel: true,
			executeTool: (effect) => recorder.enter(effect.dlineTid),
		})

		const turn = runTurn(fakeTask)
		// Let admission settle before releasing, so peak reflects how many the
		// pool was willing to start rather than how fast each one finished.
		await vi.waitFor(() => expect(recorder.admitted).toHaveLength(4))
		recorder.releaseAll()
		await expect(turn).resolves.toBeUndefined()

		expect(recorder.peak).toBe(4)
	})

	it("does not serialise read-only blocks that name the same path", async () => {
		const recorder = createOverlapRecorder()
		const { fakeTask } = createTurn({
			blockCount: 3,
			parallel: true,
			// A read-only tool carries `path` too. Deriving a write-path lane
			// from it would make three reads of one directory run one at a
			// time, and would let a read block a genuine writer.
			toolName: ClineDefaultTool.LIST_FILES,
			params: { path: "src" },
			executeTool: (effect) => recorder.enter(effect.dlineTid),
		})

		const turn = runTurn(fakeTask)
		await vi.waitFor(() => expect(recorder.admitted).toHaveLength(3))
		recorder.releaseAll()
		await expect(turn).resolves.toBeUndefined()

		expect(recorder.peak).toBe(3)
	})

	it("keeps a serial turn at one block in flight", async () => {
		const recorder = createOverlapRecorder()
		const { fakeTask } = createTurn({
			blockCount: 3,
			parallel: false,
			executeTool: async (effect) => {
				// A serial turn must never park two effects at once, so each is
				// released immediately; overlap above one would still be seen.
				const entered = recorder.enter(effect.dlineTid)
				recorder.releaseAll()
				await entered
			},
		})

		await expect(runTurn(fakeTask)).resolves.toBeUndefined()

		expect(recorder.peak).toBe(1)
		expect(recorder.admitted).toEqual(["dline-read-1", "dline-read-2", "dline-read-3"])
	})

	it("admits no more blocks at once than the configured ceiling", async () => {
		const recorder = createOverlapRecorder()
		const { fakeTask } = createTurn({
			blockCount: 5,
			parallel: true,
			configuredLimit: 2,
			executeTool: (effect) => recorder.enter(effect.dlineTid),
		})

		const turn = runTurn(fakeTask)
		// Drain in waves until the turn finishes: each release frees slots for
		// the blocks still queued. Peak is sampled across every wave, so a
		// ceiling breach at any point is still caught.
		let settled = false
		void turn.then(() => {
			settled = true
		})
		while (!settled) {
			recorder.releaseAll()
			await new Promise((resolve) => setTimeout(resolve, 0))
		}
		await expect(turn).resolves.toBeUndefined()

		expect(recorder.peak).toBeLessThanOrEqual(2)
		expect(recorder.admitted).toHaveLength(5)
	})

	it("reports every block's result in assistant order, not completion order", async () => {
		const { fakeTask, runtime } = createTurn({ blockCount: 4, parallel: true })

		await expect(runTurn(fakeTask)).resolves.toBeUndefined()

		expect(runtime.getState().turn?.blocks.map((block) => block.dlineTid)).toEqual([
			"dline-read-1",
			"dline-read-2",
			"dline-read-3",
			"dline-read-4",
		])
		expect(runtime.getState().turn?.blocks.every((block) => block.phase === BlockPhase.COMPLETED)).toBe(true)
	})

	it("runs a turn that may ask for approval serially", async () => {
		const recorder = createOverlapRecorder()
		const { fakeTask } = createTurn({
			blockCount: 4,
			parallel: true,
			// The turn is not known to be auto-approved, so an approval card
			// may open. A sibling finishing while it is open would advance the
			// runtime revision and the user's answer would be refused as
			// stale, suspending the turn. Such a turn must stay serial.
			autoApproved: false,
			executeTool: async (effect) => {
				const entered = recorder.enter(effect.dlineTid)
				recorder.releaseAll()
				await entered
			},
		})

		await expect(runTurn(fakeTask)).resolves.toBeUndefined()

		expect(recorder.peak).toBe(1)
		expect(recorder.admitted).toHaveLength(4)
	})

	it("settles every block exactly once when one fails mid-turn", async () => {
		const settled: string[] = []
		const { fakeTask } = createTurn({
			blockCount: 3,
			parallel: true,
			executeTool: async (effect) => {
				settled.push(effect.dlineTid)
				if (effect.dlineTid === "dline-read-2") {
					throw new Error("tool effect failed")
				}
			},
		})

		await expect(runTurn(fakeTask)).rejects.toThrow("tool effect failed")

		// A failing block must not cause a sibling to run twice or be skipped
		// silently. Counting distinct identities alone would also pass if only
		// one block had run, so the membership is asserted too.
		expect(settled).toHaveLength(3)
		expect([...settled].sort()).toEqual(["dline-read-1", "dline-read-2", "dline-read-3"])
	})

	it("does not start queued blocks once a block has failed", async () => {
		const started: string[] = []
		// One slot, so blocks 2 and 3 are still queued when block 1 throws.
		// Under a serial loop neither would ever begin, and the pool must keep
		// that guarantee rather than filling the slot the failure frees.
		const { fakeTask } = createTurn({
			blockCount: 3,
			parallel: true,
			configuredLimit: 1,
			executeTool: async (effect) => {
				started.push(effect.dlineTid)
				if (effect.dlineTid === "dline-read-1") {
					throw new Error("first block failed")
				}
			},
		})

		await expect(runTurn(fakeTask)).rejects.toThrow("first block failed")

		expect(started).toEqual(["dline-read-1"])
	})
})

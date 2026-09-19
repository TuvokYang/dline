import type { ToolUse } from "@core/assistant-message"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { BlockPhase } from "../../../BlockPhaseMachine"
import type { TaskEffectPorts } from "../../../runtime/TaskEffectRunner"
import type { TaskEvent } from "../../../runtime/TaskEvent"
import { TaskRuntime } from "../../../runtime/TaskRuntime"
import { createTaskRuntimeState } from "../../../runtime/TaskRuntimeState"
import { TaskPhase } from "../../../TaskPhase"
import { TurnDriver } from "../TurnDriver"
import type { BlockLifecycleOutcome, TurnDriverSchedulingSession, TurnPostCommitDirective } from "../TurnDriverPort"

function effectPorts(): TaskEffectPorts {
	return {
		postView: async () => {},
		persistSnapshot: async () => {},
		cancelRuntime: async () => {},
		prepareResume: async () => {},
		startApi: async () => {},
		executeTool: async () => {},
		appendSay: async () => {},
		appendAsk: async () => ({ uiMessageTs: 1 }),
		startNewTask: async () => {},
	}
}

describe("TurnDriver post-commit ordering", () => {
	it("commits TURN_COMPLETED before starting a successor task", async () => {
		const tool: ToolUse = {
			type: "tool_use",
			name: ClineDefaultTool.NEW_TASK,
			params: { context: "continue" },
			partial: false,
			ts: 10,
			function_id: "function-new-task",
			dline_tid: "dline-new-task",
		}
		const runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING, anchor: { apiIndex: 1 } }),
			effectPorts(),
		)
		const sequence: string[] = []
		const directive: TurnPostCommitDirective = {
			type: "start_successor_task",
			context: "continue",
			functionId: tool.function_id,
			dlineTid: tool.dline_tid,
		}
		const dispatch = async (event: TaskEvent) => {
			sequence.push(event.type)
			return runtime.dispatch(event)
		}
		const startSuccessor = vi.fn(async () => {
			sequence.push("START_SUCCESSOR")
		})
		const driver = new TurnDriver({
			task: {
				getTaskId: () => "task-1",
				isAborted: () => false,
				isCurrentTask: () => true,
				getAssistantMessageContent: () => [tool],
				getAssistantApiIndex: () => 1,
				buildTurn: () => [
					{
						dlineTid: tool.dline_tid,
						functionId: tool.function_id,
						toolName: tool.name,
						phase: BlockPhase.STREAMING,
						ts: tool.ts,
						requiresApproval: false,
						conversationHistoryIndex: 1,
					},
				],
				isParallelToolCallingEnabled: () => false,
				getPendingUserMessageContent: () => [],
				markPartialToolComplete: vi.fn(),
				recordToolCall: vi.fn(),
				markUserMessageContentReady: vi.fn(),
				applyCompactionFit: vi.fn(),
			},
			runtime: { getState: () => runtime.getState(), dispatch },
			block: {
				prepareAdmission: () => ({
					outcome: "admitted",
					decision: { kind: "automatic", scope: "subagent", ceiling: "auto" },
					lanes: [],
					run: async () => undefined,
				}),
				commitInterruptedResult: vi.fn(async () => undefined),
				awaitInitialCheckpoint: vi.fn(async () => undefined),
			},
			approval: {
				request: vi.fn(async () => ({ actionId: "approve" as const })),
				stageFeedback: vi.fn(async () => undefined),
			},
			scheduler: {
				cancelActiveTurn: vi.fn(),
				notifyLimitChanged: vi.fn(),
				runTurn: vi.fn(
					async (_tools: ToolUse[], run: (session: TurnDriverSchedulingSession) => Promise<BlockLifecycleOutcome>) =>
						run({
							markAdmissionSettled: vi.fn(),
							markAdmissionUnsettled: vi.fn(),
							submit: async (_tool, _index, _admission, execute) => execute(new AbortController().signal),
						}),
				),
			},
			provider: { registerExecution: vi.fn() },
			postCommit: {
				takeDirective: () => directive,
				startSuccessor,
			},
		})

		await driver.execute()

		expect(sequence.indexOf("TURN_COMPLETED")).toBeGreaterThanOrEqual(0)
		expect(sequence.indexOf("START_SUCCESSOR")).toBeGreaterThan(sequence.indexOf("TURN_COMPLETED"))
		expect(startSuccessor).toHaveBeenCalledWith(directive)
	})
})

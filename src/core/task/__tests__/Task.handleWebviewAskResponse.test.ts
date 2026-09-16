import { strict as assert } from "node:assert"
import { Task } from "@core/task"
import type { ClineAskResponse } from "@shared/WebviewMessage"
import { afterEach, describe, it, vi } from "vitest"
import { BlockPhase } from "../BlockPhaseMachine"
import type { MessageChannel } from "../MessageChannel"
import type { TaskEffectPorts } from "../runtime/TaskEffectRunner"
import type { TaskEvent } from "../runtime/TaskEvent"
import { TaskRuntime } from "../runtime/TaskRuntime"
import { createTaskRuntimeState } from "../runtime/TaskRuntimeState"
import { TaskController } from "../TaskController"
import { TaskPhase } from "../TaskPhase"
import type { TaskSnapshot } from "../TaskSnapshot"

/**
 * Tests for Task.handleWebviewAskResponse — validates that conversational ask
 * types (qna_respond, make_plan, etc.) are NOT treated as rejections
 * when the user responds with messageResponse.
 *
 * Bug: handleWebviewAskResponse unconditionally calls rejectActiveBlock()
 * for messageResponse, which cascades SKIPPED to subsequent conversational
 * tools and causes the task loop to deadlock.
 */

type TaskSnapshotEmitter = {
	emitStateSnapshot(snapshot: TaskSnapshot): Promise<void>
}

// ── Helpers ──

/**
 * Channel double for the case these tests exercise: an ask is waiting.
 *
 * `resolve` reports whether a waiting ask accepted the response, so the double
 * must answer `true`. Returning `undefined` would make the handler treat every
 * response as arriving with nothing to receive it.
 */
function createMockChannel(): MessageChannel {
	return { say: vi.fn(), ask: vi.fn(), resolve: vi.fn(() => true) } as unknown as MessageChannel
}

/** Channel double for the opposite case: nothing is waiting for a response. */
function createChannelWithNoWaitingAsk(): MessageChannel {
	return { say: vi.fn(), ask: vi.fn(), resolve: vi.fn(() => false) } as unknown as MessageChannel
}

/**
 * Create a canonical native tool block for TaskController tests.
 *
 * @param name Native tool name.
 * @param functionId Provider function pairing identity.
 * @param ts Stable UI message timestamp.
 * @returns Canonical runtime tool block.
 */
function createToolBlock(name: string, functionId: string, ts: number) {
	return {
		type: "tool_use" as const,
		name,
		call_id: functionId,
		function_id: functionId,
		item_id: `dline_item_${functionId}`,
		dline_tid: `dline_tid_${functionId}`,
		ts,
	}
}

/**
 * Creates a fake task object with just enough properties for
 * handleWebviewAskResponse to work. Uses a real TaskController so
 * the BlockPhaseMachine state changes are real.
 */
function createFakeTaskForHandleWebviewAskResponse(controller: TaskController, extra: Partial<Record<string, any>> = {}) {
	return {
		taskController: controller,
		taskState: { userMessageContent: [] },
		taskRuntime: { getState: () => ({ interaction: undefined }) },
		// resolveAsk is called first in handleWebviewAskResponse
		// postStateToWebview is called after transition
		// flushTaskSnapshot waits for canonical runtime persistence.
		postStateToWebview: vi.fn(async () => {}),
		flushTaskSnapshot: vi.fn(async () => {}),
		findLatestStateSnapshot: vi.fn(() => undefined),
		// isParallelToolCallingEnabled is used in yesButtonClicked path
		isParallelToolCallingEnabled: vi.fn(() => true),
		...extra,
	}
}

/**
 * Builds a turn with two conversational tool blocks (e.g. qna_respond),
 * advances the first to AWAITING_APPROVAL, ready for handleWebviewAskResponse.
 */
function setupTwoConversationalBlocks(): {
	controller: TaskController
	callIds: string[]
} {
	const channel = createMockChannel()
	const controller = new TaskController(channel)
	controller.restoreFrom({ phase: TaskPhase.AWAITING_APPROVAL, apiIndex: 0, timestamp: 1 })

	const callIds = ["call_qna_0", "call_qna_1"]
	const blocks = [createToolBlock("qna_respond", callIds[0], 100), createToolBlock("qna_respond", callIds[1], 200)]

	// Build turn — none auto-approved (conversational tools are never auto-approved)
	controller.buildTurn(blocks, () => false)

	// Advance first block to AWAITING_APPROVAL
	controller.advance(`dline_tid_${callIds[0]}`, true)

	return { controller, callIds }
}

// ── Tests ──

describe("Task.handleWebviewAskResponse", () => {
	// Ensure cleanup between tests
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("emitStateSnapshot durably flushes snapshot json without writing state_snapshot ui messages", async () => {
		const scheduledSnapshots: TaskSnapshot[] = []
		const persistenceOrder: string[] = []
		const say = vi.fn(async () => 123)
		const fakeTask = {
			say,
			syncTaskCompletionProjection: vi.fn(async () => false),
			postStateToWebview: vi.fn(async () => {}),
			snapshotPersistence: {
				schedule: (snapshot: TaskSnapshot) => {
					persistenceOrder.push("schedule")
					scheduledSnapshots.push(snapshot)
				},
				flushNow: vi.fn(async () => {
					persistenceOrder.push("flush")
				}),
			},
		}
		const snapshot: TaskSnapshot = { phase: TaskPhase.STREAMING, apiIndex: 2, timestamp: 300 }

		await (Task.prototype as unknown as TaskSnapshotEmitter).emitStateSnapshot.call(fakeTask, snapshot)

		assert.equal(scheduledSnapshots.length, 1)
		assert.deepEqual(scheduledSnapshots[0], snapshot)
		assert.deepEqual(persistenceOrder, ["schedule", "flush"])
		assert.equal(say.mock.calls.length, 0)
	})

	it("projects completion only after the canonical snapshot flush succeeds", async () => {
		const order: string[] = []
		const sync = vi.fn(async (_state: { phase: TaskPhase; revision: number; completion?: { completionId: string } }) => {
			order.push("project")
			return true
		})
		const postStateToWebview = vi.fn(async (_options?: { immediate?: boolean }) => {
			order.push("push")
		})
		const fakeTask = {
			syncTaskCompletionProjection: vi.fn(async (snapshot: TaskSnapshot) =>
				sync({ phase: snapshot.phase, revision: snapshot.revision ?? -1, completion: snapshot.completion }),
			),
			snapshotPersistence: {
				schedule: () => order.push("schedule"),
				flushNow: vi.fn(async () => {
					order.push("flush")
				}),
			},
			completionProjector: { sync },
			postStateToWebview,
		}
		const snapshot: TaskSnapshot = {
			version: 2,
			taskId: "task-1",
			phase: TaskPhase.COMPLETED,
			apiIndex: 2,
			timestamp: 300,
			revision: 7,
			anchor: { apiIndex: 2 },
			completion: { completionId: "completion-1" },
		}

		await (Task.prototype as unknown as TaskSnapshotEmitter).emitStateSnapshot.call(fakeTask, snapshot)

		assert.deepEqual(order, ["schedule", "flush", "project", "push"])
		assert.deepEqual(sync.mock.calls[0]?.[0], {
			phase: TaskPhase.COMPLETED,
			revision: 7,
			completion: { completionId: "completion-1" },
		})
		assert.deepEqual(postStateToWebview.mock.calls[0]?.[0], { immediate: true })
	})

	it("does not project completion when canonical snapshot persistence fails", async () => {
		const sync = vi.fn(async () => true)
		const fakeTask = {
			syncTaskCompletionProjection: vi.fn(async () => sync()),
			snapshotPersistence: {
				schedule: vi.fn(),
				flushNow: vi.fn(async () => {
					throw new Error("snapshot write failed")
				}),
			},
			completionProjector: { sync },
			postStateToWebview: vi.fn(async () => {}),
		}
		const snapshot: TaskSnapshot = {
			version: 2,
			taskId: "task-1",
			phase: TaskPhase.COMPLETED,
			apiIndex: 2,
			timestamp: 300,
			revision: 7,
			anchor: { apiIndex: 2 },
			completion: { completionId: "completion-1" },
		}

		await assert.rejects(
			(Task.prototype as unknown as TaskSnapshotEmitter).emitStateSnapshot.call(fakeTask, snapshot),
			/snapshot write failed/,
		)
		assert.equal(sync.mock.calls.length, 0)
	})

	it("emitStateSnapshot exposes its in-memory state while durable snapshot persistence is pending", async () => {
		const scheduledSnapshots: TaskSnapshot[] = []
		let releaseFlush: (() => void) | undefined
		const flushGate = new Promise<void>((resolve) => {
			releaseFlush = resolve
		})
		let flushStarted = false
		const fakeTask = {
			syncTaskCompletionProjection: vi.fn(async () => false),
			postStateToWebview: vi.fn(async () => {}),
			snapshotPersistence: {
				schedule: (snapshot: TaskSnapshot) => {
					scheduledSnapshots.push(snapshot)
				},
				flushNow: vi.fn(async () => {
					flushStarted = true
					await flushGate
				}),
			},
		}
		const snapshot: TaskSnapshot = {
			phase: TaskPhase.AWAITING_APPROVAL,
			apiIndex: 2,
			timestamp: 300,
			awaiting: { kind: "error_recovery", taskAsk: "api_req_failed", messageTs: 123 },
			error: {
				kind: "api_req_failed",
				sourceAsk: "api_req_failed",
				message: '{"message":"OpenAI API key or Azure Identity Authentication is required","providerId":"openai"}',
				actions: ["retry", "start_new_task"],
				retryable: true,
				processAllowed: false,
				messageTs: 123,
			},
		}

		let persistenceSettled = false
		const persistence = (Task.prototype as unknown as TaskSnapshotEmitter).emitStateSnapshot
			.call(fakeTask, snapshot)
			.then(() => {
				persistenceSettled = true
			})
		await vi.waitFor(() => assert.equal(flushStarted, true))

		assert.deepEqual((fakeTask as { latestTaskSnapshot?: TaskSnapshot }).latestTaskSnapshot, snapshot)
		assert.equal(scheduledSnapshots.length, 1)
		assert.equal(persistenceSettled, false)

		releaseFlush?.()
		await persistence
		assert.equal(persistenceSettled, true)
	})

	it("messageResponse with running feedback appends content for the next model turn", async () => {
		const channel = createMockChannel()
		const controller = new TaskController(channel)
		const userMessageContent: Array<{ type: "text"; text: string }> = []
		const say = vi.fn(async (_type: string, _text?: string) => 123)
		const fakeTask = createFakeTaskForHandleWebviewAskResponse(controller, {
			say,
			taskState: { userMessageContent },
			checkpointManager: { saveCheckpoint: vi.fn(async () => {}) },
		})

		await Task.prototype.handleWebviewAskResponse.call(
			fakeTask,
			"messageResponse" as ClineAskResponse,
			"please use the new context",
		)

		assert.equal(say.mock.calls[0][0], "user_feedback")
		assert.equal(userMessageContent.length, 1)
		assert.equal(userMessageContent[0].type, "text")
		assert.match(userMessageContent[0].text, /<user_message>\nplease use the new context\n<\/user_message>/)
		assert.doesNotMatch(userMessageContent[0].text, /<feedback>/)
	})

	it("yesButtonClicked with retry feedback leaves the draft to the causal continuation", async () => {
		const channel = createMockChannel()
		const controller = new TaskController(channel)
		const userMessageContent: Array<{ type: "text"; text: string }> = []
		const say = vi.fn(async (_type: string, _text?: string) => 123)
		const fakeTask = createFakeTaskForHandleWebviewAskResponse(controller, {
			say,
			taskState: { userMessageContent },
			checkpointManager: { saveCheckpoint: vi.fn(async () => {}) },
		})

		await Task.prototype.handleWebviewAskResponse.call(fakeTask, "yesButtonClicked" as ClineAskResponse, "重试时请换个模型")

		assert.equal(say.mock.calls[0][0], "user_feedback")
		assert.equal(userMessageContent.length, 0)
	})

	it("messageResponse for an active approval only renders feedback and lets the tool result carry it", async () => {
		const channel = createMockChannel()
		const controller = new TaskController(channel)
		controller.restoreFrom({ phase: TaskPhase.AWAITING_APPROVAL, apiIndex: 0, timestamp: 1 })
		const blocks = [createToolBlock("write_to_file", "call_write", 100)]
		controller.buildTurn(blocks, () => false)
		controller.advance("dline_tid_call_write", true)
		const userMessageContent: Array<{ type: "text"; text: string }> = []
		const say = vi.fn(async (_type: string, _text?: string) => 123)
		const fakeTask = createFakeTaskForHandleWebviewAskResponse(controller, {
			say,
			taskState: { userMessageContent },
			checkpointManager: { saveCheckpoint: vi.fn(async () => {}) },
		})

		await Task.prototype.handleWebviewAskResponse.call(fakeTask, "messageResponse" as ClineAskResponse, "do not lose this")

		assert.equal(say.mock.calls[0][0], "user_feedback")
		assert.equal(userMessageContent.length, 0)
	})

	it("messageResponse for a runtime conversation interaction only renders feedback", async () => {
		const channel = createMockChannel()
		const controller = new TaskController(channel)
		const userMessageContent: Array<{ type: "text"; text: string }> = []
		const say = vi.fn(async (_type: string, _text?: string) => 123)
		const fakeTask = createFakeTaskForHandleWebviewAskResponse(controller, {
			say,
			taskState: { userMessageContent },
			taskRuntime: {
				getState: () => ({ interaction: { kind: "qna_response", interactionId: "qna-1" } }),
			},
		})

		await Task.prototype.handleWebviewAskResponse.call(fakeTask, "messageResponse" as ClineAskResponse, "不要重复入模")

		assert.equal(say.mock.calls[0][0], "user_feedback")
		assert.equal(userMessageContent.length, 0)
	})

	it("messageResponse for a runtime approval interaction only renders feedback", async () => {
		const channel = createMockChannel()
		const controller = new TaskController(channel)
		const userMessageContent: Array<{ type: "text"; text: string }> = []
		const say = vi.fn(async (_type: string, _text?: string) => 123)
		const fakeTask = createFakeTaskForHandleWebviewAskResponse(controller, {
			say,
			taskState: { userMessageContent },
			taskRuntime: {
				getState: () => ({ interaction: { kind: "tool_approval", interactionId: "approval-1" } }),
			},
		})

		await Task.prototype.handleWebviewAskResponse.call(
			fakeTask,
			"messageResponse" as ClineAskResponse,
			"审批反馈不要重复入模",
		)

		assert.equal(say.mock.calls[0][0], "user_feedback")
		assert.equal(userMessageContent.length, 0)
	})

	it("messageResponse with feedback text records visible feedback without creating an immediate checkpoint", async () => {
		const channel = createMockChannel()
		const controller = new TaskController(channel)
		const say = vi.fn(async (_type: string, _text?: string) => 123)
		const saveCheckpoint = vi.fn(async () => {})
		const userMessageContent: Array<{ type: "text"; text: string }> = []
		const fakeTask = createFakeTaskForHandleWebviewAskResponse(controller, {
			say,
			taskState: { userMessageContent },
			checkpointManager: { saveCheckpoint },
		})

		await Task.prototype.handleWebviewAskResponse.call(fakeTask, "messageResponse" as ClineAskResponse, "hello from My lord")

		assert.equal(say.mock.calls.length, 1)
		assert.equal(say.mock.calls[0][0], "user_feedback")
		assert.equal(say.mock.calls[0][1], "hello from My lord")
		assert.equal(userMessageContent.length, 1)
		assert.equal(saveCheckpoint.mock.calls.length, 0)
	})

	it("atomically accepts one Profile recovery reply without a pending ask", async () => {
		const channel = createChannelWithNoWaitingAsk()
		const controller = new TaskController(channel)
		const appendSay = vi.fn<TaskEffectPorts["appendSay"]>(async () => undefined)
		const runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({
					taskId: "task-1",
					phase: TaskPhase.BETWEEN_TURNS,
					revision: 5,
					anchor: { apiIndex: 2 },
				}),
				ordinaryInput: { kind: "profile_recovery" },
			},
			{
				postView: async () => undefined,
				persistSnapshot: async () => undefined,
				cancelRuntime: async () => undefined,
				prepareResume: async () => undefined,
				startApi: async () => undefined,
				executeTool: async () => undefined,
				appendSay,
				appendAsk: async () => ({ uiMessageTs: 100 }),
				startNewTask: async () => undefined,
				startSuccessorTask: async () => undefined,
			},
		)
		const userMessageContent: Array<{ type: "text"; text: string }> = []
		const taskState = { userMessageContent, userMessageContentReady: false }
		const fakeTask = createFakeTaskForHandleWebviewAskResponse(controller, {
			taskId: "task-1",
			taskRuntime: runtime,
			dispatchRuntime: (event: TaskEvent) => runtime.dispatch(event),
			taskState,
		})

		await Task.prototype.handleWebviewAskResponse.call(
			fakeTask,
			"messageResponse" as ClineAskResponse,
			"continue after switching profiles",
		)
		assert.equal(vi.mocked(channel.resolve).mock.calls.length, 0)

		await Task.prototype.handleWebviewAskResponse.call(
			fakeTask,
			"messageResponse" as ClineAskResponse,
			"continue after switching profiles",
		)

		assert.equal(vi.mocked(channel.resolve).mock.calls.length, 1)
		assert.equal(appendSay.mock.calls.length, 1)
		assert.equal(appendSay.mock.calls[0][0].taskSay, "user_feedback")
		assert.equal(appendSay.mock.calls[0][0].presentation, "continue after switching profiles")
		assert.equal(userMessageContent.length, 1)
		assert.match(userMessageContent[0].text, /<user_message>\ncontinue after switching profiles\n<\/user_message>/)
		assert.equal(taskState.userMessageContentReady, true)
		assert.equal(runtime.getState().ordinaryInput, undefined)
	})

	/**
	 * Input typed while the task is working has nothing waiting to receive it.
	 *
	 * Recording it would show it as user feedback and push it into the next
	 * model turn as an answer to a question that was never asked. Such input
	 * belongs in the input queue, which delivers it at a tool round or turn
	 * end instead.
	 */
	it("discards a response that no pending ask was waiting for", async () => {
		const channel = createChannelWithNoWaitingAsk()
		const controller = new TaskController(channel)
		const say = vi.fn(async (_type: string, _text?: string) => 123)
		const userMessageContent: Array<{ type: "text"; text: string }> = []
		const fakeTask = createFakeTaskForHandleWebviewAskResponse(controller, {
			say,
			taskState: { userMessageContent },
			checkpointManager: { saveCheckpoint: vi.fn(async () => {}) },
		})

		await Task.prototype.handleWebviewAskResponse.call(
			fakeTask,
			"messageResponse" as ClineAskResponse,
			"typed while the task was working",
		)

		assert.equal(say.mock.calls.length, 0)
		assert.equal(userMessageContent.length, 0)
	})

	// =====================================================================
	// CONVERSATIONAL ASK — BUG REPRODUCTION (should FAIL before fix)
	// =====================================================================

	describe("BUG: conversational ask (qna_respond) messageResponse triggers rejectActiveBlock", () => {
		it("calling real handleWebviewAskResponse with messageResponse REJECTS qna_respond and SKIPS second tool", async () => {
			const { controller, callIds } = setupTwoConversationalBlocks()

			// Verify setup: first block is AWAITING_APPROVAL
			const activeBefore = controller.getActiveBlock()
			assert.ok(activeBefore, "First block should be AWAITING_APPROVAL before call")
			assert.equal(activeBefore.functionId, callIds[0])

			// Create fake task and call the REAL method
			const fakeTask = createFakeTaskForHandleWebviewAskResponse(controller)
			await Task.prototype.handleWebviewAskResponse.call(fakeTask, "messageResponse" as ClineAskResponse)

			// BUG: messageResponse triggers rejectActiveBlock()
			// block0 → REJECTED, block1 → SKIPPED (cascade)
			const blocks = controller.getBlocks()
			const block0 = blocks.find((b) => b.functionId === callIds[0])
			const block1 = blocks.find((b) => b.functionId === callIds[1])

			// These assertions SHOULD FAIL with the current buggy code,
			// because block0 becomes REJECTED instead of staying AWAITING_APPROVAL
			assert.notEqual(
				block0?.phase,
				BlockPhase.REJECTED,
				"FIX: qna_respond block0 should NOT be REJECTED for messageResponse",
			)
			assert.notEqual(block1?.phase, BlockPhase.SKIPPED, "FIX: qna_respond block1 should NOT be cascaded SKIPPED")
		})

		it("after fix, isTurnComplete should be false for conversational ask messageResponse", async () => {
			const { controller } = setupTwoConversationalBlocks()

			const fakeTask = createFakeTaskForHandleWebviewAskResponse(controller)
			await Task.prototype.handleWebviewAskResponse.call(fakeTask, "messageResponse" as ClineAskResponse)

			// BUG: turn is complete because all blocks are REJECTED/SKIPPED
			// FIX: turn should NOT be complete
			assert.equal(
				controller.isTurnComplete,
				false,
				"FIX: turn should NOT be complete after conversational ask messageResponse",
			)
		})

		it("after fix, second block should NOT be shouldSkip", async () => {
			const { controller, callIds } = setupTwoConversationalBlocks()

			const fakeTask = createFakeTaskForHandleWebviewAskResponse(controller)
			await Task.prototype.handleWebviewAskResponse.call(fakeTask, "messageResponse" as ClineAskResponse)

			// BUG: second block is SKIPPED → shouldSkip returns true
			// FIX: second block should not be SKIPPED
			assert.equal(
				controller.shouldSkip(`dline_tid_${callIds[1]}`),
				false,
				"FIX: second qna_respond block should NOT be skipped",
			)
		})
	})

	// =====================================================================
	// NON-CONVERSATIONAL TOOL — Should still reject correctly
	// =====================================================================

	describe("non-conversational tool (write_to_file) — should still reject", () => {
		it("messageResponse for write_to_file DOES reject the block", async () => {
			const channel = createMockChannel()
			const controller = new TaskController(channel)
			controller.restoreFrom({ phase: TaskPhase.AWAITING_APPROVAL, apiIndex: 0, timestamp: 1 })

			const callId = "call_wf_0"
			controller.buildTurn([createToolBlock("write_to_file", callId, 100)], () => false)
			controller.advance(`dline_tid_${callId}`, true)

			const fakeTask = createFakeTaskForHandleWebviewAskResponse(controller)
			await Task.prototype.handleWebviewAskResponse.call(fakeTask, "messageResponse" as ClineAskResponse)

			const block = controller.getBlocks().find((b) => b.functionId === callId)
			assert.equal(block?.phase, BlockPhase.REJECTED, "write_to_file should be REJECTED for messageResponse")
		})
	})

	// =====================================================================
	// ALL CONVERSATIONAL TOOL NAMES — Regression coverage
	// =====================================================================

	const CONVERSATIONAL_TOOL_NAMES = ["qna_respond", "make_plan", "act_mode_respond", "ask_followup_question", "generate_report"]

	for (const toolName of CONVERSATIONAL_TOOL_NAMES) {
		describe(`conversational tool "${toolName}"`, () => {
			it(`messageResponse should NOT reject active block`, async () => {
				const channel = createMockChannel()
				const controller = new TaskController(channel)
				controller.restoreFrom({ phase: TaskPhase.AWAITING_APPROVAL, apiIndex: 0, timestamp: 1 })

				const callId = "call_conv_0"
				controller.buildTurn([createToolBlock(toolName, callId, 100)], () => false)
				controller.advance(`dline_tid_${callId}`, true)

				const fakeTask = createFakeTaskForHandleWebviewAskResponse(controller)
				await Task.prototype.handleWebviewAskResponse.call(fakeTask, "messageResponse" as ClineAskResponse)

				const block = controller.getBlocks().find((b) => b.functionId === callId)
				assert.notEqual(
					block?.phase,
					BlockPhase.REJECTED,
					`FIX: "${toolName}" should NOT be REJECTED for messageResponse`,
				)
			})
		})
	}

	// =====================================================================
	// RESUME SCENARIO — SKIPPED state should not persist on resume
	// =====================================================================

	describe("resume scenario", () => {
		it("after fix, conversational blocks are NOT cascaded SKIPPED on resume replay", async () => {
			const { controller, callIds } = setupTwoConversationalBlocks()

			const fakeTask = createFakeTaskForHandleWebviewAskResponse(controller)
			await Task.prototype.handleWebviewAskResponse.call(fakeTask, "messageResponse" as ClineAskResponse)

			// When resuming, the restored turn should not have SKIPPED blocks
			const block0 = controller.getBlocks().find((b) => b.functionId === callIds[0])
			const block1 = controller.getBlocks().find((b) => b.functionId === callIds[1])

			assert.notEqual(block0?.phase, BlockPhase.REJECTED, "Resume: block0 should NOT be REJECTED")
			assert.notEqual(block1?.phase, BlockPhase.SKIPPED, "Resume: block1 should NOT be SKIPPED")
		})
	})
})

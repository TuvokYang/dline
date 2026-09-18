import { strict as assert } from "node:assert"
import type { ToolUse } from "@core/assistant-message"
import { describe, it, vi } from "vitest"
import type { ClineAssistantToolUseBlock, ClineStorageMessage, ClineUserToolResultContentBlock } from "@/shared/messages"
import { BlockPhase } from "../BlockPhaseMachine"
import type { MessageChannel } from "../MessageChannel"
import type { PendingToolUseState, RestoreContext } from "../RestoreHandler"
import { RestoreHandler } from "../RestoreHandler"
import { TaskController } from "../TaskController"
import { TaskPhase } from "../TaskPhase"
import type { TaskSnapshot } from "../TaskSnapshot"

/**
 * Create a canonical stored native tool fixture.
 *
 * @param id Fixture identity suffix.
 * @param name Tool name.
 * @param input Tool input.
 * @returns Canonical stored tool-use block.
 */
function createStoredTool(id: string, name: string, input: Record<string, unknown>): ClineAssistantToolUseBlock {
	return {
		type: "tool_use",
		function_id: `call_${id}`,
		dline_tid: `tid_${id}`,
		provider_metadata: { item_id: `item_${id}` },
		name,
		input,
	}
}

/**
 * Tests for RestoreHandler — validates all restore modes and replayPendingTools.
 */
describe("RestoreHandler", () => {
	function asyncAdmission(kind: "automatic" | "manual"): RestoreContext["prepareAdmission"] {
		return () => ({
			outcome: "admitted",
			decision: { kind, scope: "read_workspace", ceiling: "auto" },
			lanes: [],
			run: async () => undefined,
		})
	}

	function createMockContext(overrides: Partial<RestoreContext> = {}): RestoreContext {
		return {
			taskState: {} as RestoreContext["taskState"],
			controller: {
				transitionRequired: () => ({}),
				reset: () => {},
				buildTurn: () => {},
				restoreFrom: () => {},
				phase: "idle",
			} as unknown as RestoreContext["controller"],
			messageStateHandler: {
				apiConversationHistory: [],
				overwriteApiConversationHistory: async () => {},
				clineMessages: [],
			} as unknown as RestoreContext["messageStateHandler"],
			presentAssistantMessage: async () => {},
			recursivelyMakeClineRequests: async () => false,
			postStateToWebview: async () => {},
			prepareAdmission: asyncAdmission("manual"),
			...overrides,
		}
	}

	// ── restoreFromCheckpoint ──

	it("restoreFromCheckpoint throws when checkpointManager is missing", async () => {
		const handler = new RestoreHandler(createMockContext())
		await assert.rejects(() => handler.restoreFromCheckpoint("abc123"), {
			message: "Checkpoint manager is not available. Enable checkpoints in settings.",
		})
	})

	it("restoreFromCheckpoint delegates to checkpointManager.restoreCheckpoint", async () => {
		let restoreCalled = false
		let restoreMessageTs: number | undefined

		const checkpointManager = {
			restoreCheckpoint: async (messageTs: number) => {
				restoreCalled = true
				restoreMessageTs = messageTs
			},
		}

		const handler = new RestoreHandler(
			createMockContext({ checkpointManager: checkpointManager as unknown as RestoreContext["checkpointManager"] }),
		)

		// Integer string → parse as messageTs
		await handler.restoreFromCheckpoint("42")
		assert.ok(restoreCalled, "restoreCheckpoint should be called")
		assert.equal(restoreMessageTs, 42)
	})

	// ── restoreAfterHistoryEdit ──

	it("restoreAfterHistoryEdit throws for out-of-range index", async () => {
		const handler = new RestoreHandler(
			createMockContext({
				messageStateHandler: {
					apiConversationHistory: [],
					clineMessages: [],
				} as unknown as RestoreContext["messageStateHandler"],
			}),
		)
		await assert.rejects(() => handler.restoreAfterHistoryEdit(5), {
			message: "Invalid modifiedApiIndex: 5, history length: 0",
		})
	})

	// ── restoreFilesOnly ──

	it("restoreFilesOnly throws when checkpointManager is missing", async () => {
		const handler = new RestoreHandler(createMockContext())
		await assert.rejects(() => handler.restoreFilesOnly(["file.ts"]), {
			message: "Checkpoint manager is not available. Enable checkpoints in settings.",
		})
	})

	it("restoreFilesOnly delegates to restoreCheckpoint for fallback", async () => {
		let restoreCalled = false
		const checkpointManager = {
			restoreCheckpoint: async () => {
				restoreCalled = true
			},
		}

		const handler = new RestoreHandler(
			createMockContext({ checkpointManager: checkpointManager as unknown as RestoreContext["checkpointManager"] }),
		)

		await handler.restoreFilesOnly(["file.ts"])
		assert.ok(restoreCalled, "restoreCheckpoint should be called as fallback")
	})

	// ── restoreChatOnly ──

	it("restoreChatOnly restores phase from snapshot and calls postStateToWebview", async () => {
		let restoreFromCalled = false
		let postStateCalled = false

		const handler = new RestoreHandler(
			createMockContext({
				controller: {
					restoreFrom: () => {
						restoreFromCalled = true
					},
					buildTurn: () => {},
					phase: "idle",
				} as unknown as RestoreContext["controller"],
				postStateToWebview: async () => {
					postStateCalled = true
				},
			}),
		)

		await handler.restoreChatOnly({
			phase: TaskPhase.EXECUTING,
			apiIndex: 3,
			timestamp: Date.now(),
		})

		assert.ok(restoreFromCalled, "restoreFrom should be called with snapshot")
		assert.ok(postStateCalled, "postStateToWebview should be called")
	})

	it("restoreChatOnly restores approval turn state from snapshot", async () => {
		let restoredBlocks: Parameters<RestoreContext["controller"]["restoreTurnFromSnapshot"]>[0] | undefined
		let restoredActiveDlineTid: string | undefined

		const handler = new RestoreHandler(
			createMockContext({
				controller: {
					restoreFrom: () => {},
					restoreTurnFromSnapshot: (
						blocks: Parameters<RestoreContext["controller"]["restoreTurnFromSnapshot"]>[0],
						activeDlineTid?: string,
					) => {
						restoredBlocks = blocks
						restoredActiveDlineTid = activeDlineTid
					},
					buildTurn: () => {},
					phase: "idle",
				} as unknown as RestoreContext["controller"],
			}),
		)

		await handler.restoreChatOnly({
			phase: TaskPhase.AWAITING_APPROVAL,
			apiIndex: 4,
			timestamp: Date.now(),
			approval: {
				mode: "serial",
				activeFunctionId: "call_active",
				activeDlineTid: "tid_active",
				blocks: [
					{
						functionId: "call_active",
						dlineTid: "tid_active",
						name: "write_to_file",
						phase: BlockPhase.AWAITING_APPROVAL,
						apiIndex: 4,
					},
					{
						functionId: "call_next",
						dlineTid: "tid_next",
						name: "execute_command",
						phase: BlockPhase.STREAMING,
						apiIndex: 4,
					},
				],
			},
		})

		assert.equal(restoredActiveDlineTid, "tid_active")
		assert.deepEqual(restoredBlocks, [
			{
				dlineTid: "tid_active",
				functionId: "call_active",
				toolName: "write_to_file",
				phase: "awaiting_approval",
				conversationHistoryIndex: 4,
				requiresApproval: true,
			},
			{
				dlineTid: "tid_next",
				functionId: "call_next",
				toolName: "execute_command",
				phase: "streaming",
				conversationHistoryIndex: 4,
				requiresApproval: true,
			},
		])
	})

	// ── replayPendingTools ──

	it("replayPendingTools calls transitionRequired and overwriteApiConversationHistory", async () => {
		const transitionRequiredCalls: Parameters<RestoreContext["controller"]["transitionRequired"]>[] = []
		let overwriteCalled = false
		const ctx = createMockContext({
			controller: {
				transitionRequired: (...args: Parameters<RestoreContext["controller"]["transitionRequired"]>) => {
					transitionRequiredCalls.push(args)
					return {} as ReturnType<RestoreContext["controller"]["transitionRequired"]>
				},
				reset: () => {},
				buildTurn: () => {},
				phase: "idle",
			} as unknown as RestoreContext["controller"],
			messageStateHandler: {
				apiConversationHistory: [{}, {}, {}, {}, {}] as unknown as ClineStorageMessage[],
				overwriteApiConversationHistory: async () => {
					overwriteCalled = true
				},
				clineMessages: [],
			} as unknown as RestoreContext["messageStateHandler"],
		})

		const handler = new RestoreHandler(ctx)
		const pending: PendingToolUseState = {
			assistantIndex: 2,
			toolUseBlocks: [createStoredTool("1", "read_file", { filePath: "/test.ts" })],
			answeredToolResults: [],
			sanitizedHistory: [],
		}

		await handler.replayPendingTools(pending, { baseTs: 1000 })
		assert.ok(
			transitionRequiredCalls.length >= 2,
			`Expected >= 2 transitionRequired calls, got ${transitionRequiredCalls.length}`,
		)
		assert.equal(transitionRequiredCalls[0][1].apiIndex, 2)
		assert.ok(overwriteCalled, "Expected overwriteApiConversationHistory to be called")
	})

	it("replayPendingTools rebuilds turn ownership from canonical Admission", async () => {
		let autoApproveResult: boolean | undefined
		const ctx = createMockContext({
			controller: {
				transitionRequired: () => ({}) as ReturnType<RestoreContext["controller"]["transitionRequired"]>,
				reset: () => {},
				buildTurn: (_blocks: ToolUse[], autoApprove: (toolName: string, callId: string) => boolean) => {
					autoApproveResult = autoApprove("read_file", "tid_1")
				},
				phase: "idle",
			} as unknown as RestoreContext["controller"],
			messageStateHandler: {
				apiConversationHistory: [{}, {}] as unknown as ClineStorageMessage[],
				overwriteApiConversationHistory: async () => {},
				clineMessages: [],
			} as unknown as RestoreContext["messageStateHandler"],
			prepareAdmission: asyncAdmission("automatic"),
		})

		const handler = new RestoreHandler(ctx)
		await handler.replayPendingTools({
			assistantIndex: 1,
			toolUseBlocks: [createStoredTool("1", "read_file", { filePath: "/test.ts" })],
			answeredToolResults: [],
			sanitizedHistory: [{}, {}] as unknown as ClineStorageMessage[],
		})

		assert.equal(autoApproveResult, true)
	})

	it("replayPendingTools restores multi-tool execution context without dropping answered results", async () => {
		const transitionRequiredCalls: Parameters<RestoreContext["controller"]["transitionRequired"]>[] = []
		let overwrittenHistory: ClineStorageMessage[] | undefined
		let recursiveContent: ClineUserToolResultContentBlock[] | undefined
		const taskState = {} as RestoreContext["taskState"]
		const ctx = createMockContext({
			taskState,
			controller: {
				transitionRequired: (...args: Parameters<RestoreContext["controller"]["transitionRequired"]>) => {
					transitionRequiredCalls.push(args)
					return {} as ReturnType<RestoreContext["controller"]["transitionRequired"]>
				},
				reset: () => {},
				buildTurn: () => {},
				phase: "idle",
			} as unknown as RestoreContext["controller"],
			messageStateHandler: {
				apiConversationHistory: [{}, {}, {}] as unknown as ClineStorageMessage[],
				overwriteApiConversationHistory: async (history: ClineStorageMessage[]) => {
					overwrittenHistory = history
				},
				clineMessages: [],
			} as unknown as RestoreContext["messageStateHandler"],
			recursivelyMakeClineRequests: async (content) => {
				recursiveContent = content as ClineUserToolResultContentBlock[]
				return false
			},
		})
		const answeredToolResult: ClineUserToolResultContentBlock = {
			type: "tool_result",
			function_id: "tool_done",
			dline_tid: "tid_done",
			content: [{ type: "text", text: "done" }],
		}
		const sanitizedHistory = [
			{ role: "user", content: [] },
			{ role: "assistant", content: [] },
		] as ClineStorageMessage[]

		const handler = new RestoreHandler(ctx)
		await handler.replayPendingTools(
			{
				assistantIndex: 1,
				toolUseBlocks: [
					createStoredTool("read", "read_file", { path: "a.ts" }),
					createStoredTool("write", "write_to_file", { path: "b.ts", content: "next" }),
				],
				answeredToolResults: [answeredToolResult],
				sanitizedHistory,
			},
			{ baseTs: 2000 },
		)

		assert.deepEqual(
			(taskState.assistantMessageContent as ToolUse[]).map((tool) => tool.function_id),
			["call_read", "call_write"],
		)
		assert.deepEqual(taskState.userMessageContent, [answeredToolResult])
		assert.deepEqual(recursiveContent, [answeredToolResult])
		assert.deepEqual(overwrittenHistory, sanitizedHistory)
		const lastTransition = transitionRequiredCalls.at(-1)
		assert.ok(lastTransition, "Expected replay to enter executing phase")
		assert.deepEqual(lastTransition[1].execution?.executingFunctionIds, ["call_read", "call_write"])
	})

	// ── hydrateFromSnapshot ──

	it("hydrateFromSnapshot restores approval block phases and active approval block", () => {
		const mockChannel: MessageChannel = {
			say: vi.fn(),
			ask: vi.fn(),
			resolve: vi.fn(),
		} as unknown as MessageChannel
		const controller = new TaskController(mockChannel)
		const snapshot: TaskSnapshot = {
			phase: TaskPhase.AWAITING_APPROVAL,
			apiIndex: 4,
			timestamp: 1000,
			approval: {
				mode: "serial",
				activeFunctionId: "call_active",
				activeDlineTid: "tid_active",
				blocks: [
					{
						functionId: "call_done",
						dlineTid: "tid_done",
						name: "read_file",
						phase: BlockPhase.COMPLETED,
						apiIndex: 4,
						ts: 100,
					},
					{
						functionId: "call_active",
						dlineTid: "tid_active",
						name: "write_to_file",
						phase: BlockPhase.AWAITING_APPROVAL,
						apiIndex: 4,
						ts: 200,
					},
					{
						functionId: "call_next",
						dlineTid: "tid_next",
						name: "execute_command",
						phase: BlockPhase.STREAMING,
						apiIndex: 4,
						ts: 300,
					},
				],
			},
		}
		const handler = new RestoreHandler(createMockContext({ controller }))

		handler.hydrateFromSnapshot(snapshot)

		assert.equal(controller.phase, TaskPhase.AWAITING_APPROVAL)
		assert.equal(controller.getPhase("tid_done"), BlockPhase.COMPLETED)
		assert.equal(controller.getPhase("tid_active"), BlockPhase.AWAITING_APPROVAL)
		assert.equal(controller.getPhase("tid_next"), BlockPhase.STREAMING)
		assert.equal(controller.getActiveBlock()?.dlineTid, "tid_active")
	})
})

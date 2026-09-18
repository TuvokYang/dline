import type { ToolUse } from "@core/assistant-message"
import type { ICheckpointManager } from "@integrations/checkpoints/types"
import type { ClineDefaultTool } from "@shared/tools"
import type { ClineAssistantToolUseBlock, ClineContent, ClineStorageMessage } from "@/shared/messages"
import { orderTurnEndingContentBlocks } from "./assistant-message-order"
import type { ToolPreflightResult } from "./executors/tool/ToolPreflight"
import type { MessageStateHandler } from "./message-state"
import type { TaskController } from "./TaskController"
import { TaskPhase } from "./TaskPhase"
import type { TaskSnapshot } from "./TaskSnapshot"
import type { TaskState } from "./TaskState"

// ── Types ──

export interface RestoreContext {
	taskState: TaskState
	controller: TaskController
	messageStateHandler: MessageStateHandler
	checkpointManager?: ICheckpointManager
	presentAssistantMessage: () => Promise<void>
	recursivelyMakeClineRequests: (content: ClineContent[]) => Promise<boolean>
	postStateToWebview: () => Promise<void>
	/** Canonical pure Admission preparation used to rebuild approval ownership. */
	prepareAdmission: (block: ToolUse) => ToolPreflightResult<void>
}

export interface PendingToolUseState {
	assistantIndex: number
	toolUseBlocks: ClineAssistantToolUseBlock[]
	answeredToolResults: ClineUserToolResultContentBlock[]
	sanitizedHistory: ClineStorageMessage[]
	lastPendingAskTs?: number
}

export interface ReplayOptions {
	resumeUserContent?: unknown[]
	baseTs?: number
}

interface CheckpointResolver extends ICheckpointManager {
	resolveHash?: (checkpointHash: string) => number | undefined
	revertFiles?: (changedFiles: string[]) => Promise<void>
}

// ── RestoreHandler ──

/**
 * Handles restoration of pending tool-use blocks from apiConversationHistory.
 * Supports four restore modes: checkpoint, history-edit, files-only, chat-only.
 */
export class RestoreHandler {
	constructor(private ctx: RestoreContext) {}

	// ── Checkpoint restore ──

	/**
	 * Restore workspace + conversation from a git checkpoint.
	 * Delegates to checkpointManager to reset both the workspace files and
	 * the conversation state to the given checkpoint hash.
	 */
	async restoreFromCheckpoint(checkpointHash: string): Promise<void> {
		const checkpointManager = this.ctx.checkpointManager
		if (!checkpointManager) {
			throw new Error("Checkpoint manager is not available. Enable checkpoints in settings.")
		}

		// Resolve the checkpoint hash to a message timestamp, then restore.
		// The checkpointManager.restoreCheckpoint() expects a messageTs.
		const tracker = checkpointManager as CheckpointResolver
		if (typeof tracker.resolveHash === "function") {
			const messageTs = tracker.resolveHash(checkpointHash)
			if (messageTs == null) {
				throw new Error(`Checkpoint hash not found: ${checkpointHash}`)
			}
			await checkpointManager.restoreCheckpoint(messageTs, "checkpoint")
		} else {
			// Fallback: use raw hash as messageTs if no resolver available
			const messageTs = Number.parseInt(checkpointHash, 10)
			if (Number.isNaN(messageTs)) {
				throw new Error(`Cannot resolve checkpoint hash to timestamp: ${checkpointHash}`)
			}
			await checkpointManager.restoreCheckpoint(messageTs, "checkpoint")
		}
	}

	// ── History edit restore ──

	/**
	 * After user edits the conversation history at a specific point,
	 * truncate apiConversationHistory and replay from that index.
	 * Pending tool_use blocks after modifiedApiIndex are re-executed.
	 */
	async restoreAfterHistoryEdit(modifiedApiIndex: number): Promise<void> {
		const apiHistory = this.ctx.messageStateHandler.apiConversationHistory
		if (modifiedApiIndex < 0 || modifiedApiIndex >= apiHistory.length) {
			throw new Error(`Invalid modifiedApiIndex: ${modifiedApiIndex}, history length: ${apiHistory.length}`)
		}

		// Truncate to the edited point + 1 (keep the edited user message)
		const truncatedHistory = apiHistory.slice(0, modifiedApiIndex + 1)

		// Detect pending tools from the truncated point
		// and replay them via the standard resume flow
		const pending: PendingToolUseState = {
			assistantIndex: modifiedApiIndex,
			toolUseBlocks: [],
			answeredToolResults: [],
			sanitizedHistory: truncatedHistory,
		}

		await this.replayPendingTools(pending)
	}

	// ── Files only restore ──

	/**
	 * Restore only the file changes from a list of changed files,
	 * leaving the conversation state untouched. Uses checkpointManager
	 * if available to revert file modifications.
	 */
	async restoreFilesOnly(changedFiles: string[]): Promise<void> {
		const checkpointManager = this.ctx.checkpointManager
		if (!checkpointManager) {
			throw new Error("Checkpoint manager is not available. Enable checkpoints in settings.")
		}

		// For each changed file, revert to the last checkpointed version
		const tracker = checkpointManager as CheckpointResolver
		if (typeof tracker.revertFiles === "function") {
			await tracker.revertFiles(changedFiles)
		} else {
			// Fallback: restore the latest checkpoint which covers all changed files
			await checkpointManager.restoreCheckpoint(0, "files")
		}
	}

	// ── Chat only restore ──

	/**
	 * Restore conversation state from a TaskSnapshot without touching files.
	 * Restores the task phase and approval state from the snapshot.
	 */
	async restoreChatOnly(snapshot: TaskSnapshot): Promise<void> {
		const { controller } = this.ctx

		// Restore task phase from snapshot
		controller.restoreFrom(snapshot)

		// If the snapshot contains approval context, restore approval blocks
		if (snapshot.approval?.blocks && snapshot.approval.blocks.length > 0) {
			controller.restoreTurnFromSnapshot(
				snapshot.approval.blocks.map((b) => {
					if (!b.dlineTid) {
						throw new Error("Canonical restored block is missing dlineTid")
					}
					return {
						dlineTid: b.dlineTid,
						functionId: b.functionId,
						toolName: b.name,
						phase: b.phase,
						conversationHistoryIndex: b.apiIndex,
						requiresApproval: true,
					}
				}),
				snapshot.approval.activeDlineTid,
			)
		}

		await this.ctx.postStateToWebview()
	}

	// ── Core: replay pending tools ──

	/**
	 * Replay pending tool_use blocks from apiConversationHistory.
	 * This is the core restore path. Converts stored blocks to runtime ToolUse,
	 * executes them via presentAssistantMessage, and continues the conversation.
	 */
	async replayPendingTools(pending: PendingToolUseState, options?: ReplayOptions): Promise<void> {
		const baseTs = options?.baseTs ?? Date.now()
		const runtimePairs = pending.toolUseBlocks.map((stored, idx) => ({
			stored,
			runtime: this.storedToRuntime(stored, baseTs + idx),
		}))

		const _runtimePairByToolUse = new Map(runtimePairs.map((p) => [p.runtime, p.stored]))
		const runtimeToolUses = orderTurnEndingContentBlocks(runtimePairs.map((p) => p.runtime))
		if (runtimeToolUses.length === 0) return

		const { taskState, controller } = this.ctx

		if (controller.phase !== TaskPhase.STREAMING) {
			await controller.transitionRequired(TaskPhase.STREAMING, {
				apiIndex: pending.assistantIndex,
				onSnapshot: undefined,
			})
		}
		taskState.currentStreamingContentIndex = 0
		taskState.assistantMessageContent = runtimeToolUses
		taskState.didCompleteReadingStream = true
		const restoredUserContent = [...pending.answeredToolResults]
		taskState.userMessageContent = restoredUserContent
		taskState.userMessageContentReady = false
		taskState.didAlreadyUseTool = false
		taskState.presentAssistantMessageLocked = false
		taskState.presentAssistantMessageHasPendingUpdates = false

		controller.reset()
		const admissions = new Map(runtimeToolUses.map((block) => [block.dline_tid, this.ctx.prepareAdmission(block)]))
		controller.buildTurn(runtimeToolUses, (_toolName, dlineTid) => {
			const admission = admissions.get(dlineTid)
			return (
				admission?.outcome === "admitted" &&
				(admission.decision.kind === "automatic" || admission.decision.kind === "none")
			)
		})

		controller.transitionRequired(TaskPhase.EXECUTING, {
			apiIndex: pending.assistantIndex,
			execution: {
				mode: "serial",
				executingFunctionIds: runtimeToolUses.map((tool) => tool.function_id),
				executingDlineTids: runtimeToolUses.map((tool) => tool.dline_tid),
			},
		})

		await this.ctx.messageStateHandler.overwriteApiConversationHistory(pending.sanitizedHistory)
		await this.ctx.postStateToWebview()
		await this.ctx.presentAssistantMessage()
		await this.ctx.recursivelyMakeClineRequests(restoredUserContent)
	}

	// ── Helpers ──

	/**
	 * Convert a stored tool-use block (from apiConversationHistory) to a runtime ToolUse.
	 * Handles MCP tool name prefixing and parameter stringification.
	 */
	storedToRuntime(block: ClineAssistantToolUseBlock, baseTs: number): ToolUse {
		if (!block.function_id || !block.dline_tid) {
			throw new Error(`Canonical stored tool block is missing identity: tool=${block.name}`)
		}
		const params: Record<string, string> = {}
		const input =
			typeof block.input === "string"
				? (() => {
						try {
							return JSON.parse(block.input)
						} catch {
							return block.input
						}
					})()
				: block.input

		if (input && typeof input === "object" && !Array.isArray(input)) {
			for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
				params[key] = typeof value === "string" ? value : JSON.stringify(value)
			}
		} else if (input !== undefined && input !== null) {
			params.input = typeof input === "string" ? input : JSON.stringify(input)
		}

		return {
			type: "tool_use",
			name: block.name as ClineDefaultTool,
			params: params as ToolUse["params"],
			partial: false,
			ts: baseTs,
			isNativeToolCall: true,
			function_id: block.function_id,
			dline_tid: block.dline_tid,
		} as ToolUse
	}

	/**
	 * Hydrate TaskPhaseMachine and BlockPhaseMachine from a persisted snapshot.
	 * This is used when loading a historical task to restore the exact state
	 * without replaying tools or re-inferring from messages.
	 */
	hydrateFromSnapshot(snapshot: TaskSnapshot): void {
		// Restore TaskPhaseMachine
		this.ctx.controller.restoreFrom(snapshot)

		// Restore BlockPhaseMachine if approval blocks exist
		if (snapshot.approval?.blocks && snapshot.approval.blocks.length > 0) {
			this.ctx.controller.restoreTurnFromSnapshot(
				snapshot.approval.blocks.map((block) => {
					if (!block.dlineTid) {
						throw new Error("Canonical restored block is missing dlineTid")
					}
					return {
						dlineTid: block.dlineTid,
						functionId: block.functionId,
						toolName: block.name,
						phase: block.phase,
						conversationHistoryIndex: block.apiIndex,
						ts: block.ts,
						requiresApproval: true,
					}
				}),
				snapshot.approval.activeDlineTid,
			)
		}
	}
}

// Re-export for convenience
import type { ClineUserToolResultContentBlock } from "@/shared/messages"

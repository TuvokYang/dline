import type { ImageBlockParam } from "@anthropic-ai/sdk/resources/messages"
import type { TargetWindowFittingState } from "@core/context/context-management/target-window-fitting"
import type { ContextWindowIndicatorSnapshot } from "@shared/context-window-indicator"
import type { ClineContent, ClineStorageMessage } from "@shared/messages/content"
import type { ClineAskResponse } from "@shared/WebviewMessage"
import type { HookExecution } from "../../types/HookExecution"

export interface ToolAttemptState {
	consecutiveMistakeCount: number
	doubleCheckCompletionPending: boolean
	lastToolName: string
	lastToolParams: string
	consecutiveIdenticalToolCount: number
	didAlreadyUseTool: boolean
	didEditFile: boolean
	resetMistakeLimitState(): void
}

export interface ToolConversationState {
	userMessageContent: ClineContent[]
	/** Assistant blocks retained for the current turn; restore clears them. */
	assistantMessageContent: unknown[]
	userMessageContentReady: boolean
	lastMessageTs?: number
	askResponseText?: string
	askResponseImages?: string[]
	askResponseFiles?: string[]
	checkpointManagerErrorMessage?: string
	apiRequestCount: number
	apiRequestsSinceLastTodoUpdate: number
	ackedFeedback?: {
		response: ClineAskResponse
		text?: string
		images?: string[]
		files?: string[]
	}
	isAwaitingPlanResponse: boolean
	didRespondToPlanAskBySwitchingMode: boolean
	currentFocusChainChecklist: string | null
	focusChainHistory: string | null
	focusChainRejectionMessage: string | null
	currentInProgressItemIndex: number | null
	todoListWasUpdatedByUser: boolean
	hasWarnedSkipOrder: boolean
	blockNextToolCalls: boolean
	conversationHistoryDeletedRange?: [number, number]
	deferredCurrentTurn?: {
		assistantMessage?: ClineStorageMessage
		userContent: ClineContent[]
		compactionContent: ClineContent[]
	}
}

export interface ToolOperationState {
	taskStartTimeMs: number
	taskFirstTokenTimeMs?: number
	abort: boolean
	didFinishAbortingStream: boolean
	contextWindowIndicator?: ContextWindowIndicatorSnapshot
	readonly operationSignal: AbortSignal
	resetOperationCancellation(): void
	cancelOperations(reason?: string): void
	isExecutingSubagent: boolean
	activeHookExecution?: HookExecution
	fileReadCache: Map<string, { readCount: number; mtime: number; imageBlock?: ImageBlockParam }>
	currentlySummarizing: boolean
	compactionFittingRequired: boolean
	lastAutoCompactTriggerIndex?: number
	isInternalContextCompactionRequest: boolean
	targetWindowFittingState?: TargetWindowFittingState
	contextCompactionMessageTs?: number
	pendingManualCompactionRegeneration?: {
		requestApiIndex: number
		operationId?: string
		text: string
		images: string[]
		files: string[]
	}
}

/** Mutable state used only by tool handlers; it is not a task lifecycle authority. */
export interface ToolHandlerState extends ToolAttemptState, ToolConversationState, ToolOperationState {}

/** Default task-scoped implementation owned by the production tool executor. */
export class DefaultToolHandlerState implements ToolHandlerState {
	taskStartTimeMs = Date.now()
	taskFirstTokenTimeMs?: number
	abort = false
	didFinishAbortingStream = false
	contextWindowIndicator?: ContextWindowIndicatorSnapshot
	consecutiveMistakeCount = 0
	doubleCheckCompletionPending = false
	lastToolName = ""
	lastToolParams = ""
	consecutiveIdenticalToolCount = 0
	didAlreadyUseTool = false
	didEditFile = false
	userMessageContent: ClineContent[] = []
	assistantMessageContent: unknown[] = []
	userMessageContentReady = false
	lastMessageTs?: number
	askResponseText?: string
	askResponseImages?: string[]
	askResponseFiles?: string[]
	checkpointManagerErrorMessage?: string
	apiRequestCount = 0
	apiRequestsSinceLastTodoUpdate = 0
	ackedFeedback?: ToolConversationState["ackedFeedback"]
	isAwaitingPlanResponse = false
	didRespondToPlanAskBySwitchingMode = false
	currentFocusChainChecklist: string | null = null
	focusChainHistory: string | null = null
	focusChainRejectionMessage: string | null = null
	currentInProgressItemIndex: number | null = null
	todoListWasUpdatedByUser = false
	hasWarnedSkipOrder = false
	blockNextToolCalls = false
	conversationHistoryDeletedRange?: [number, number]
	deferredCurrentTurn?: ToolConversationState["deferredCurrentTurn"]
	isExecutingSubagent = false
	activeHookExecution?: HookExecution
	fileReadCache = new Map<string, { readCount: number; mtime: number; imageBlock?: ImageBlockParam }>()
	currentlySummarizing = false
	compactionFittingRequired = false
	lastAutoCompactTriggerIndex?: number
	isInternalContextCompactionRequest = false
	targetWindowFittingState?: TargetWindowFittingState
	contextCompactionMessageTs?: number
	pendingManualCompactionRegeneration?: ToolOperationState["pendingManualCompactionRegeneration"]
	private operationController = new AbortController()

	get operationSignal(): AbortSignal {
		return this.operationController.signal
	}

	resetOperationCancellation(): void {
		if (this.operationController.signal.aborted) this.operationController = new AbortController()
	}

	cancelOperations(reason = "tool_operations_cancelled"): void {
		if (!this.operationController.signal.aborted) this.operationController.abort(new Error(reason))
	}

	resetMistakeLimitState(): void {
		this.consecutiveMistakeCount = 0
		this.consecutiveIdenticalToolCount = 0
		this.lastToolName = ""
		this.lastToolParams = ""
	}
}

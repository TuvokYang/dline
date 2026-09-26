import { Anthropic } from "@anthropic-ai/sdk"
import { AssistantMessageContent } from "@core/assistant-message"
import type { TargetWindowFittingState } from "@core/context/context-management/target-window-fitting"
import type { ContextWindowIndicatorSnapshot } from "@shared/context-window-indicator"
import { ClineAskResponse } from "@shared/WebviewMessage"
import type { ClineContent, ClineStorageMessage } from "@/shared/messages"
import type { PartialToolLifecycle } from "./partial-tool-lifecycle"
import type { HookExecution } from "./types/HookExecution"

export class TaskState {
	// Task-level timing
	taskStartTimeMs = Date.now()
	taskFirstTokenTimeMs?: number

	// Streaming flags
	isStreaming = false
	isWaitingForFirstChunk = false
	didCompleteReadingStream = false

	// Content processing
	currentStreamingContentIndex = 0
	assistantMessageContent: AssistantMessageContent[] = []
	userMessageContent: ClineContent[] = []
	userMessageContentReady = false

	// Presentation locks
	presentAssistantMessageLocked = false
	presentAssistantMessageHasPendingUpdates = false

	// Ask/Response handling
	askResponse?: ClineAskResponse
	askResponseText?: string
	askResponseImages?: string[]
	askResponseFiles?: string[]
	ackedFeedback?: {
		response: ClineAskResponse
		text?: string
		images?: string[]
		files?: string[]
	}
	lastMessageTs?: number

	// Plan mode specific state
	isAwaitingPlanResponse = false
	didRespondToPlanAskBySwitchingMode = false

	// Context and history
	conversationHistoryDeletedRange?: [number, number]
	/** Immutable mirror of the Task-owned authoritative context-window indicator. */
	contextWindowIndicator?: ContextWindowIndicatorSnapshot

	// Tool execution flags
	didAlreadyUseTool = false
	didEditFile = false
	lastToolName = "" // Track last tool used for consecutive call detection
	lastToolParams = "" // Canonical signature of last tool's params (via toolCallSignature)
	consecutiveIdenticalToolCount = 0 // Consecutive calls with identical tool name + params

	// File read deduplication cache - prevents the model from endlessly reading the same files
	// Maps absolute file path → { readCount: times read in this task, mtime: last modified timestamp, imageBlock: optional image data for multimodal models }
	fileReadCache: Map<string, { readCount: number; mtime: number; imageBlock?: Anthropic.ImageBlockParam }> = new Map()

	// Error tracking
	consecutiveMistakeCount = 0
	doubleCheckCompletionPending = false
	didAutomaticallyRetryFailedApiRequest = false
	checkpointManagerErrorMessage?: string

	// Retry tracking for auto-retry feature
	autoRetryAttempts = 0

	// Task Initialization
	isInitialized = false

	// Focus Chain / Todo List Management
	apiRequestCount = 0
	apiRequestsSinceLastTodoUpdate = 0
	currentFocusChainChecklist: string | null = null
	focusChainHistory: string | null = null
	focusChainRejectionMessage: string | null = null
	/** Index of the current unchecked item (0-based), projected in the separate CURRENT environment section. */
	currentInProgressItemIndex: number | null = null
	todoListWasUpdatedByUser = false
	hasWarnedSkipOrder = false
	/** Block the next round of tool calls when - [x] fabrication is detected */
	blockNextToolCalls = false

	// Task Abort / Cancellation
	abort = false
	didFinishAbortingStream = false
	abandoned = false
	private operationAbortController = new AbortController()

	/** Signal shared by cancellable task operations in the current continuation. */
	get operationSignal(): AbortSignal {
		return this.operationAbortController.signal
	}

	/** Start a fresh cancellation scope before admitting a new continuation. */
	resetOperationCancellation(): void {
		if (this.operationAbortController.signal.aborted) {
			this.operationAbortController = new AbortController()
		}
	}

	/** Cancel every task operation that belongs to the superseded continuation. */
	cancelOperations(reason = "task_cancelled"): void {
		if (!this.operationAbortController.signal.aborted) {
			this.operationAbortController.abort(new Error(reason))
		}
	}

	// Subagent execution tracking for cancel detection
	isExecutingSubagent = false

	// Hook execution tracking for cancellation
	activeHookExecution?: HookExecution

	// Auto-context summarization
	currentlySummarizing = false
	/** Continue compaction passes until the complete ordinary target candidate is strictly below its fitting exit target. */
	compactionFittingRequired = false
	/** In-memory rolling-merge stage; durable persistence is owned by CTX-004. */
	targetWindowFittingState?: TargetWindowFittingState
	/** Latest staged target candidate projection for the context-window indicator after each fitting Pass. */
	targetWindowFittingProjection?: {
		projectedUsageTokens: number
		targetContextWindow: number
		coveredTurnCount: number
		totalTurnCount: number
	}
	lastAutoCompactTriggerIndex?: number
	/** Skip one stale-usage auto-compaction check after a confirmed manual summary is durably committed. */
	manualCompactionCommitted = false
	/** Skip one stale-usage auto-compaction check after explicit history truncation is committed. */
	manualHistoryTruncationCommitted = false
	/** Expose the destructive history-truncation fallback only after terminal automatic compaction failure. */
	forceTruncateAvailable = false
	/** Skip one stale-usage auto-compaction check after a committed target-window fitting candidate admits its continuation. */
	targetWindowFittingCommitted = false
	/** Identify the active provider request as manual compaction so failure does not enter automatic retry. */
	isManualContextCompactionRequest = false
	isInternalContextCompactionRequest = false
	/** Stable chat row used across one compaction request and its retries. */
	contextCompactionMessageTs?: number
	/** User-authored content to admit after a confirmed manual compaction has committed. */
	pendingManualCompactionContinuation?: {
		text: string
		images: string[]
		files: string[]
	}
	/** Regenerate supersedes the completed manual summary turn before a fresh /compact request is admitted. */
	pendingManualCompactionRegeneration?: {
		requestApiIndex: number
		operationId?: string
		text: string
		images: string[]
		files: string[]
	}
	deferredCurrentTurn?: {
		assistantMessage?: ClineStorageMessage
		userContent: ClineContent[]
		compactionContent: ClineContent[]
	}

	// Block identity: maps source-offset keys to stable UI ts values.
	// Key format: "text:<startOffset>" or "tool:<openTagStart>".
	// Cleared at the start of each API turn to prevent cross-turn ts reuse.
	parseBlockTsByKey: Map<string, number> = new Map()
	/** Stable canonical identities for non-native tool blocks during one API turn. */
	parseToolIdentityByKey: Map<string, { function_id: string; dline_tid: string }> = new Map()

	// Content dedup: tracks the last rendered signature per ts to avoid
	// re-sending identical partial events to the frontend.
	lastRenderedPartialByTs: Map<number, string> = new Map()

	// Tool block lifecycle state machine. When a partial tool block advances
	// past the presentation index and later becomes non-partial (stream end),
	// the complete execution path must be replayed.  This map drives that
	// deferred execution so that every partial-shown tool eventually reaches
	// its handleCompleteBlock handler exactly once.
	//
	// States:
	//   partial-shown    – handlePartialBlock ran, awaiting final
	//   complete-running – final execution in progress (CAS guard)
	//   complete-done    – final execution completed
	// Cleared at stream reset to keep state turn-scoped.
	partialToolLifecycleByTs: Map<number, PartialToolLifecycle> = new Map()

	// Reasoning block ts — assigned once at the first reasoning delta
	// and reused for all partial/final reasoning messages in the turn.
	reasoningTs?: number

	/** Clear every detector that can stop the next provider request at the mistake-limit gate. */
	resetMistakeLimitState(): void {
		this.consecutiveMistakeCount = 0
		this.autoRetryAttempts = 0
		this.consecutiveIdenticalToolCount = 0
		this.lastToolName = ""
		this.lastToolParams = ""
	}
}

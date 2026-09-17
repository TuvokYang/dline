export type TaskActivityKind = "subagent" | "command"

export type TaskActivityExecutionMode = "foreground" | "background"

export type TaskActivityCancellationOwner = "task" | "explicit"

export type TaskActivityStatus =
	| "awaiting_approval"
	| "running"
	| "cancelling"
	| "completed"
	| "failed"
	| "timeout"
	| "cancelled"
	| "interrupted"

export interface TaskActivityMetrics {
	toolCalls?: number
	inputTokens?: number
	outputTokens?: number
	cacheWriteTokens?: number
	cacheReadTokens?: number
	cacheHitRate?: number
	totalCost?: number
	currency?: string
	contextTokens?: number
	contextWindow?: number
	lineCount?: number
}

export interface TaskActivityRuntimeConfig {
	profileName?: string
	providerId?: string
	modelId?: string
	apiFormat?: string
	thinkingEnabled?: boolean
	reasoningEffort?: string
	thinkingBudgetTokens?: number
}

export type TaskActivityEventPhase = "delta" | "final"

export type TaskActivityToolStatus = "started" | "completed" | "failed"

interface TaskActivityEventBase {
	sequence: number
	timestamp: number
	attempt: number
}

export type TaskActivityEvent =
	| (TaskActivityEventBase & {
			kind: "thinking" | "assistant_message"
			phase: TaskActivityEventPhase
			text: string
	  })
	| (TaskActivityEventBase & {
			kind: "tool_call"
			toolCallId: string
			toolName: string
			toolStatus: TaskActivityToolStatus
			summary?: string
			durationMs?: number
			error?: string
	  })
	| (TaskActivityEventBase & {
			kind: "tool_result"
			toolCallId: string
			toolName: string
			text?: string
			error?: string
	  })
	| (TaskActivityEventBase & {
			kind: "status"
			status: TaskActivityStatus
			text?: string
	  })
	| (TaskActivityEventBase & {
			kind: "metrics"
			metrics: TaskActivityMetrics
	  })
	| (TaskActivityEventBase & {
			kind: "output"
			text: string
	  })
	| (TaskActivityEventBase & {
			kind: "retry"
			retryAttempt: number
			maxRetries: number
			delayMs: number
			cumulativeDelayMs: number
	  })

export type TaskActivityEventInput = TaskActivityEvent extends infer Event
	? Event extends TaskActivityEventBase
		? Omit<Event, keyof TaskActivityEventBase>
		: never
	: never

export interface SubagentRetryRecipe {
	kind: "subagent"
	schemaVersion: 1
	subagentName?: string
	/**
	 * Profile the item was resolved to when it first ran.
	 *
	 * A batch item may override the subagent's own Profile, so replaying from
	 * the subagent name alone would silently retry on a different model. The
	 * resolved name is recorded here so a retry after a task reopen reproduces
	 * the original binding.
	 */
	profileName?: string
	task: string
	prompt: string
	timeoutSeconds: number
	retryable: boolean
}

export interface TaskActivityRecord {
	schemaVersion: 2
	activityId: string
	taskId: string
	kind: TaskActivityKind
	executionMode: TaskActivityExecutionMode
	cancellationOwner: TaskActivityCancellationOwner
	status: TaskActivityStatus
	currentAttempt: number
	createdAt: number
	updatedAt: number
	finishedAt?: number
	title: string
	detail?: string
	latestEvent?: string
	timeoutSeconds?: number
	output?: string
	result?: string
	error?: string
	logPath?: string
	parentActivityId?: string
	runtime?: TaskActivityRuntimeConfig
	metrics?: TaskActivityMetrics
	retryRecipe?: SubagentRetryRecipe
	retryUnavailableReason?: string
	events: TaskActivityEvent[]
}

export interface TaskActivityUpdate {
	sequence: number
	snapshot: boolean
	activities: TaskActivityRecord[]
}

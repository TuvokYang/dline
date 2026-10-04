import type { TaskFileTracker } from "@integrations/checkpoints/TaskFileTracker"
import type { ICheckpointManager } from "@integrations/checkpoints/types"
import type { CommandExecutor } from "@integrations/terminal/CommandExecutor"
import type { BrowserSession } from "@services/browser/BrowserSession"
import type { TaskActivityStore } from "../activity/TaskActivityStore"
import type { CompactionRecoveryPort } from "../compaction/CompactionRecovery"
import type { CompactionRequestScopes } from "../compaction/CompactionRequestScopes"
import type { ProviderRetryGate } from "../executors/provider/service/ProviderRetryGate"
import type { MessageStateHandler } from "../message-state"
import type { ApiRateSnapshot } from "../performance/api-rate-tracker"
import type { TaskRateMetricsQuery, TaskRateMetricsQueryResult } from "../performance/task-rate-metrics-types"
import type { TaskPromptLifecycle } from "../prompt/TaskPromptLifecycle"
import type { PromptCacheHealthTracker } from "../prompt-cache/PromptCacheHealthTracker"
import type { TaskStateManager } from "../TaskStateManager"
import type { DefaultToolHandlerState } from "../tools/state/ToolHandlerState"
import type { PresentationIdSequence } from "./PresentationIdSequence"
import type { TaskApiHandlerOwner } from "./TaskApiHandlerOwner"
import type { TaskInteractionOwner } from "./TaskInteractionOwner"
import type { TaskToolExecutionOwner } from "./TaskToolExecutionOwner"

export interface TaskSessionIdentity {
	readonly taskId: string
	readonly taskIncarnationId: string
}

/** Host-facing owners grouped by domain; none expands the six-use-case Task facade. */
export interface TaskSessionOwners {
	readonly identity: TaskSessionIdentity
	readonly settings: TaskStateManager
	readonly messages: MessageStateHandler
	readonly activities: TaskActivityStore
	readonly api: TaskApiHandlerOwner
	readonly prompt: TaskPromptLifecycle
	readonly promptCache: PromptCacheHealthTracker
	readonly toolState: DefaultToolHandlerState
	readonly toolExecution: TaskToolExecutionOwner
	readonly interactions: TaskInteractionOwner
	readonly browser: BrowserSession
	readonly commands: CommandExecutor
	/** Files this task incarnation modified; also the checkpoint staging scope. */
	readonly files: TaskFileTracker
	readonly checkpoints?: ICheckpointManager
	readonly apiRateSnapshot?: () => ApiRateSnapshot
	readonly queryRateMetrics?: (query: TaskRateMetricsQuery) => Promise<TaskRateMetricsQueryResult>
	/** The session's single chat-row id sequence; a host that adds a row must draw from it to keep causal order. */
	readonly nextPresentationId?: PresentationIdSequence
	/** Handlers a compaction run is sent under instead of the task's own; absent means every run uses the task's handler. */
	readonly compactionScopes?: CompactionRequestScopes
	/** What a failed automatic compaction leaves the user to do; absent means no truncation is ever offered. */
	readonly compactionRecovery?: CompactionRecoveryPort
	/** The automatic retry countdown of the provider request, which a manual Retry may cut short. */
	readonly providerRetry?: ProviderRetryGate
}

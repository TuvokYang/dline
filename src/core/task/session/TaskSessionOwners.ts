import type { TaskFileTracker } from "@integrations/checkpoints/TaskFileTracker"
import type { ICheckpointManager } from "@integrations/checkpoints/types"
import type { CommandExecutor } from "@integrations/terminal/CommandExecutor"
import type { BrowserSession } from "@services/browser/BrowserSession"
import type { TaskActivityStore } from "../activity/TaskActivityStore"
import type { TaskInputQueueService } from "../input-queue/TaskInputQueueService"
import type { MessageStateHandler } from "../message-state"
import type { ApiRateSnapshot } from "../performance/api-rate-tracker"
import type { TaskRateMetricsQuery, TaskRateMetricsQueryResult } from "../performance/task-rate-metrics-types"
import type { TaskPromptLifecycle } from "../prompt/TaskPromptLifecycle"
import type { PromptCacheHealthTracker } from "../prompt-cache/PromptCacheHealthTracker"
import type { TaskStateManager } from "../TaskStateManager"
import type { DefaultToolHandlerState } from "../tools/state/ToolHandlerState"
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
	readonly inputQueue?: TaskInputQueueService
}

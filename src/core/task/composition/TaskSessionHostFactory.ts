import type { ICheckpointManager } from "@integrations/checkpoints/types"
import type { CommandExecutor } from "@integrations/terminal/CommandExecutor"
import type { ITerminalManager } from "@integrations/terminal/types"
import type { BrowserSession } from "@services/browser/BrowserSession"
import type { ClineExtensionContext } from "@shared/cline/context"
import type { TaskActivityStore } from "../activity/TaskActivityStore"
import type { ProductionCompactionService } from "../executors/compaction/ProductionCompactionAdapter"
import type { SpawnChildLauncher } from "../executors/spawn/ProductionSpawnAdapter"
import type { ToolDomainSurface } from "../executors/tool/ToolDomainSurface"
import type { TaskInputQueueService } from "../input-queue/TaskInputQueueService"
import type { TaskState } from "../kernel"
import type { MessageStateHandler } from "../message-state"
import type { ApiRateSnapshot } from "../performance/api-rate-tracker"
import type { ProviderRequestRoundPort } from "../performance/provider-request-round-port"
import type { TaskRateMetricsQuery, TaskRateMetricsQueryResult } from "../performance/task-rate-metrics-types"
import type { TaskPromptLifecycle } from "../prompt/TaskPromptLifecycle"
import type { PromptCacheHealthTracker } from "../prompt-cache/PromptCacheHealthTracker"
import type { TaskApiHandlerOwner } from "../session/TaskApiHandlerOwner"
import type { TaskInteractionOwner } from "../session/TaskInteractionOwner"
import type { TaskStateManager } from "../TaskStateManager"
import type { DefaultToolHandlerState } from "../tools/state/ToolHandlerState"
import type { TaskCallbacks, TaskServices } from "../tools/types/TaskConfig"

export interface TaskSessionHostContext {
	readonly taskId: string
	readonly taskIncarnationId: string
	readonly cwd: string
	readonly settings: TaskStateManager
	readonly messages: MessageStateHandler
	readonly activities: TaskActivityStore
	readonly api: TaskApiHandlerOwner
	readonly prompt: TaskPromptLifecycle
	readonly promptCache: PromptCacheHealthTracker
	readonly toolState: DefaultToolHandlerState
	readonly interactions: TaskInteractionOwner
	readonly readState: () => Readonly<TaskState>
}

export interface TaskSessionHostResources {
	readonly services: TaskServices
	readonly callbacks: TaskCallbacks
	readonly browser: BrowserSession
	readonly commands: CommandExecutor
	/** Terminal registry behind `commands`; the environment lists its active terminals. */
	readonly terminals?: ITerminalManager
	readonly checkpoints?: ICheckpointManager
	readonly surface: ToolDomainSurface
	readonly compaction: ProductionCompactionService
	readonly spawn: SpawnChildLauncher
	readonly providerRequestRounds?: ProviderRequestRoundPort
	readonly controllerContext?: ClineExtensionContext
	readonly inputQueue?: TaskInputQueueService
	readonly apiRateSnapshot?: () => ApiRateSnapshot
	readonly queryRateMetrics?: (query: TaskRateMetricsQuery) => Promise<TaskRateMetricsQueryResult>
	readonly releases?: readonly { release(): Promise<void> }[]
}

/** Builds host-owned resources only after canonical task owners exist. */
export interface TaskSessionHostFactory {
	create(context: TaskSessionHostContext): Promise<TaskSessionHostResources>
}

import path from "node:path"
import { createIdentityFactory } from "@core/api/transform/block-identity"
import type { ToolUse } from "@core/assistant-message"
import type { StateManager } from "@core/storage/StateManager"
import { isMultiRootEnabled } from "@core/workspace/multi-root-utils"
import type { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import type { ClineExtensionContext } from "@shared/cline/context"
import { resolveMaxParallelSubagents } from "@shared/concurrency-limits"
import type { TaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import { ClineDefaultTool } from "@shared/tools"
import type { TaskActivityStore } from "../activity/TaskActivityStore"
import type {
	ProductionToolConfigFactory,
	ProductionToolConfigFactoryInput,
} from "../executors/tool/production/DefaultProductionToolExecutionService"
import type { ProductionToolHandlerRuntime } from "../executors/tool/production/ProductionToolHandlerRuntime"
import type { ToolAdmissionSnapshot } from "../executors/tool/ToolAdmissionRegistry"
import type { ToolBlockStatePort } from "../executors/tool/ToolBlockStatePort"
import { TurnToolScheduler } from "../executors/tool/TurnToolScheduler"
import type { TaskState } from "../kernel"
import type { MessageStateHandler } from "../message-state"
import type { ProviderRequestRoundPort } from "../performance/provider-request-round-port"
import { createRequestApiScope } from "../RequestApiScope"
import type { TaskStateManager } from "../TaskStateManager"
import type { DefaultToolHandlerState } from "../tools/state/ToolHandlerState"
import { SubagentFanoutBudget, usableSubagentLimit } from "../tools/subagent/SubagentFanoutBudget"
import { SubagentJobManager } from "../tools/subagent/SubagentJobManager"
import type { TaskCallbacks, TaskConfig, TaskInteractionPorts, TaskServices } from "../tools/types/TaskConfig"
import type { TaskApiHandlerOwner } from "./TaskApiHandlerOwner"

export interface TaskToolExecutionOwnerOptions {
	readonly taskId: string
	readonly taskIncarnationId: string
	readonly cwd: string
	readonly stateManager: StateManager
	readonly settings: TaskStateManager
	readonly messages: MessageStateHandler
	readonly activities: TaskActivityStore
	readonly api: TaskApiHandlerOwner
	readonly toolState: DefaultToolHandlerState
	readonly services: TaskServices
	readonly interactions: TaskInteractionPorts
	readonly callbacks: TaskCallbacks
	readonly readState: () => Readonly<TaskState>
	readonly readCapabilityToggles: () => TaskCapabilityToggles
	readonly workspaceManager?: WorkspaceRootManager
	readonly providerRequestRounds?: ProviderRequestRoundPort
	readonly controllerContext?: ClineExtensionContext
	readonly terminalExecutionMode: "vscodeTerminal" | "backgroundExec"
	readonly toolRuntime: ProductionToolHandlerRuntime
}

/** Builds request-scoped handler configuration without depending on the legacy ToolExecutor. */
export class TaskToolExecutionOwner implements ProductionToolConfigFactory {
	private readonly identities = createIdentityFactory()
	private readonly blockState: ToolBlockStatePort
	/**
	 * Task-scoped subagent concurrency allowance.
	 *
	 * Held by the owner rather than by one request-scoped config so nested and
	 * successive fan-outs compete for the single user-configured limit instead
	 * of receiving a fresh allowance per provider request.
	 */
	private readonly subagentFanoutBudget: SubagentFanoutBudget
	/** Task-scoped background subagent jobs, kept alive across provider requests. */
	private readonly subagentJobManager = new SubagentJobManager()
	/**
	 * Task-scoped WS-072 tool scheduler.
	 *
	 * Owned here, beside the subagent budget, so a `maxParallelToolCalls`
	 * change reaches the turn that is currently queued instead of only the
	 * next task.
	 */
	readonly turnScheduler: TurnToolScheduler

	constructor(private readonly options: TaskToolExecutionOwnerOptions) {
		this.turnScheduler = new TurnToolScheduler({
			readConfiguredLimit: () => this.options.stateManager.getGlobalSettingsKey("maxParallelToolCalls"),
		})
		this.blockState = {
			wasRejected: (blockId) => this.blockPhase(blockId) === "rejected",
			isAwaitingApproval: (blockId) => this.blockPhase(blockId) === "awaiting_approval",
			hasAnyRejection: () => this.options.readState().turn.blocks.some((block) => block.phase === "rejected"),
		}
		this.subagentFanoutBudget = new SubagentFanoutBudget({
			limit: () =>
				usableSubagentLimit(
					resolveMaxParallelSubagents(this.options.stateManager.getGlobalSettingsKey("maxParallelSubagents")),
				),
		})
	}

	/** Re-run subagent admission after the configured limit changed. */
	notifySubagentConcurrencyLimitChanged(): void {
		this.subagentFanoutBudget.notifyLimitChanged()
	}

	/** Re-run tool admission for the active turn after the configured ceiling changed. */
	notifyToolConcurrencyLimitChanged(): void {
		this.turnScheduler.notifyLimitChanged()
	}

	/** Task-scoped background subagent jobs, exposed for environment projection. */
	getSubagentJobManager(): SubagentJobManager {
		return this.subagentJobManager
	}

	/** Rebind one persisted failed subagent activity to a fresh runner after reopen. */
	restoreSubagentActivityRetry(activityId: string): Promise<boolean> {
		const runtime = this.options.toolRuntime
		return runtime.restoreSubagentRetry(this.create({ coordinator: runtime.coordinator }), activityId)
	}

	/**
	 * Build one request-scoped handler configuration.
	 *
	 * Only the coordinator is required because every other value is owned by
	 * the task, which lets retry and recovery paths reuse the same contract
	 * without inventing a synthetic tool command.
	 */
	create(input: Pick<ProductionToolConfigFactoryInput, "coordinator">): TaskConfig {
		const api = this.options.api.current()
		const mode = this.options.settings.mode
		const requestScope = createRequestApiScope(
			api,
			mode,
			this.options.stateManager.getGlobalSettingsKey("customPrompt"),
			this.options.stateManager.getGlobalSettingsKey("clineWebToolsEnabled") === true,
			undefined,
			this.options.stateManager.getCanonicalSettingsKey("imageGenerationEnabled") === true,
		)
		return {
			taskId: this.options.taskId,
			ulid: this.options.taskIncarnationId,
			cwd: this.options.cwd,
			mode,
			strictPlanModeEnabled: this.options.stateManager.getGlobalSettingsKey("strictPlanModeEnabled"),
			yoloModeToggled: this.options.stateManager.getGlobalSettingsKey("yoloModeToggled"),
			doubleCheckCompletionEnabled: this.options.stateManager.getGlobalSettingsKey("doubleCheckCompletionEnabled"),
			vscodeTerminalExecutionMode: this.options.terminalExecutionMode,
			enableParallelToolCalling: this.options.stateManager.getGlobalSettingsKey("enableParallelToolCalling") === true,
			isSubagentExecution: false,
			webToolsEnabled: requestScope.webToolsEnabled,
			subagentsEnabled: this.options.stateManager.getGlobalSettingsKey("subagentsEnabled") === true,
			webSearchRoutingPlan: requestScope.webSearchRoutingPlan,
			workspaceManager: this.options.workspaceManager,
			isMultiRootEnabled: isMultiRootEnabled(this.options.stateManager),
			taskState: this.options.toolState,
			blockState: this.blockState,
			messageState: this.options.messages,
			api,
			services: this.options.services,
			autoApprovalSettings: this.options.stateManager.getGlobalSettingsKey("autoApprovalSettings"),
			browserSettings: this.options.stateManager.getGlobalSettingsKey("browserSettings"),
			focusChainSettings: this.options.stateManager.getGlobalSettingsKey("focusChainSettings"),
			capabilityToggles: this.options.readCapabilityToggles(),
			interactions: this.options.interactions,
			callbacks: this.options.callbacks,
			coordinator: input.coordinator,
			identityFactory: this.identities,
			activityStore: this.options.activities,
			providerRequestRounds: this.options.providerRequestRounds,
			controllerContext: this.options.controllerContext,
			subagentJobManager: this.subagentJobManager,
			subagentFanoutBudget: this.subagentFanoutBudget,
		}
	}

	readAdmissionSnapshot(block: ToolUse): ToolAdmissionSnapshot {
		const workspaceRoots = this.options.workspaceManager?.getRoots()
		const mcpToolAutoApprove =
			block.name === ClineDefaultTool.MCP_USE
				? this.options.services.mcpHub.connections
						?.find((connection) => connection.server.name === block.params.server_name)
						?.server.tools?.find((tool) => tool.name === block.params.tool_name)?.autoApprove === true
				: undefined
		return {
			taskId: this.options.taskId,
			cwd: this.options.cwd,
			workspaceRoots: workspaceRoots?.map((root) => root.path) ?? [this.options.cwd],
			workspaceRootEntries: workspaceRoots?.map((root) => ({
				name: root.name || path.basename(root.path),
				path: root.path,
			})),
			primaryWorkspaceRoot: this.options.workspaceManager?.getPrimaryRoot()?.path,
			isMultiRootEnabled: isMultiRootEnabled(this.options.stateManager),
			settings: this.options.stateManager.getGlobalSettingsKey("autoApprovalSettings"),
			blanket: {
				yoloMode: this.options.stateManager.getGlobalSettingsKey("yoloModeToggled") === true,
				approveAll: this.options.stateManager.getGlobalSettingsKey("autoApproveAllToggled") === true,
			},
			mcpToolAutoApprove,
		}
	}

	private blockPhase(blockId: string) {
		return this.options.readState().turn.blocks.find((block) => block.blockId === blockId)?.phase
	}
}

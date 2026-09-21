import path from "node:path"
import type { ApiHandler } from "@core/api"
import { readContextTokens } from "@core/context/context-management/context-pressure"
import { getContextWindowInfo } from "@core/context/context-management/context-window-utils"
import type { FileContextTracker, RecentlyModifiedFilesSnapshot } from "@core/context/context-tracking/FileContextTracker"
import type { IgnoreController } from "@core/ignore/IgnoreController"
import { OrchestratorController } from "@core/orchestrator/OrchestratorController"
import { PromptProfile } from "@core/prompts/profiles/types"
import { formatResponse } from "@core/prompts/responses"
import { buildActiveTasksSection } from "@core/task/active-tasks/ActiveTaskContextProvider"
import {
	type BackgroundSubagentProvider,
	buildTaskBackgroundEnvironmentSection,
} from "@core/task/background/BackgroundContextInjector"
import { detectAvailableCliTools } from "@core/task/cli-tool-detector"
import { showContextUsage } from "@core/task/environment-context"
import { formatFocusChainTaskProgressSection } from "@core/task/focus-chain/file-utils"
import type { MessageStateHandler } from "@core/task/message-state"
import type { DefaultToolHandlerState } from "@core/task/tools/state/ToolHandlerState"
import { isMultiRootEnabled } from "@core/workspace/multi-root-utils"
import type { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import type { TaskFileTracker } from "@integrations/checkpoints/TaskFileTracker"
import type { ITerminalManager } from "@integrations/terminal/types"
import { listFiles } from "@services/glob/list-files"
import { findLast } from "@shared/array"
import { combineApiRequests } from "@shared/combineApiRequests"
import { combineCommandSequences } from "@shared/combineCommandSequences"
import { resolvePromptProfile } from "@shared/resolve-prompt-profile"
import type { Mode } from "@shared/storage/types"
import { arePathsEqual, getDesktopDir } from "@utils/path"
import { filterExistingFiles } from "@utils/tabFiltering"
import { HostProvider } from "@/hosts/host-provider"
import type { CommandExecutor } from "@/integrations/terminal"
import type { StateManager } from "../../storage/StateManager"

interface EnvironmentIdentity {
	readonly taskId: string
	readonly cwd: string
}

interface EnvironmentWorkspace {
	readonly stateManager: StateManager
	readonly manager?: WorkspaceRootManager
	readonly ignoreController: IgnoreController
}

interface EnvironmentRuntime {
	readonly getApi: () => ApiHandler
	readonly getMode: () => Mode
	readonly getPhase: () => string
}

/** The handler-state fields the environment reads or resets per request. */
export type EnvironmentHandlerState = Pick<
	DefaultToolHandlerState,
	"didEditFile" | "currentFocusChainChecklist" | "currentInProgressItemIndex"
>

interface EnvironmentConversation {
	readonly messages: MessageStateHandler
	readonly taskState: EnvironmentHandlerState
}

interface EnvironmentExecution {
	readonly terminals: ITerminalManager
	readonly tools: BackgroundSubagentProvider
	readonly commands: CommandExecutor
}

interface EnvironmentTracking {
	readonly files: FileContextTracker
	readonly taskFiles: TaskFileTracker
}

export interface TaskEnvironmentProjectionOptions {
	readonly identity: EnvironmentIdentity
	readonly workspace: EnvironmentWorkspace
	readonly runtime: EnvironmentRuntime
	readonly conversation: EnvironmentConversation
	readonly execution: EnvironmentExecution
	readonly tracking: EnvironmentTracking
}

export interface EnvironmentDetailsOptions {
	readonly preview?: boolean
	readonly api?: ApiHandler
	readonly mode?: Mode
}

/** Builds environment details and owns the dynamic snapshots represented in the next request. */
export class TaskEnvironmentProjection {
	private pendingCommandLineCounts?: Array<{ id: string; lineCount: number }>
	private pendingRecentlyModifiedFiles?: RecentlyModifiedFilesSnapshot

	constructor(private readonly options: TaskEnvironmentProjectionOptions) {}

	getActiveTaskSummary(): string {
		const taskMessage = this.options.conversation.messages.clineMessages.find((message) => message.say === "task")
		return taskMessage?.text ?? ""
	}

	getActiveTaskPhase(): string {
		return this.options.runtime.getPhase()
	}

	getActiveTaskEditedFiles(): string[] {
		return this.options.tracking.taskFiles.getAllModifiedFiles()
	}

	acknowledgeRequestSnapshots(): void {
		if (this.pendingRecentlyModifiedFiles) {
			this.options.tracking.files.acknowledgeRecentlyModifiedFiles(this.pendingRecentlyModifiedFiles)
			this.pendingRecentlyModifiedFiles = undefined
		}
		if (this.pendingCommandLineCounts) {
			this.options.execution.commands.markBackgroundCommandOutputSent(this.pendingCommandLineCounts)
			this.pendingCommandLineCounts = undefined
		}
	}

	async build(
		includeFileDetails = false,
		requestPromptProfile?: PromptProfile,
		buildOptions: EnvironmentDetailsOptions = {},
	): Promise<string> {
		const host = await HostProvider.env.getHostVersion({})
		const effectiveApi = buildOptions.api ?? this.options.runtime.getApi()
		const effectiveMode = buildOptions.mode ?? this.options.runtime.getMode()
		const platform = host.platform || "Unknown"
		let details = `# Dline Version\n${host.clineVersion || "unknown"}`
		details += this.formatWorkspaceRootsSection()
		details += await this.visibleFilesSection(platform)
		details += await this.openTabsSection(platform)
		details += this.activeTasksSection()
		details += this.terminalSection(buildOptions.preview === true)
		details += this.backgroundSection(buildOptions.preview === true)
		details += this.recentlyModifiedFilesSection(buildOptions.preview === true)
		details += currentTimeSection()
		if (includeFileDetails) details += await this.fileDetailsSection()
		details += this.contextUsageSection(effectiveApi)
		details += this.modeSection(effectiveMode)
		details += this.focusChainSection(effectiveApi, effectiveMode, requestPromptProfile)
		return `<environment_details>\n${details.trim()}\n</environment_details>`
	}

	private formatWorkspaceRootsSection(): string {
		const roots = this.options.workspace.manager?.getRoots() ?? []
		if (!isMultiRootEnabled(this.options.workspace.stateManager) || roots.length <= 1) return ""
		let section = "\n\n# Workspace Roots"
		for (const root of roots) {
			const name = root.name || path.basename(root.path)
			section += `\n- ${name}: ${root.path}${root.vcs ? ` (${String(root.vcs)})` : ""}`
		}
		return `${section}\n\nPrimary workspace: ${this.getPrimaryWorkspaceName()}`
	}

	getPrimaryWorkspaceName(): string {
		const primary = this.options.workspace.manager?.getPrimaryRoot()
		return primary?.name || (primary?.path ? path.basename(primary.path) : path.basename(this.options.identity.cwd))
	}

	private async visibleFilesSection(platform: string): Promise<string> {
		const raw = (await HostProvider.window.getVisibleTabs({})).paths
		return this.pathSection(platform, "Visible Files", raw)
	}

	private async openTabsSection(platform: string): Promise<string> {
		const raw = (await HostProvider.window.getOpenTabs({})).paths
		return this.pathSection(platform, "Open Tabs", raw)
	}

	private async pathSection(platform: string, title: string, rawPaths: readonly string[]): Promise<string> {
		const filtered = await filterExistingFiles(rawPaths as string[])
		const relative = filtered.map((absolutePath) => path.relative(this.options.identity.cwd, absolutePath))
		const allowed = this.options.workspace.ignoreController
			.filterPaths(relative)
			.map((entry) => entry.toPosix())
			.join("\n")
		return `\n\n# ${platform} ${title}\n${allowed || `(No ${title.toLowerCase()})`}`
	}

	private activeTasksSection(): string {
		if (this.options.workspace.stateManager.getGlobalSettingsKey("showActiveTasksInEnvDetails") === false) return ""
		const section = buildActiveTasksSection({
			controllers: OrchestratorController.getInstance().getActiveControllers(),
			currentCwd: this.options.identity.cwd,
			excludeTaskId: this.options.identity.taskId,
		})
		return section ? `\n\n${section}` : ""
	}

	private terminalSection(preview: boolean): string {
		if (!preview) this.options.conversation.taskState.didEditFile = false
		const terminals = this.options.execution.terminals.getTerminals(true)
		if (terminals.length === 0) return ""
		return `\n\n# Actively Running Terminals${terminals.map((terminal) => `\n- ${terminal.id}: running - \`${terminal.lastCommand}\``).join("")}`
	}

	private backgroundSection(preview: boolean): string {
		const projection = buildTaskBackgroundEnvironmentSection(this.options.execution.tools, this.options.execution.commands)
		if (!preview) this.pendingCommandLineCounts = projection.commandLineCounts
		return projection.text ? `\n\n${projection.text}` : ""
	}

	private recentlyModifiedFilesSection(preview: boolean): string {
		const snapshot = this.options.tracking.files.peekRecentlyModifiedFiles()
		if (!preview) this.pendingRecentlyModifiedFiles = snapshot
		if (snapshot.files.length === 0) return ""
		return `\n\n# Recently Modified Files\nThese files have been modified since you last accessed them (file was just edited so you may need to re-read it before editing):${snapshot.files.map((file) => `\n${file}`).join("")}`
	}

	private async fileDetailsSection(): Promise<string> {
		let details = this.formatFileDetailsHeader()
		if (arePathsEqual(this.options.identity.cwd, getDesktopDir())) {
			details += "(Desktop files not shown automatically. Use list_files to explore if needed.)"
		} else {
			const [fileInfos, didHitLimit] = await listFiles(this.options.identity.cwd, true, 200, {
				ignoreController: this.options.workspace.ignoreController,
			})
			details += formatResponse.formatFilesList(
				this.options.identity.cwd,
				fileInfos,
				didHitLimit,
				this.options.workspace.ignoreController,
			)
		}
		const workspacesJson = await this.options.workspace.manager?.buildWorkspacesJson()
		if (workspacesJson) details += `\n\n# Workspace Configuration\n${workspacesJson}`
		const cliTools = await detectAvailableCliTools()
		if (cliTools.length > 0) {
			details += `\n\n# Detected CLI Tools\nThese are some of the tools on the user's machine, and may be useful if needed to accomplish the task: ${cliTools.join(", ")}. This list is not exhaustive, and other tools may be available.`
		}
		return details
	}

	private formatFileDetailsHeader(): string {
		const roots = this.options.workspace.manager?.getRoots() ?? []
		if (isMultiRootEnabled(this.options.workspace.stateManager) && roots.length > 1) {
			const primaryName = this.getPrimaryWorkspaceName()
			return `\n\n# Current Working Directory (Primary: ${primaryName}) Files\n`
		}
		return `\n\n# Current Working Directory (${this.options.identity.cwd.toPosix()}) Files\n`
	}

	private contextUsageSection(api: ApiHandler): string {
		const { contextWindow } = getContextWindowInfo(api)
		const messages = combineApiRequests(combineCommandSequences(this.options.conversation.messages.clineMessages.slice(1)))
		const last = findLast(messages, (message) => message.say === "api_req_started" && readContextTokens(message.text) > 0)
		const used = last ? readContextTokens(last.text) : 0
		if (!showContextUsage({ contextWindow, lastApiReqTotalTokens: used, modelId: api.getModel().id })) return ""
		let section = `\n\n# Context Window Usage\n${used.toLocaleString()} / ${(contextWindow / 1000).toLocaleString()}K tokens used (${Math.round((used / contextWindow) * 100)}%)`
		if (this.options.workspace.stateManager.getGlobalSettingsKey("useAutoCondense")) {
			section += "\n\nAuto-Compact is enabled. Context will be automatically compacted as needed."
		}
		return section
	}

	private modeSection(mode: Mode): string {
		return mode === "plan"
			? `\n\n# Current Mode\nPLAN MODE\n${formatResponse.planModeInstructions()}`
			: "\n\n# Current Mode\nACT MODE"
	}

	private focusChainSection(api: ApiHandler, mode: Mode, requested?: PromptProfile): string {
		const settings = this.options.workspace.stateManager.getGlobalSettingsKey("focusChainSettings")
		const profile =
			requested ??
			resolvePromptProfile({ modelId: api.getModel().id, contextWindow: api.getModel().info.capabilities?.contextWindow })
		const taskState = this.options.conversation.taskState
		if (profile !== PromptProfile.Standard || !settings?.enabled || !taskState.currentFocusChainChecklist) return ""
		return `\n\n${formatFocusChainTaskProgressSection(taskState.currentFocusChainChecklist, taskState.currentInProgressItemIndex)}`
	}
}

function currentTimeSection(): string {
	const now = new Date()
	const formatter = new Intl.DateTimeFormat(undefined, {
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		second: "numeric",
		hour12: true,
	})
	const timeZone = formatter.resolvedOptions().timeZone
	const offset = -now.getTimezoneOffset() / 60
	return `\n\n# Current Time\n${formatter.format(now)} (${timeZone}, UTC${offset >= 0 ? "+" : ""}${offset}:00)`
}

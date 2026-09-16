import { isTaskReadScopePath } from "@core/artifacts/runtime"
import { resolveWorkspacePath } from "@core/workspace"
import { isMultiRootEnabled } from "@core/workspace/multi-root-utils"
import type { ApprovalCeilingSetting, ConfigurablePermissionScope } from "@shared/AutoApprovalSettings"
import { ClineDefaultTool, CONVERSATIONAL_TOOL_NAMES } from "@shared/tools"

/**
 * Tools whose approval is a pair: the in-workspace case and the external case.
 *
 * Each element is clamped by its own scope, because "never outside the project"
 * must be expressible without also disabling the in-project case.
 */
const PAIRED_SCOPES: Partial<
	Record<ClineDefaultTool, { local: ConfigurablePermissionScope; external: ConfigurablePermissionScope }>
> = {
	[ClineDefaultTool.FILE_READ]: { local: "read_workspace", external: "read_external" },
	[ClineDefaultTool.LIST_FILES]: { local: "read_workspace", external: "read_external" },
	[ClineDefaultTool.LIST_CODE_DEF]: { local: "read_workspace", external: "read_external" },
	[ClineDefaultTool.SEARCH]: { local: "read_workspace", external: "read_external" },
	[ClineDefaultTool.USE_SUBAGENT]: { local: "subagent", external: "subagent" },
	[ClineDefaultTool.USE_SUBAGENTS]: { local: "subagent", external: "subagent" },
	[ClineDefaultTool.NEW_RULE]: { local: "edit_workspace", external: "edit_external" },
	[ClineDefaultTool.FILE_NEW]: { local: "edit_workspace", external: "edit_external" },
	[ClineDefaultTool.FILE_EDIT]: { local: "edit_workspace", external: "edit_external" },
	[ClineDefaultTool.APPLY_PATCH]: { local: "edit_workspace", external: "edit_external" },
	// The command pair is safe-vs-all rather than inside-vs-outside. A ceiling
	// therefore constrains only which of those two classes may be automated; it
	// inspects no command text and makes no claim about what a command reaches.
	[ClineDefaultTool.BASH]: { local: "command_safe", external: "command_all" },
}

/** Tools governed by a single scope. */
const SINGLE_SCOPES: Partial<Record<ClineDefaultTool, ConfigurablePermissionScope>> = {
	[ClineDefaultTool.BROWSER]: "browser",
	[ClineDefaultTool.WEB_FETCH]: "web",
	[ClineDefaultTool.WEB_SEARCH]: "web",
	[ClineDefaultTool.MCP_ACCESS]: "mcp",
	[ClineDefaultTool.MCP_USE]: "mcp",
	[ClineDefaultTool.GENERATE_IMAGE]: "generate_image",
	[ClineDefaultTool.TODO]: "focus_chain",
	[ClineDefaultTool.CHANGE_TODO_LIST]: "focus_chain",
}

import { StateManager } from "@/core/storage/StateManager"
import { HostProvider } from "@/hosts/host-provider"
import { DlineRuntimeFileManager } from "@/services/runtime-files/DlineRuntimeFileManager"
import { getDesktopDir, isLocatedInPath, isLocatedInWorkspace } from "@/utils/path"

export class AutoApprove {
	private stateManager: StateManager
	private readonly taskId?: string
	// Cache for workspace paths - populated on first access and reused for the task lifetime
	// NOTE: This assumes that the task has a fixed set of workspace roots(which is currently true).
	private workspacePathsCache: { paths: string[] } | null = null
	private isMultiRootScenarioCache: boolean | null = null

	constructor(stateManager: StateManager, taskId?: string) {
		this.stateManager = stateManager
		this.taskId = taskId
	}

	/**
	 * Get workspace information with caching to avoid repeated API calls
	 * Cache is task-scoped since each task gets a new AutoApprove instance
	 */
	private async getWorkspaceInfo(): Promise<{
		workspacePaths: { paths: string[] }
		isMultiRootScenario: boolean
	}> {
		// Check if we already have cached values
		if (this.workspacePathsCache === null || this.isMultiRootScenarioCache === null) {
			// First time - fetch and cache for the lifetime of this task
			this.workspacePathsCache = await HostProvider.workspace.getWorkspacePaths({})
			this.isMultiRootScenarioCache = isMultiRootEnabled(this.stateManager) && this.workspacePathsCache?.paths.length > 1
		}

		return {
			workspacePaths: this.workspacePathsCache!,
			isMultiRootScenario: this.isMultiRootScenarioCache,
		}
	}

	/**
	 * Resolve the ceiling in force for one permission scope.
	 *
	 * Absent by default, so an unconfigured scope behaves exactly as before.
	 */
	private ceilingFor(scope: ConfigurablePermissionScope): ApprovalCeilingSetting | undefined {
		return this.stateManager.getGlobalSettingsKey("autoApprovalSettings")?.ceilings?.[scope]
	}

	/** Whether a scope permits any automation at all. */
	private allowsAutomation(scope: ConfigurablePermissionScope): boolean {
		return this.ceilingFor(scope) !== "manual_only"
	}

	/**
	 * Clamp an approval result to the ceilings of the scopes it covers.
	 *
	 * A ceiling outranks every approval signal, including the blanket switches,
	 * which is the whole point of having one: "approve everything" must still
	 * mean "except the scopes I said never". The tuple's two elements are the
	 * in-workspace and external variants of the same resource class, so each is
	 * clamped by its own scope rather than by a single shared verdict.
	 */
	private clampToCeilings(toolName: ClineDefaultTool, result: boolean | [boolean, boolean]): boolean | [boolean, boolean] {
		const pair = PAIRED_SCOPES[toolName]
		if (pair) {
			const [local, external] = Array.isArray(result) ? result : [result, false]
			return [local && this.allowsAutomation(pair.local), external && this.allowsAutomation(pair.external)]
		}
		const scope = SINGLE_SCOPES[toolName]
		if (!scope) {
			return result
		}
		const allowed = this.allowsAutomation(scope)
		return Array.isArray(result) ? [result[0] && allowed, result[1] && allowed] : result && allowed
	}

	// Check if the tool should be auto-approved based on the settings
	// Returns bool for most tools, and tuple for tools with nested settings
	shouldAutoApproveTool(toolName: ClineDefaultTool): boolean | [boolean, boolean] {
		return this.clampToCeilings(toolName, this.resolveConfiguredApproval(toolName))
	}

	/** Approval implied by toggles and blanket switches, before ceilings apply. */
	private resolveConfiguredApproval(toolName: ClineDefaultTool): boolean | [boolean, boolean] {
		if (this.stateManager.getGlobalSettingsKey("yoloModeToggled")) {
			switch (toolName) {
				case ClineDefaultTool.FILE_READ:
				case ClineDefaultTool.LIST_FILES:
				case ClineDefaultTool.LIST_CODE_DEF:
				case ClineDefaultTool.SEARCH:
				case ClineDefaultTool.NEW_RULE:
				case ClineDefaultTool.FILE_NEW:
				case ClineDefaultTool.FILE_EDIT:
				case ClineDefaultTool.APPLY_PATCH:
				case ClineDefaultTool.BASH:
				case ClineDefaultTool.USE_SUBAGENT:
				case ClineDefaultTool.USE_SUBAGENTS:
					return [true, true]

				case ClineDefaultTool.BROWSER:
				case ClineDefaultTool.WEB_FETCH:
				case ClineDefaultTool.WEB_SEARCH:
				case ClineDefaultTool.MCP_ACCESS:
				case ClineDefaultTool.MCP_USE:
					return true
			}
		}

		if (this.stateManager.getGlobalSettingsKey("autoApproveAllToggled")) {
			switch (toolName) {
				case ClineDefaultTool.FILE_READ:
				case ClineDefaultTool.LIST_FILES:
				case ClineDefaultTool.LIST_CODE_DEF:
				case ClineDefaultTool.SEARCH:
				case ClineDefaultTool.NEW_RULE:
				case ClineDefaultTool.FILE_NEW:
				case ClineDefaultTool.FILE_EDIT:
				case ClineDefaultTool.APPLY_PATCH:
				case ClineDefaultTool.BASH:
				case ClineDefaultTool.USE_SUBAGENT:
				case ClineDefaultTool.USE_SUBAGENTS:
					return [true, true]
				case ClineDefaultTool.BROWSER:
				case ClineDefaultTool.MCP_ACCESS:
				case ClineDefaultTool.MCP_USE:
					return true
			}
		}

		const autoApprovalSettings = this.stateManager.getGlobalSettingsKey("autoApprovalSettings")

		switch (toolName) {
			case ClineDefaultTool.FILE_READ:
			case ClineDefaultTool.LIST_FILES:
			case ClineDefaultTool.LIST_CODE_DEF:
			case ClineDefaultTool.SEARCH:
			case ClineDefaultTool.USE_SUBAGENT:
			case ClineDefaultTool.USE_SUBAGENTS:
				return [autoApprovalSettings.actions.readFiles, autoApprovalSettings.actions.readFilesExternally ?? false]
			case ClineDefaultTool.NEW_RULE:
			case ClineDefaultTool.FILE_NEW:
			case ClineDefaultTool.FILE_EDIT:
			case ClineDefaultTool.APPLY_PATCH:
				return [autoApprovalSettings.actions.editFiles, autoApprovalSettings.actions.editFilesExternally ?? false]
			case ClineDefaultTool.BASH:
				return [
					autoApprovalSettings.actions.executeSafeCommands ?? false,
					autoApprovalSettings.actions.executeAllCommands ?? false,
				]
			case ClineDefaultTool.BROWSER:
				return autoApprovalSettings.actions.useBrowser
			case ClineDefaultTool.WEB_FETCH:
			case ClineDefaultTool.WEB_SEARCH:
				return autoApprovalSettings.actions.useWeb ?? false
			case ClineDefaultTool.MCP_ACCESS:
			case ClineDefaultTool.MCP_USE:
				return autoApprovalSettings.actions.useMcp
			case ClineDefaultTool.GENERATE_IMAGE:
				return autoApprovalSettings.actions.generateImages ?? false
		}

		// Handler-managed interactions must pass the outer approval gate so the
		// handler can present its own UI. status_update also owns the decision to
		// request acknowledgment or complete without blocking.
		if (toolName === ClineDefaultTool.STATUS_UPDATE || CONVERSATIONAL_TOOL_NAMES.has(toolName)) {
			return true
		}

		return false
	}

	// Check if the tool should be auto-approved based on the settings
	// and the path of the action. Returns true if the tool should be auto-approved
	// based on the user's settings and the path of the action.
	async shouldAutoApproveToolWithPath(
		blockname: ClineDefaultTool,
		autoApproveActionpath: string | undefined,
	): Promise<boolean> {
		// The blanket switches short-circuit everything below, so the ceiling has
		// to be consulted before them rather than inside the per-scope resolution
		// they skip. Without this, "approve everything" would silently outrank a
		// scope the user marked as never automatable.
		const pair = PAIRED_SCOPES[blockname]
		const blanketEnabled =
			this.stateManager.getGlobalSettingsKey("yoloModeToggled") === true ||
			this.stateManager.getGlobalSettingsKey("autoApproveAllToggled") === true

		// An unpaired tool has a single scope, so its ceiling is decidable here.
		// A paired tool does not: which half governs depends on where the path
		// resolves. Answering with "either half allows it" would let an
		// automatable workspace scope carry an external path past a
		// manual_only external ceiling, so that case falls through to the
		// classification below.
		if (blanketEnabled && pair === undefined) {
			return true
		}

		let isLocalRead = false
		if (autoApproveActionpath) {
			// Use cached workspace info instead of fetching every time
			const { isMultiRootScenario, workspacePaths } = await this.getWorkspaceInfo()
			const cwd = workspacePaths.paths[0] || getDesktopDir()
			const absolutePath = resolveWorkspacePath(
				cwd,
				autoApproveActionpath,
				"AutoApprove.shouldAutoApproveToolWithPath",
			) as string

			if (
				DlineRuntimeFileManager.isManagedPath(absolutePath) ||
				(blockname === ClineDefaultTool.FILE_READ &&
					this.taskId !== undefined &&
					isTaskReadScopePath(this.taskId, absolutePath))
			) {
				isLocalRead = true
			} else if (isMultiRootScenario) {
				// Multi-root: check if file is in ANY workspace
				isLocalRead = await isLocatedInWorkspace(autoApproveActionpath)
			} else {
				// Single-root: use existing logic
				isLocalRead = isLocatedInPath(cwd, absolutePath)
			}
		} else {
			// If we do not get a path for some reason, default to a (safer) false return
			isLocalRead = false
		}

		// Now that the path is classified, the blanket switch can be answered
		// against the one scope that actually governs this call.
		if (blanketEnabled && pair !== undefined) {
			return this.allowsAutomation(isLocalRead ? pair.local : pair.external)
		}

		// Get auto-approve settings for local and external edits
		const autoApproveResult = this.shouldAutoApproveTool(blockname)
		const [autoApproveLocal, autoApproveExternal] = Array.isArray(autoApproveResult)
			? autoApproveResult
			: [autoApproveResult, false]

		if ((isLocalRead && autoApproveLocal) || (!isLocalRead && autoApproveLocal && autoApproveExternal)) {
			return true
		}
		return false
	}
}

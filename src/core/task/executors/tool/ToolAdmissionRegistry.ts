import fs from "node:fs/promises"
import path from "node:path"
import { isTaskReadScopePath } from "@core/artifacts/runtime"
import type { ToolUse } from "@core/assistant-message"
import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import { type BrowserAction, browserActions, type ClineAsk, type ClineSayTool } from "@shared/ExtensionMessage"
import { ClineDefaultTool } from "@shared/tools"
import { normalizeWorkspaceRelativeInputPath } from "@/core/workspace/utils/normalizeWorkspaceRelativeInputPath"
import { parseWorkspaceInlinePath } from "@/core/workspace/utils/parseWorkspaceInlinePath"
import { DlineRuntimeFileManager } from "@/services/runtime-files/DlineRuntimeFileManager"
import { PATCH_MARKERS } from "@/shared/Patch"
import type { ConfigurableCeilings, PermissionScopeContext } from "../../kernel/turn/approval-kind"
import { PATH_SCOPED_TOOLS, resolveLaneContext, type ToolLaneContext } from "../../kernel/turn/tool-lanes"
import { findReplaceTextFiles } from "../../tools/utils/replace-text-files"
import {
	admitToolCall,
	rejectToolCall,
	type ToolApprovalPresentation,
	type ToolPreflightAdmission,
	type ToolPreflightResult,
	type ToolSideEffect,
} from "./ToolPreflight"

/** Frozen, value-only inputs available while preparing one admission. */
export interface ToolAdmissionSnapshot {
	taskId: string
	cwd: string
	workspaceRoots: readonly string[]
	workspaceRootEntries?: readonly { name: string; path: string }[]
	primaryWorkspaceRoot?: string
	isMultiRootEnabled?: boolean
	settings: AutoApprovalSettings
	blanket: { yoloMode?: boolean; approveAll?: boolean }
	inheritsApproval?: boolean
	mcpToolAutoApprove?: boolean
}

/** Inputs supplied by the coordinator for one registered handler. */
export interface RegisteredToolAdmissionInput<T> {
	canonicalToolName: ClineDefaultTool
	block: ToolUse
	description: string
	snapshot: ToolAdmissionSnapshot
	/** Live settings snapshot used only to refresh the approval decision. */
	snapshotProvider?: () => ToolAdmissionSnapshot
	/** Tool-specific payload already frozen before approval. */
	presentation?: ToolApprovalPresentation
	run: ToolSideEffect<T>
}

type RequiredParameter = string | readonly string[]

/** Required input fields that can be checked without touching the target. */
const REQUIRED_PARAMETERS: Partial<Record<ClineDefaultTool, readonly RequiredParameter[]>> = {
	[ClineDefaultTool.ASK]: ["question"],
	[ClineDefaultTool.ATTEMPT]: ["result"],
	[ClineDefaultTool.BASH]: ["command", "requires_approval"],
	[ClineDefaultTool.KILL_COMMAND]: ["function_id"],
	[ClineDefaultTool.FILE_EDIT]: [["path", "absolutePath"], "diff"],
	[ClineDefaultTool.FILE_READ]: ["path"],
	[ClineDefaultTool.FILE_NEW]: [["path", "absolutePath"], "content"],
	[ClineDefaultTool.SEARCH]: ["path", "regex"],
	[ClineDefaultTool.LIST_FILES]: ["path"],
	[ClineDefaultTool.LIST_CODE_DEF]: ["path"],
	[ClineDefaultTool.BROWSER]: ["action"],
	[ClineDefaultTool.MCP_USE]: ["server_name", "tool_name"],
	[ClineDefaultTool.MCP_ACCESS]: ["server_name", "uri"],
	[ClineDefaultTool.NEW_TASK]: ["context"],
	[ClineDefaultTool.MAKE_PLAN]: ["response"],
	[ClineDefaultTool.ACT_MODE]: ["response"],
	[ClineDefaultTool.QNA_RESPOND]: ["response"],
	[ClineDefaultTool.GENERATE_REPORT]: ["title", "content"],
	[ClineDefaultTool.WEB_FETCH]: ["url", "prompt"],
	[ClineDefaultTool.WEB_SEARCH]: ["query"],
	[ClineDefaultTool.SUMMARIZE_TASK]: ["context"],
	[ClineDefaultTool.NEW_RULE]: [["path", "absolutePath"], "content"],
	[ClineDefaultTool.APPLY_PATCH]: ["input"],
	[ClineDefaultTool.GENERATE_EXPLANATION]: ["title"],
	[ClineDefaultTool.LOAD_MCP]: ["name"],
	[ClineDefaultTool.LOAD_SKILL]: ["name"],
	[ClineDefaultTool.LOAD_WORKFLOW]: ["name"],
	[ClineDefaultTool.USE_SUBAGENT]: ["task"],
	[ClineDefaultTool.USE_SUBAGENTS]: ["subagents"],
	[ClineDefaultTool.SPAWN_TASK]: ["task", "mode"],
	[ClineDefaultTool.CHANGE_TODO_LIST]: ["new_plan"],
	[ClineDefaultTool.REPORT_BUG]: ["title", "what_happened", "steps_to_reproduce", "api_request_output", "additional_context"],
	[ClineDefaultTool.FIND_REFERENCES]: ["file_path", "line", "character"],
	[ClineDefaultTool.RENAME]: ["file_path", "line", "character", "new_name"],
	[ClineDefaultTool.REPLACE_TEXT]: ["file_pattern", "find", "replace"],
	[ClineDefaultTool.STATUS_UPDATE]: ["response"],
	[ClineDefaultTool.GENERATE_IMAGE]: ["prompt"],
}

/** Presentation tool names accepted by the existing generic tool renderer. */
const PRESENTATION_TOOLS: Partial<Record<ClineDefaultTool, ClineSayTool["tool"]>> = {
	[ClineDefaultTool.FILE_EDIT]: "editedExistingFile",
	[ClineDefaultTool.FILE_READ]: "readFile",
	[ClineDefaultTool.FILE_NEW]: "newFileCreated",
	[ClineDefaultTool.SEARCH]: "searchFiles",
	[ClineDefaultTool.LIST_FILES]: "listFilesTopLevel",
	[ClineDefaultTool.LIST_CODE_DEF]: "listCodeDefinitionNames",
	[ClineDefaultTool.WEB_FETCH]: "webFetch",
	[ClineDefaultTool.WEB_SEARCH]: "webSearch",
	[ClineDefaultTool.SUMMARIZE_TASK]: "summarizeTask",
	[ClineDefaultTool.NEW_RULE]: "newFileCreated",
	[ClineDefaultTool.APPLY_PATCH]: "editedExistingFile",
	[ClineDefaultTool.LOAD_MCP]: "loadCapability",
	[ClineDefaultTool.LOAD_SKILL]: "useSkill",
	[ClineDefaultTool.LOAD_WORKFLOW]: "loadCapability",
	[ClineDefaultTool.FIND_REFERENCES]: "findReferences",
	[ClineDefaultTool.RENAME]: "renameSymbol",
	[ClineDefaultTool.REPLACE_TEXT]: "replaceText",
	[ClineDefaultTool.CHANGE_TODO_LIST]: "focusChainChanged",
	[ClineDefaultTool.ACT_MODE]: "actModeRespond",
	[ClineDefaultTool.STATUS_UPDATE]: "statusUpdate",
	[ClineDefaultTool.KILL_COMMAND]: "killCommand",
	[ClineDefaultTool.GENERATE_IMAGE]: "generateImage",
}

function parameterValue(block: ToolUse, name: string): unknown {
	return (block.params as Record<string, unknown> | undefined)?.[name]
}

function hasValue(value: unknown): boolean {
	return value !== undefined && value !== null && (typeof value !== "string" || value.trim().length > 0)
}

function validateParameters(block: ToolUse, toolName: ClineDefaultTool): string | undefined {
	for (const requirement of REQUIRED_PARAMETERS[toolName] ?? []) {
		const alternatives = typeof requirement === "string" ? [requirement] : requirement
		if (!alternatives.some((name) => hasValue(parameterValue(block, name)))) {
			return `Missing required parameter '${alternatives.join("' or '")}' for tool '${block.name}'.`
		}
	}

	if (toolName === ClineDefaultTool.BASH) {
		const requiresApproval = String(parameterValue(block, "requires_approval")).toLowerCase()
		if (requiresApproval !== "true" && requiresApproval !== "false") {
			return `Invalid parameter 'requires_approval' for tool '${block.name}': expected true or false.`
		}
	}

	if (toolName === ClineDefaultTool.SPAWN_TASK) {
		const mode = parameterValue(block, "mode")
		if (mode !== "plan" && mode !== "act") {
			return `Invalid parameter 'mode' for tool '${block.name}': expected plan or act.`
		}
	}

	if (toolName === ClineDefaultTool.BROWSER) {
		const action = parameterValue(block, "action") as BrowserAction | undefined
		if (!action || !browserActions.includes(action)) {
			return `Invalid parameter 'action' for tool '${block.name}'.`
		}
		const requiredByAction: Partial<Record<BrowserAction, string>> = {
			launch: "url",
			click: "coordinate",
			type: "text",
		}
		const required = requiredByAction[action]
		if (required && !hasValue(parameterValue(block, required))) {
			return `Missing required parameter '${required}' for browser action '${action}'.`
		}
	}

	return undefined
}

function declaredPaths(block: ToolUse, toolName?: ClineDefaultTool): string[] {
	const params = block.params as Record<string, unknown> | undefined
	if (toolName === ClineDefaultTool.APPLY_PATCH && typeof params?.input === "string") {
		const paths: string[] = []
		for (const line of params.input.split("\n")) {
			for (const marker of [PATCH_MARKERS.ADD, PATCH_MARKERS.UPDATE, PATCH_MARKERS.DELETE, PATCH_MARKERS.MOVE]) {
				if (!line.startsWith(marker)) continue
				const candidate = line.slice(marker.length).trim()
				if (candidate) paths.push(candidate)
				break
			}
		}
		return [...new Set(paths)]
	}
	const candidate =
		toolName === ClineDefaultTool.BASH
			? params?.workdirectory
			: toolName === ClineDefaultTool.REPLACE_TEXT
				? params?.file_pattern
				: (params?.path ?? params?.absolutePath ?? params?.file_path)
	return typeof candidate === "string" && candidate.trim() ? [candidate] : []
}

function declaredPath(block: ToolUse, toolName?: ClineDefaultTool): string | undefined {
	return declaredPaths(block, toolName)[0]
}

function isInsideRoot(target: string, root: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(target))
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function resolveLexicalPath(candidate: string | undefined, snapshot: ToolAdmissionSnapshot): string | undefined {
	if (!candidate) return undefined
	const normalizedInput = normalizeWorkspaceRelativeInputPath(candidate)
	if (snapshot.isMultiRootEnabled) {
		const { workspaceHint, relPath } = parseWorkspaceInlinePath(normalizedInput)
		const normalizedPath = normalizeWorkspaceRelativeInputPath(relPath)
		if (path.isAbsolute(normalizedPath)) return path.resolve(normalizedPath)

		const roots = snapshot.workspaceRootEntries?.length
			? snapshot.workspaceRootEntries
			: snapshot.workspaceRoots.map((workspaceRoot) => ({
					name: path.basename(workspaceRoot),
					path: workspaceRoot,
				}))
		let root = workspaceHint ? roots.find((candidateRoot) => candidateRoot.name === workspaceHint) : undefined
		if (!root && workspaceHint) {
			root = roots.find(
				(candidateRoot) => candidateRoot.path === workspaceHint || candidateRoot.path.includes(workspaceHint),
			)
		}
		root ??= roots.find((candidateRoot) => candidateRoot.path === snapshot.primaryWorkspaceRoot) ?? roots[0]
		if (root) return normalizedPath ? path.join(root.path, normalizedPath) : path.resolve(root.path)
	}
	return path.isAbsolute(normalizedInput) ? path.resolve(normalizedInput) : path.resolve(snapshot.cwd, normalizedInput)
}

function isTrustedTaskRead(toolName: ClineDefaultTool, absolutePath: string, snapshot: ToolAdmissionSnapshot): boolean {
	return (
		toolName === ClineDefaultTool.FILE_READ &&
		(DlineRuntimeFileManager.isManagedPath(absolutePath) || isTaskReadScopePath(snapshot.taskId, absolutePath))
	)
}

function resolveScopeContext(
	block: ToolUse,
	toolName: ClineDefaultTool,
	snapshot: ToolAdmissionSnapshot,
): PermissionScopeContext {
	const roots = snapshot.workspaceRoots.length > 0 ? snapshot.workspaceRoots : [snapshot.cwd]
	const absolutePaths = declaredPaths(block, toolName).map((candidate) => resolveLexicalPath(candidate, snapshot))
	const requiresApproval = String(parameterValue(block, "requires_approval") ?? "").toLowerCase() === "true"
	return {
		isExternalPath: absolutePaths.some(
			(absolutePath) =>
				absolutePath !== undefined &&
				!isTrustedTaskRead(toolName, absolutePath, snapshot) &&
				!roots.some((root) => isInsideRoot(absolutePath, root)),
		),
		isSafeCommand: toolName === ClineDefaultTool.BASH ? !requiresApproval : false,
		isToolAutoApproveEnabled: toolName === ClineDefaultTool.MCP_USE ? snapshot.mcpToolAutoApprove === true : undefined,
	}
}

async function canonicalizePath(target: string): Promise<string | undefined> {
	let candidate = path.resolve(target)
	const missingSegments: string[] = []
	while (true) {
		try {
			const canonical = await fs.realpath(candidate)
			return path.resolve(canonical, ...missingSegments)
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (code !== "ENOENT" && code !== "ENOTDIR") return undefined
			const parent = path.dirname(candidate)
			if (parent === candidate) return undefined
			missingSegments.unshift(path.basename(candidate))
			candidate = parent
		}
	}
}

interface ConfirmedScopeContext {
	scope: PermissionScopeContext
	canonicalPaths: string[]
	confirmationFailed: boolean
}

/**
 * Tools whose final write set is discovered while they execute.
 *
 * Their declared path still identifies the target the call addresses, so it
 * classifies the permission scope. What it cannot do is enumerate the files
 * they will touch, so they never contribute canonical write-path lanes and
 * fall back to the conservative fan-out lane instead.
 */
const DYNAMIC_WRITE_FANOUT_TOOLS = new Set<ClineDefaultTool>([ClineDefaultTool.REPLACE_TEXT, ClineDefaultTool.RENAME])

async function confirmScopeContext(
	block: ToolUse,
	toolName: ClineDefaultTool,
	snapshot: ToolAdmissionSnapshot,
): Promise<ConfirmedScopeContext> {
	const lexical = resolveScopeContext(block, toolName, snapshot)
	// `rename` edits whatever the language server resolves while it runs, so its
	// declared file identifies the target it is charged to but not its write set.
	const anchorIsNotTheWriteSet = toolName === ClineDefaultTool.RENAME
	let absolutePaths: string[]
	try {
		if (toolName === ClineDefaultTool.REPLACE_TEXT) {
			const filePattern = parameterValue(block, "file_pattern")
			absolutePaths =
				typeof filePattern === "string" && filePattern.trim() ? await findReplaceTextFiles(snapshot.cwd, filePattern) : []
		} else {
			absolutePaths = declaredPaths(block, toolName)
				.map((candidate) => resolveLexicalPath(candidate, snapshot))
				.filter((candidate): candidate is string => candidate !== undefined)
		}
	} catch {
		return { scope: { ...lexical, isExternalPath: true }, canonicalPaths: [], confirmationFailed: true }
	}
	if (absolutePaths.length === 0) return { scope: lexical, canonicalPaths: [], confirmationFailed: false }

	const canonicalPaths = await Promise.all(absolutePaths.map(canonicalizePath))
	if (canonicalPaths.some((candidate) => candidate === undefined)) {
		return { scope: { ...lexical, isExternalPath: true }, canonicalPaths: [], confirmationFailed: true }
	}
	const resolvedPaths = canonicalPaths.filter((candidate): candidate is string => candidate !== undefined)
	const roots = snapshot.workspaceRoots.length > 0 ? snapshot.workspaceRoots : [snapshot.cwd]
	const canonicalRoots = await Promise.all(roots.map(async (root) => (await canonicalizePath(root)) ?? path.resolve(root)))
	return {
		scope: {
			...lexical,
			isExternalPath: resolvedPaths.some(
				(canonicalPath) =>
					!isTrustedTaskRead(toolName, canonicalPath, snapshot) &&
					!canonicalRoots.some((root) => isInsideRoot(canonicalPath, root)),
			),
		},
		// The anchor was canonicalized to classify the scope; reporting it as the
		// write set would understate which files actually need a lane.
		canonicalPaths: anchorIsNotTheWriteSet ? [] : resolvedPaths,
		confirmationFailed: false,
	}
}

function approvalAsk(toolName: ClineDefaultTool, block: ToolUse): ClineAsk {
	if (toolName === ClineDefaultTool.BASH || toolName === ClineDefaultTool.KILL_COMMAND) return "command"
	if (
		toolName === ClineDefaultTool.MCP_USE ||
		toolName === ClineDefaultTool.MCP_ACCESS ||
		toolName === ClineDefaultTool.MCP_DOCS
	) {
		return "use_mcp_server"
	}
	if (toolName === ClineDefaultTool.BROWSER && parameterValue(block, "action") === "launch") return "browser_action_launch"
	if (toolName === ClineDefaultTool.NEW_TASK) return "new_task"
	if (toolName === ClineDefaultTool.SPAWN_TASK) return "spawn_task"
	if (toolName === ClineDefaultTool.CHANGE_TODO_LIST) return "change_todo_list"
	if (toolName === ClineDefaultTool.REPORT_BUG) return "report_bug"
	if (toolName === ClineDefaultTool.USE_SUBAGENT || toolName === ClineDefaultTool.USE_SUBAGENTS) return "use_subagents"
	return "tool"
}

function buildPresentation(
	toolName: ClineDefaultTool,
	block: ToolUse,
	description: string,
	notify: boolean,
	snapshot: ToolAdmissionSnapshot,
): ToolApprovalPresentation {
	const ask = approvalAsk(toolName, block)
	if (ask === "command") {
		if (toolName === ClineDefaultTool.KILL_COMMAND) {
			const functionId = parameterValue(block, "function_id")
			return { ask, body: typeof functionId === "string" ? `Terminate command ${functionId}` : description, notify }
		}
		const command = parameterValue(block, "command")
		const workingDirectory = resolveLexicalPath(declaredPath(block, toolName), snapshot) ?? snapshot.cwd
		const body = typeof command === "string" ? command : description
		return { ask, body: `${body}\n\nWorking directory: ${workingDirectory}`, notify }
	}
	if (ask === "browser_action_launch") {
		const url = parameterValue(block, "url")
		return { ask, body: typeof url === "string" ? url : description, notify }
	}
	if (ask !== "tool") {
		return { ask, body: JSON.stringify(block.params ?? {}), notify }
	}
	const body: ClineSayTool = {
		tool: PRESENTATION_TOOLS[toolName] ?? "statusUpdate",
		path: declaredPath(block, toolName) ?? description,
		content: description,
	}
	return { ask, body: JSON.stringify(body), notify }
}

/**
 * Prepare one registered call without touching its target or starting its effect.
 *
 * All values used here come from the finalized call or a frozen settings snapshot.
 * Filesystem, LSP, editor, MCP, browser and network services are intentionally not
 * accepted by this function, so target I/O cannot accidentally enter admission.
 */
export function prepareRegisteredToolAdmission<T>(input: RegisteredToolAdmissionInput<T>): ToolPreflightResult<T> {
	const invalid = validateParameters(input.block, input.canonicalToolName)
	if (invalid) {
		return rejectToolCall({ reason: "invalid_parameters", message: invalid })
	}
	const presentation =
		input.presentation ??
		buildPresentation(
			input.canonicalToolName,
			input.block,
			input.description,
			input.snapshot.settings.enableNotifications,
			input.snapshot,
		)
	const baseLaneContext = resolveLaneContext({ ...input.block, name: input.canonicalToolName })
	const admissionFor = (
		snapshot: ToolAdmissionSnapshot,
		scope: PermissionScopeContext,
		lanes: ToolLaneContext,
		confirm?: () => Promise<ToolPreflightResult<T>>,
	): ToolPreflightAdmission<T> => {
		const refreshDecision = () => admissionFor(input.snapshotProvider?.() ?? snapshot, scope, lanes)
		return admitToolCall(
			{
				toolName: input.canonicalToolName,
				settings: snapshot.settings,
				ceilings: snapshot.settings.ceilings as ConfigurableCeilings | undefined,
				scope,
				lanes,
				blanket: snapshot.blanket,
				inheritsApproval: snapshot.inheritsApproval,
			},
			input.run,
			presentation,
			confirm,
			refreshDecision,
		)
	}
	// A declared path is confirmed before scheduling so an alias resolves to the
	// scope that actually governs the call. replace_text names a pattern rather
	// than a path, so it confirms on its own.
	const declared = declaredPaths(input.block, input.canonicalToolName)
	const confirm =
		declared.length > 0 || input.canonicalToolName === ClineDefaultTool.REPLACE_TEXT
			? async () => {
					const confirmed = await confirmScopeContext(input.block, input.canonicalToolName, input.snapshot)
					const lanes: ToolLaneContext = {
						...baseLaneContext,
						canonicalWritePaths:
							PATH_SCOPED_TOOLS.has(input.canonicalToolName) && !confirmed.confirmationFailed
								? confirmed.canonicalPaths
								: undefined,
						conservativeWriteFanout: PATH_SCOPED_TOOLS.has(input.canonicalToolName) && confirmed.confirmationFailed,
					}
					return admissionFor(input.snapshot, confirmed.scope, lanes)
				}
			: undefined
	return admissionFor(
		input.snapshot,
		resolveScopeContext(input.block, input.canonicalToolName, input.snapshot),
		baseLaneContext,
		confirm,
	)
}

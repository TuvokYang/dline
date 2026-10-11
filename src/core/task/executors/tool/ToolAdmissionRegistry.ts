import fs from "node:fs/promises"
import path from "node:path"
import { isTaskReadScopePath } from "@core/artifacts/runtime"
import type { ToolUse } from "@core/assistant-message"
import { getTaskTempDirectory } from "@core/storage/task-temp"
import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import { type BrowserAction, browserActions, type UiAsk, type UiSayTool } from "@shared/ExtensionMessage"
import { DlineDefaultTool } from "@shared/tools"
import { normalizeWorkspaceRelativeInputPath } from "@/core/workspace/utils/normalizeWorkspaceRelativeInputPath"
import { parseWorkspaceInlinePath } from "@/core/workspace/utils/parseWorkspaceInlinePath"
import { DlineRuntimeFileManager } from "@/services/runtime-files/DlineRuntimeFileManager"
import { PATCH_MARKERS } from "@/shared/Patch"
import {
    type ConfigurableCeilings,
    PATH_SCOPED_TOOLS,
    type PermissionScopeContext,
    resolveLaneContext,
    type ToolLaneContext,
} from "../../kernel"
import { findReplaceTextFiles } from "../../tools/utils/replace-text-files"
import { declaresWritePath, resolveToolPathParam } from "../../tools/utils/tool-path-params"
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
    canonicalToolName: DlineDefaultTool
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
const REQUIRED_PARAMETERS: Partial<Record<DlineDefaultTool, readonly RequiredParameter[]>> = {
    [DlineDefaultTool.ASK]: ["question"],
    [DlineDefaultTool.ATTEMPT]: ["result"],
    [DlineDefaultTool.BASH]: ["command", "requires_approval"],
    [DlineDefaultTool.KILL_COMMAND]: ["function_id"],
    [DlineDefaultTool.FILE_EDIT]: ["diff"],
    [DlineDefaultTool.FILE_READ]: ["path"],
    [DlineDefaultTool.FILE_NEW]: ["content"],
    [DlineDefaultTool.SEARCH]: ["path", "regex"],
    [DlineDefaultTool.LIST_FILES]: ["path"],
    [DlineDefaultTool.LIST_CODE_DEF]: ["path"],
    [DlineDefaultTool.BROWSER]: ["action"],
    [DlineDefaultTool.MCP_USE]: ["server_name", "tool_name"],
    [DlineDefaultTool.MCP_ACCESS]: ["server_name", "uri"],
    [DlineDefaultTool.NEW_TASK]: ["context"],
    [DlineDefaultTool.MAKE_PLAN]: ["response"],
    [DlineDefaultTool.WORKING_RESPOND]: ["response"],
    [DlineDefaultTool.QNA_RESPOND]: ["response"],
    [DlineDefaultTool.GENERATE_REPORT]: ["title", "content"],
    [DlineDefaultTool.WEB_FETCH]: ["url", "prompt"],
    [DlineDefaultTool.WEB_SEARCH]: ["query"],
    [DlineDefaultTool.SUMMARIZE_TASK]: ["context"],
    [DlineDefaultTool.NEW_RULE]: ["content"],
    [DlineDefaultTool.APPLY_PATCH]: ["input"],
    [DlineDefaultTool.GENERATE_EXPLANATION]: ["title"],
    [DlineDefaultTool.LOAD_MCP]: ["name"],
    [DlineDefaultTool.LOAD_SKILL]: ["name"],
    [DlineDefaultTool.LOAD_WORKFLOW]: ["name"],
    [DlineDefaultTool.USE_SUBAGENT]: ["task"],
    [DlineDefaultTool.USE_SUBAGENTS]: ["subagents"],
    [DlineDefaultTool.SPAWN_TASK]: ["task", "mode"],
    [DlineDefaultTool.CHANGE_TODO_LIST]: ["new_plan"],
    [DlineDefaultTool.REPORT_BUG]: ["title", "what_happened", "steps_to_reproduce", "api_request_output", "additional_context"],
    [DlineDefaultTool.FIND_REFERENCES]: ["file_path", "line", "character"],
    [DlineDefaultTool.RENAME]: ["file_path", "line", "character", "new_name"],
    [DlineDefaultTool.REPLACE_TEXT]: ["file_pattern", "find", "replace"],
    [DlineDefaultTool.PHASE_REPORT]: ["response"],
    [DlineDefaultTool.GENERATE_IMAGE]: ["prompt"],
}

/** Presentation tool names accepted by the existing generic tool renderer. */
const PRESENTATION_TOOLS: Partial<Record<DlineDefaultTool, UiSayTool["tool"]>> = {
    [DlineDefaultTool.FILE_EDIT]: "editedExistingFile",
    [DlineDefaultTool.FILE_READ]: "readFile",
    [DlineDefaultTool.FILE_NEW]: "newFileCreated",
    [DlineDefaultTool.SEARCH]: "searchFiles",
    [DlineDefaultTool.LIST_FILES]: "listFilesTopLevel",
    [DlineDefaultTool.LIST_CODE_DEF]: "listCodeDefinitionNames",
    [DlineDefaultTool.WEB_FETCH]: "webFetch",
    [DlineDefaultTool.WEB_SEARCH]: "webSearch",
    [DlineDefaultTool.SUMMARIZE_TASK]: "summarizeTask",
    [DlineDefaultTool.NEW_RULE]: "newFileCreated",
    [DlineDefaultTool.APPLY_PATCH]: "editedExistingFile",
    [DlineDefaultTool.LOAD_MCP]: "loadCapability",
    [DlineDefaultTool.LOAD_SKILL]: "useSkill",
    [DlineDefaultTool.LOAD_WORKFLOW]: "loadCapability",
    [DlineDefaultTool.FIND_REFERENCES]: "findReferences",
    [DlineDefaultTool.RENAME]: "renameSymbol",
    [DlineDefaultTool.REPLACE_TEXT]: "replaceText",
    [DlineDefaultTool.CHANGE_TODO_LIST]: "focusChainChanged",
    [DlineDefaultTool.WORKING_RESPOND]: "actModeRespond",
    [DlineDefaultTool.PHASE_REPORT]: "statusUpdate",
    [DlineDefaultTool.KILL_COMMAND]: "killCommand",
    [DlineDefaultTool.GENERATE_IMAGE]: "generateImage",
}

function parameterValue(block: ToolUse, name: string): unknown {
    return (block.params as Record<string, unknown> | undefined)?.[name]
}

function hasValue(value: unknown): boolean {
    return value !== undefined && value !== null && (typeof value !== "string" || value.trim().length > 0)
}

function validateParameters(block: ToolUse, toolName: DlineDefaultTool): string | undefined {
    if (declaresWritePath(toolName)) {
        const resolution = resolveToolPathParam(block.params)
        if (resolution.error) return resolution.error
        if (!resolution.param) return `Missing required parameter 'path' for tool '${block.name}'.`
    }

    for (const requirement of REQUIRED_PARAMETERS[toolName] ?? []) {
        const alternatives = typeof requirement === "string" ? [requirement] : requirement
        if (!alternatives.some((name) => hasValue(parameterValue(block, name)))) {
            return `Missing required parameter '${alternatives.join("' or '")}' for tool '${block.name}'.`
        }
    }

    if (toolName === DlineDefaultTool.BASH) {
        const requiresApproval = String(parameterValue(block, "requires_approval")).toLowerCase()
        if (requiresApproval !== "true" && requiresApproval !== "false") {
            return `Invalid parameter 'requires_approval' for tool '${block.name}': expected true or false.`
        }
    }

    if (toolName === DlineDefaultTool.SPAWN_TASK) {
        const mode = parameterValue(block, "mode")
        if (mode !== "plan" && mode !== "act") {
            return `Invalid parameter 'mode' for tool '${block.name}': expected plan or act.`
        }
    }

    if (toolName === DlineDefaultTool.BROWSER) {
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

function declaredPaths(block: ToolUse, toolName?: DlineDefaultTool): string[] {
    const params = block.params as Record<string, unknown> | undefined
    if (toolName && declaresWritePath(toolName)) {
        const resolution = resolveToolPathParam(block.params)
        return resolution.param ? [resolution.param.value] : []
    }
    if (toolName === DlineDefaultTool.APPLY_PATCH && typeof params?.input === "string") {
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
        toolName === DlineDefaultTool.BASH
            ? params?.workdirectory
            : toolName === DlineDefaultTool.REPLACE_TEXT
              ? params?.file_pattern
              : (params?.path ?? params?.file_path)
    return typeof candidate === "string" && candidate.trim() ? [candidate] : []
}

function declaredPath(block: ToolUse, toolName?: DlineDefaultTool): string | undefined {
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

/**
 * Roots whose contents count as project files for permission scope.
 *
 * The current task's temp directory holds the task's own command logs and scratch files, so reading,
 * searching, or writing there is project work rather than an external access.
 */
function projectRoots(snapshot: ToolAdmissionSnapshot): readonly string[] {
    const workspaceRoots = snapshot.workspaceRoots.length > 0 ? snapshot.workspaceRoots : [snapshot.cwd]
    const taskTempRoot = resolveTaskTempRoot(snapshot.taskId)
    return taskTempRoot ? [...workspaceRoots, taskTempRoot] : workspaceRoots
}

function resolveTaskTempRoot(taskId: string): string | undefined {
    try {
        return getTaskTempDirectory(taskId)
    } catch {
        // A snapshot without a valid task identity has no task temp directory to trust.
        return undefined
    }
}

function isTrustedTaskRead(toolName: DlineDefaultTool, absolutePath: string, snapshot: ToolAdmissionSnapshot): boolean {
    return (
        toolName === DlineDefaultTool.FILE_READ &&
        (DlineRuntimeFileManager.isManagedPath(absolutePath) || isTaskReadScopePath(snapshot.taskId, absolutePath))
    )
}

function resolveScopeContext(
    block: ToolUse,
    toolName: DlineDefaultTool,
    snapshot: ToolAdmissionSnapshot,
): PermissionScopeContext {
    const roots = projectRoots(snapshot)
    const absolutePaths = declaredPaths(block, toolName).map((candidate) => resolveLexicalPath(candidate, snapshot))
    const requiresApproval = String(parameterValue(block, "requires_approval") ?? "").toLowerCase() === "true"
    return {
        isExternalPath: absolutePaths.some(
            (absolutePath) =>
                absolutePath !== undefined &&
                !isTrustedTaskRead(toolName, absolutePath, snapshot) &&
                !roots.some((root) => isInsideRoot(absolutePath, root)),
        ),
        isSafeCommand: toolName === DlineDefaultTool.BASH ? !requiresApproval : false,
        isToolAutoApproveEnabled: resolveToolAutoApprove(toolName, snapshot),
    }
}

/**
 * Per-tool exceptions to a scope's auto-approval toggle. Blanket grants (YOLO,
 * approve all) still apply. `spawn_task` shares the subagent scope, but its
 * contract requires the user to approve every new peer task, so the "Read
 * project files" toggle that admits read-only subagents never admits it.
 */
function resolveToolAutoApprove(toolName: DlineDefaultTool, snapshot: ToolAdmissionSnapshot): boolean | undefined {
    if (toolName === DlineDefaultTool.MCP_USE) return snapshot.mcpToolAutoApprove === true
    if (toolName === DlineDefaultTool.SPAWN_TASK) return false
    return undefined
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
const DYNAMIC_WRITE_FANOUT_TOOLS = new Set<DlineDefaultTool>([DlineDefaultTool.REPLACE_TEXT, DlineDefaultTool.RENAME])

async function confirmScopeContext(
    block: ToolUse,
    toolName: DlineDefaultTool,
    snapshot: ToolAdmissionSnapshot,
): Promise<ConfirmedScopeContext> {
    const lexical = resolveScopeContext(block, toolName, snapshot)
    // `rename` edits whatever the language server resolves while it runs, so its
    // declared file identifies the target it is charged to but not its write set.
    const anchorIsNotTheWriteSet = toolName === DlineDefaultTool.RENAME
    let absolutePaths: string[]
    try {
        if (toolName === DlineDefaultTool.REPLACE_TEXT) {
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
    const roots = projectRoots(snapshot)
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

function approvalAsk(toolName: DlineDefaultTool, block: ToolUse): UiAsk {
    if (toolName === DlineDefaultTool.BASH || toolName === DlineDefaultTool.KILL_COMMAND) return "command"
    if (
        toolName === DlineDefaultTool.MCP_USE ||
        toolName === DlineDefaultTool.MCP_ACCESS ||
        toolName === DlineDefaultTool.MCP_DOCS
    ) {
        return "use_mcp_server"
    }
    if (toolName === DlineDefaultTool.BROWSER && parameterValue(block, "action") === "launch") return "browser_action_launch"
    if (toolName === DlineDefaultTool.NEW_TASK) return "new_task"
    if (toolName === DlineDefaultTool.SPAWN_TASK) return "spawn_task"
    if (toolName === DlineDefaultTool.CHANGE_TODO_LIST) return "change_todo_list"
    if (toolName === DlineDefaultTool.REPORT_BUG) return "report_bug"
    if (toolName === DlineDefaultTool.USE_SUBAGENT || toolName === DlineDefaultTool.USE_SUBAGENTS) return "use_subagents"
    return "tool"
}

function buildPresentation(
    toolName: DlineDefaultTool,
    block: ToolUse,
    description: string,
    notify: boolean,
    snapshot: ToolAdmissionSnapshot,
): ToolApprovalPresentation {
    const ask = approvalAsk(toolName, block)
    if (ask === "command") {
        if (toolName === DlineDefaultTool.KILL_COMMAND) {
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
    const body: UiSayTool = {
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
        declared.length > 0 || input.canonicalToolName === DlineDefaultTool.REPLACE_TEXT
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

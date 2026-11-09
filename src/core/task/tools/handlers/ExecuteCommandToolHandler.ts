import { resolveProvider } from "@core/api"
import type { ToolUse } from "@core/assistant-message"
import { getPrompt } from "@core/prompts/i18n"
import { formatResponse } from "@core/prompts/responses"
import { commandApprovalBody } from "@core/task/ask-row"
import { showSystemNotification } from "@integrations/notifications"
import type { CommandExecutionOutcome } from "@integrations/terminal"
import { DEFAULT_TERMINAL_COMMAND_TIMEOUT_SECONDS, MIN_TERMINAL_COMMAND_TIMEOUT_SECONDS } from "@shared/terminal-settings"
import { arePathsEqual } from "@utils/path"
import { telemetryService } from "@/services/telemetry"
import { DlineDefaultTool } from "@/shared/tools"
import { isApprovalRowOf } from "../approval-interaction"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { ToolResponse } from "../ToolResponse"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { applyModelContentFixes } from "../utils/ModelContentProcessor"
import { resolveSelfBoundResultBytes } from "../utils/tool-result-budget"
import { parseCommandExecutionOptions } from "./command-execution-options"
import { resolveCommandTarget } from "./command-workdirectory"

export { resolveCommandTimeoutSeconds } from "./command-execution-options"

export function commandResultForModel(outcome: CommandExecutionOutcome, muteStdout: boolean): ToolResponse {
    if (
        muteStdout &&
        outcome.completed &&
        !outcome.userRejected &&
        outcome.exitCode === 0 &&
        !outcome.signal &&
        !outcome.timedOut
    ) {
        return "Command executed successfully (exit code 0)."
    }
    return outcome.result
}

export class ExecuteCommandToolHandler implements IFullyManagedTool {
    constructor(readonly name: DlineDefaultTool.BASH | DlineDefaultTool.KILL_COMMAND = DlineDefaultTool.BASH) {}

    getDescription(block: ToolUse): string {
        if (block.name === DlineDefaultTool.KILL_COMMAND) {
            return `[${block.name} for '${block.params.function_id}']`
        }
        const workdirectory = block.params.workdirectory ? ` in '${block.params.workdirectory}'` : ""
        return `[${block.name} for '${block.params.command}'${workdirectory}]`
    }

    /**
     * Mark this command's own row as never having run.
     *
     * The row is created as `pending` and only the execution path moves it on,
     * so a refused command would otherwise stay pending forever and keep
     * offering a Cancel button for work that will never start.
     *
     * The row is the call's approval row, matched by its approval interaction id
     * rather than by position: a turn may carry several command rows, and the
     * most recent one can belong to a sibling that is still running.
     */
    async presentDenial(config: TaskConfig, block: ToolUse): Promise<void> {
        if (block.name === DlineDefaultTool.KILL_COMMAND) return
        const dlineTid = block.dline_tid
        if (!dlineTid) return
        const messages = config.messageState.clineMessages
        const index = messages.findIndex(
            (message) =>
                (message.ask === "command" || message.say === "command") &&
                isApprovalRowOf(message.interactionId, dlineTid) &&
                message.commandStatus === "pending",
        )
        if (index === -1) return
        await config.callbacks.updateClineMessage(index, { commandStatus: "skipped" })
    }

    async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
        if (block.name === DlineDefaultTool.KILL_COMMAND) return
        const command = block.params.command
        if (uiHelpers.getConfig().isSubagentExecution) {
            return
        }

        // The directory is resolved when the command runs, so the preview row has
        // no directory to state yet; the approval anchor and the run row add it.
        const commandLine = uiHelpers.removeClosingTag(block, "command", command)
        await uiHelpers.say("command", commandLine, undefined, undefined, true, block.ts, block.ts)
    }

    async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
        if (block.name === DlineDefaultTool.KILL_COMMAND) {
            return this.executeKillCommand(config, block)
        }

        let command: string | undefined = block.params.command
        const requiresApprovalRaw: string | undefined = block.params.requires_approval
        const timeoutParam: string | undefined = block.params.timeout
        const backgroundParam: string | undefined = block.params.background
        const synchronousParam: string | undefined = block.params.synchronous
        const muteStdoutParam: string | undefined = block.params.mute_stdout
        const workdirectoryParam: string | undefined = block.params.workdirectory

        // Extract provider using the proven pattern from ReportBugHandler
        const apiConfig = config.services.stateManager.getApiConfiguration()
        const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
        const provider = resolveProvider(apiConfig, currentMode)

        // Validate required parameters
        if (!command) {
            config.taskState.consecutiveMistakeCount++
            await config.callbacks.say(
                "error",
                "Dline tried to use execute_command without value for required parameter 'command'. Retrying...",
            )
            // Report through the missing-parameter boundary as well: it also closes
            // the command preview this call already streamed, and this branch keeps
            // its own wording for the user.
            await config.callbacks.sayAndCreateMissingParamError(this.name, "command", undefined, block.ts)
            return formatResponse.toolError(formatResponse.executeCommandMissingCommandError())
        }

        if (!requiresApprovalRaw) {
            config.taskState.consecutiveMistakeCount++
            return await config.callbacks.sayAndCreateMissingParamError(this.name, "requires_approval", undefined, block.ts)
        }

        config.taskState.consecutiveMistakeCount = 0

        // Parse only explicit tool overrides. The current Settings default is read at launch.
        const executionOptions = parseCommandExecutionOptions(
            command,
            backgroundParam,
            timeoutParam,
            synchronousParam,
            muteStdoutParam,
        )

        // Pre-process command for certain models
        if (config.api.getModel().id.includes("gemini")) {
            command = applyModelContentFixes(command)
        }

        let resolvedWorkdirectory: Awaited<ReturnType<typeof resolveCommandTarget>>
        try {
            resolvedWorkdirectory = await resolveCommandTarget({
                cwd: config.cwd,
                command,
                workdirectory: workdirectoryParam,
                isMultiRootEnabled: config.isMultiRootEnabled,
                workspaceManager: config.workspaceManager,
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (!config.isSubagentExecution) await config.callbacks.say("error", message)
            return formatResponse.toolError(message)
        }
        const { path: executionDir, actualCommand, workspaceHint, workspaceHintUsed } = resolvedWorkdirectory
        command = actualCommand

        // Check command permission validation (DLINE_COMMAND_PERMISSIONS env var)
        const permissionResult = config.services.commandPermissionController.validateCommand(actualCommand)
        if (!permissionResult.allowed) {
            let errorMessage: string
            if (permissionResult.failedSegment) {
                errorMessage =
                    `Command "${actualCommand}" was denied by DLINE_COMMAND_PERMISSIONS. ` +
                    `Segment "${permissionResult.failedSegment}" ${permissionResult.reason}.`
            } else {
                const matchedPattern = permissionResult.matchedPattern
                    ? ` (matched pattern: ${permissionResult.matchedPattern})`
                    : ""
                errorMessage =
                    `Command "${actualCommand}" was denied by DLINE_COMMAND_PERMISSIONS. ` +
                    `Reason: ${permissionResult.reason}${matchedPattern}`
            }
            if (!config.isSubagentExecution) {
                await config.callbacks.say("command_permission_denied", errorMessage)
            }
            return formatResponse.toolError(formatResponse.permissionDeniedError(errorMessage))
        }

        // The working directory is where the command runs, so it is judged by the
        // execute permission rather than by what listings choose to hide.
        if (!config.services.ignoreController.validateDirectoryAccess(executionDir, "execute")) {
            if (!config.isSubagentExecution) {
                await config.callbacks.say("clineignore_error", executionDir)
            }
            return formatResponse.toolError(formatResponse.clineIgnoreError(executionDir))
        }

        const ignoredFileAttemptedToAccess = config.services.ignoreController.validateCommand(actualCommand, executionDir)
        if (ignoredFileAttemptedToAccess) {
            if (!config.isSubagentExecution) {
                await config.callbacks.say("clineignore_error", ignoredFileAttemptedToAccess)
            }
            return formatResponse.toolError(formatResponse.clineIgnoreError(ignoredFileAttemptedToAccess))
        }

        // Determine workspace context for telemetry
        const resolvedRoot = config.workspaceManager?.resolvePathToRoot(executionDir)
        const primaryRoot = config.workspaceManager?.getPrimaryRoot()?.path ?? config.cwd
        const resolvedToNonPrimary = resolvedRoot ? !arePathsEqual(resolvedRoot.path, primaryRoot) : false
        const workspaceContext = {
            isMultiRootEnabled: config.isMultiRootEnabled || false,
            usedWorkspaceHint: workspaceHintUsed,
            resolvedToNonPrimary,
            resolutionMethod: workdirectoryParam
                ? ("path_detection" as const)
                : workspaceHintUsed
                  ? ("hint" as const)
                  : ("primary_fallback" as const),
        }

        // Capture workspace path resolution telemetry
        if (config.isMultiRootEnabled && config.workspaceManager) {
            telemetryService.captureWorkspacePathResolved(
                config.ulid ?? "",
                "ExecuteCommandToolHandler",
                workspaceHintUsed ? "hint_provided" : "fallback_to_primary",
                workspaceHintUsed ? "workspace_name" : undefined,
                resolvedToNonPrimary, // resolution success = resolved to different workspace
                undefined, // TODO: could calculate workspace index if needed
                true,
            )
        }

        const admissionOutcome = config.admissionOutcome

        if (!config.isSubagentExecution) {
            const approvalBody = commandApprovalBody(actualCommand, executionDir)
            await config.callbacks.say(
                "command",
                approvalBody.commandLine,
                undefined,
                undefined,
                false,
                block.ts,
                undefined,
                approvalBody,
            )
        }
        const wasAutoApproved = admissionOutcome === undefined
        telemetryService.captureToolUsage(
            config.ulid ?? "",
            block.name,
            config.api.getModel().id,
            provider ?? "",
            wasAutoApproved,
            true,
            workspaceContext,
            block.isNativeToolCall,
        )

        // Run PreToolUse hook after admission but before execution
        try {
            const { ToolHookUtils } = await import("../utils/ToolHookUtils")
            await ToolHookUtils.runPreToolUseIfEnabled(config, block)
        } catch (error) {
            const { PreToolUseHookCancellationError } = await import("@core/hooks/PreToolUseHookCancellationError")
            if (error instanceof PreToolUseHookCancellationError) {
                return formatResponse.toolDenied()
            }
            throw error
        }

        // Setup timeout notification for long-running automatically admitted commands
        let timeoutId: NodeJS.Timeout | undefined
        if (wasAutoApproved && config.autoApprovalSettings.enableNotifications && !config.isSubagentExecution) {
            // if the command was auto-approved, and it's long running we need to notify the user after some time has passed without proceeding
            timeoutId = setTimeout(() => {
                showSystemNotification({
                    subtitle: "Command is still running",
                    message: "An auto-approved command has been running for 30s, and may need your attention.",
                })
            }, 30_000)
        }

        const configuredTimeout = config.services.stateManager.getGlobalSettingsKey("terminalCommandTimeoutSeconds")
        const defaultTimeout =
            typeof configuredTimeout === "number" &&
            Number.isSafeInteger(configuredTimeout) &&
            configuredTimeout >= MIN_TERMINAL_COMMAND_TIMEOUT_SECONDS
                ? configuredTimeout
                : DEFAULT_TERMINAL_COMMAND_TIMEOUT_SECONDS
        const timeoutSeconds = executionOptions.timeoutSeconds ?? defaultTimeout

        const outcome = await config.callbacks.executeCommandTool(actualCommand, timeoutSeconds, {
            commandTs: block.ts,
            functionId: block.function_id,
            startInBackground: executionOptions.background,
            synchronous: executionOptions.synchronous,
            workdirectory: executionDir,
            resultBytes: config.contextBudget ? () => resolveSelfBoundResultBytes(config.contextBudget) : undefined,
        })

        if (timeoutId) {
            clearTimeout(timeoutId)
        }

        // Invalidate the entire file read cache after any command execution.
        // Bash commands can modify files in ways we can't predict (sed, npm install, git checkout, mv, etc.),
        // so we must clear the cache to prevent stale reads.
        // Invalidate the entire file read cache after any command execution.
        // Bash commands can modify files in ways we can't predict (sed, npm install, git checkout, mv, etc.),
        // so we must clear the cache to prevent stale reads.
        if (!outcome.userRejected) {
            config.taskState.fileReadCache.clear()
        }

        if (outcome.backgroundCommandId && typeof outcome.result === "string") {
            return `${outcome.result}\nfunction_id: ${block.function_id}`
        }
        return commandResultForModel(outcome, executionOptions.muteStdout)
    }

    private async executeKillCommand(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
        const functionId = block.params.function_id?.trim()
        if (!functionId) {
            config.taskState.consecutiveMistakeCount++
            return config.callbacks.sayAndCreateMissingParamError(this.name, "function_id", undefined, block.ts)
        }

        const killCommand = config.callbacks.killCommandTool
        if (!killCommand) {
            return formatResponse.toolError(getPrompt("killCommand", "unavailableError"))
        }

        config.taskState.consecutiveMistakeCount = 0
        const cancellation = await killCommand(functionId)
        const result = getPrompt("killCommand", cancellation.cancelled ? "terminationRequested" : "notRunning")
        if (!config.isSubagentExecution) {
            await config.callbacks.say(
                "tool",
                JSON.stringify({
                    tool: "killCommand",
                    path: cancellation.command ?? functionId,
                    content: result,
                    activityId: cancellation.activityId,
                }),
                undefined,
                undefined,
                false,
                block.ts,
            )
        }
        return formatResponse.toolResult(result)
    }
}

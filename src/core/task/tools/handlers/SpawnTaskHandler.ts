import type { ToolUse } from "@core/assistant-message"
import { getPrompt } from "@core/prompts/i18n"
import { formatResponse } from "@core/prompts/responses"
import type { Mode } from "@shared/storage/types"

import { ClineDefaultTool } from "@/shared/tools"
import type { IToolHandler } from "../ToolExecutorCoordinator"
import type { ToolResponse } from "../ToolResponse"
import type { TaskConfig } from "../types/TaskConfig"

/** Reports whether a tool-provided startup mode is supported. */
function isSpawnTaskMode(value: string | undefined): value is Mode {
    return value === "plan" || value === "act"
}

/**
 * Creates a first-class peer task in a new Editor Tab panel.
 *
 * The task inherits the parent's API profile for the requested mode, MCP
 * servers, and rules, then starts independently in the background.
 */
export class SpawnTaskHandler implements IToolHandler {
    readonly name = ClineDefaultTool.SPAWN_TASK

    getDescription(_block: ToolUse): string {
        return `[spawn_task]`
    }

    async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
        const params = block.params as Record<string, string | undefined>
        const taskDescription: string | undefined = params.task
        const requestedMode: string | undefined = params.mode
        const contextParam: string | undefined = params.context

        if (!taskDescription) {
            config.taskState.consecutiveMistakeCount++
            return await config.callbacks.sayAndCreateMissingParamError(this.name, "task", undefined, block.ts)
        }
        if (!requestedMode) {
            config.taskState.consecutiveMistakeCount++
            return await config.callbacks.sayAndCreateMissingParamError(this.name, "mode", undefined, block.ts)
        }
        if (!isSpawnTaskMode(requestedMode)) {
            config.taskState.consecutiveMistakeCount++
            return formatResponse.toolError(`Invalid mode '${requestedMode}' for spawn_task. Expected 'plan' or 'act'.`)
        }

        config.taskState.consecutiveMistakeCount = 0

        // Check if parent task was aborted before starting async spawn operations
        if (config.taskState.operationSignal.aborted) {
            return formatResponse.toolError("Task was aborted before spawn could complete")
        }

        try {
            const spawner = config.peerTaskSpawner
            if (!spawner) {
                return formatResponse.toolError(getPrompt("toolHandlers", "spawnTaskFailed"))
            }

            // Resolve the parent task's frozen profile instead of relying on the
            // process-wide active-task routing cursor.
            const apiConfiguration = config.services.stateManager.getApiConfigurationForTask(config.taskId)
            const selectedProfile = requestedMode === "plan" ? apiConfiguration.planModeProfile : apiConfiguration.actModeProfile
            if (!selectedProfile) {
                return formatResponse.toolError(`No profile configured for ${requestedMode} mode`)
            }

            const child = await spawner.spawn({
                task: taskDescription,
                mode: requestedMode,
                profile: selectedProfile,
                ...(contextParam ? { context: contextParam } : {}),
                signal: config.taskState.operationSignal,
            })
            return formatResponse.toolResult(
                `Spawned new ${requestedMode.toUpperCase()} task "${taskDescription}" with ID: ${child.childTaskId}. The task has been created in a new editor tab.`,
            )
        } catch (error) {
            return formatResponse.toolError(`Failed to spawn task: ${error instanceof Error ? error.message : String(error)}`)
        }
    }
}

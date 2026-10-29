import type { Settings } from "@shared/proto/dline/state"
import { McpDisplayMode, UpdateSettingsRequest, UpdateTaskSettingsRequest } from "@shared/proto/dline/state"
import { StateServiceClient } from "@/services/grpc-client"

import { SettingsRequestTracker } from "./settingsRequestTracker"

type SettingsField = Exclude<keyof UpdateSettingsRequest, "metadata">
type SettingsInputValue<K extends SettingsField> = K extends "mcpDisplayMode"
    ? UpdateSettingsRequest[K] | "rich" | "plain" | "markdown"
    : UpdateSettingsRequest[K]
type SettingsUpdate = {
    [K in SettingsField]?: SettingsInputValue<K>
}

const settingsRequestTracker = new SettingsRequestTracker()

/** Wait for every Settings RPC and surface the latest failure for each setting. */
export const flushPendingSettingsRequests = () => settingsRequestTracker.flush()

/** Wait for Task-scoped setting writes before starting that Task's next request. */
export const flushPendingTaskSettingsRequests = (taskId: string) => settingsRequestTracker.flushPrefix(`task:${taskId}:`)

function settingsRequestKeys(scope: string, fields: readonly string[]): string[] {
    return fields.map((field) => `${scope}:${field}`)
}

/**
 * Converts values to their corresponding proto format
 * @param field - The field name
 * @param value - The value to convert
 * @returns The converted value
 * @throws Error if the value is invalid for the field
 */
const convertToProtoValue = (field: SettingsField, value: unknown): unknown => {
    if (field === "mcpDisplayMode" && typeof value === "string") {
        switch (value) {
            case "rich":
                return McpDisplayMode.RICH
            case "plain":
                return McpDisplayMode.PLAIN
            case "markdown":
                return McpDisplayMode.MARKDOWN
            default:
                throw new Error(`Invalid MCP display mode value: ${value}`)
        }
    }
    return value
}

/** Updates multiple global settings in one request. */
export const updateSettings = (settings: SettingsUpdate) => {
    const updateRequest: Partial<UpdateSettingsRequest> = {}
    for (const [field, value] of Object.entries(settings) as Array<[SettingsField, unknown]>) {
        Object.assign(updateRequest, { [field]: convertToProtoValue(field, value) })
    }

    return settingsRequestTracker.trackQueued(
        settingsRequestKeys("global", Object.keys(updateRequest)),
        () => StateServiceClient.updateSettings(UpdateSettingsRequest.create(updateRequest)),
        "Failed to update settings:",
    )
}

/**
 * Updates a single field in the settings.
 *
 * @param field - The field key to update
 * @param value - The new value for the field
 */
export const updateSetting = <K extends SettingsField>(field: K, value: SettingsInputValue<K>) =>
    updateSettings({ [field]: value } as SettingsUpdate)

/**
 * Updates a task-level setting for a specific task.
 * Used when you want to override global settings for a particular task.
 *
 * @param taskId - The task ID to update settings for
 * @param field - The settings field to update (e.g., "planModeProfile", "actModeProfile")
 * @param value - The new value for the field
 */
export const updateTaskSetting = <K extends keyof Settings>(taskId: string, field: K, value: Settings[K]) =>
    updateTaskSettings(taskId, { [field]: value } as Partial<Settings>)

/**
 * Updates multiple task-level settings for a specific task.
 *
 * @param taskId - The task ID to update settings for
 * @param settings - The task-level settings to update in one request
 */
export const updateTaskSettings = (taskId: string | undefined, settings: Partial<Settings>) => {
    const request = UpdateTaskSettingsRequest.create({
        taskId: taskId ?? "",
        settings,
    })

    return settingsRequestTracker.trackQueued(
        settingsRequestKeys(`task:${taskId ?? "active"}`, Object.keys(settings)),
        () => StateServiceClient.updateTaskSettings(request),
        `Failed to update task settings for task ${taskId ?? "active"}:`,
    )
}

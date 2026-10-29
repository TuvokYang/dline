import { resolveProvider } from "@core/api"
import { TaskConfig } from "../types/TaskConfig"

export * from "../types/TaskConfig"
export * from "./ToolConstants"
export { ToolDisplayUtils } from "./ToolDisplayUtils"
export { ToolResultUtils } from "./ToolResultUtils"

export function getTaskCompletionTelemetry(config: TaskConfig) {
    const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
    const apiConfig = config.services.stateManager.getApiConfiguration()

    const provider = resolveProvider(apiConfig, currentMode)
    const model = config.api.getModel()
    const durationMs = Math.max(0, Date.now() - config.taskState.taskStartTimeMs)

    return {
        provider,
        modelId: model.id,
        apiFormat: model.info.apiFormats?.[0],
        timeToFirstTokenMs: config.taskState.taskFirstTokenTimeMs,
        durationMs,
        mode: currentMode,
    }
}

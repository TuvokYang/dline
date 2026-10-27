import { telemetryService } from "@/services/telemetry"
import { PLAIN_TEXT_WARNING_EVENT } from "@/services/telemetry/events/event-routes"
import { ToolExecutionObservation } from "../../observability/tool-execution-observation"
import {
    normalizeObservedToolExecutionResult,
    type ObservedToolExecutionResult,
    type ToolHandlerResult,
} from "../ToolExecutionResult"

interface SubagentToolCallIdentity {
    readonly dline_tid: string
    readonly name: string
    readonly isNativeToolCall: boolean
}

/** Report one content-free provider warning for backend model-health analysis. */
export function reportSubagentPlainTextWarning(providerId: string, modelId: string, customModel: boolean): void {
    telemetryService.captureRuntimeEvent(
        PLAIN_TEXT_WARNING_EVENT,
        { provider: providerId, model: modelId, "model.custom": customModel },
        "warn",
    )
}

/** Observe one real subagent tool execution through the canonical failure telemetry owner. */
export function observeSubagentToolExecution(
    input: { readonly taskId: string; readonly requestId?: string; readonly call: SubagentToolCallIdentity },
    execute: () => Promise<ToolHandlerResult>,
): Promise<ObservedToolExecutionResult> {
    return new ToolExecutionObservation({
        taskId: input.taskId,
        toolName: input.call.name,
        turnId: input.requestId ?? input.call.dline_tid,
        native: input.call.isNativeToolCall,
        scope: "subagent",
    }).run(() => execute().then(normalizeObservedToolExecutionResult))
}

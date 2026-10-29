import { afterEach, describe, expect, it, vi } from "vitest"
import { telemetryService } from "@/services/telemetry"
import {
    configureSignalRecording,
    installSignalPipeline,
    resetSignalRecording,
    type TelemetrySignal,
} from "@/services/telemetry/service/pipeline-port"
import { observeSubagentToolExecution, reportSubagentPlainTextWarning } from "../SubagentTurnHealth"

afterEach(() => {
    installSignalPipeline(undefined)
    resetSignalRecording()
    vi.restoreAllMocks()
})

describe("SubagentTurnHealth", () => {
    it("reports one plain-text warning under the catalog keys the main task uses", () => {
        const captureRuntimeEvent = vi.mocked(telemetryService.captureRuntimeEvent)
        captureRuntimeEvent.mockClear()

        reportSubagentPlainTextWarning("anthropic", "claude-sonnet", true)

        expect(captureRuntimeEvent).toHaveBeenCalledOnce()
        expect(captureRuntimeEvent).toHaveBeenCalledWith(
            "provider.plain_text_warning",
            { provider: "anthropic", model: "claude-sonnet", "model.custom": true },
            "warn",
        )
    })

    it("emits exactly one canonical failure event for a structured subagent tool error", async () => {
        const signals: TelemetrySignal[] = []
        configureSignalRecording({ enabled: () => true })
        installSignalPipeline({ accept: (signal) => signals.push(signal) })

        const result = await observeSubagentToolExecution(
            {
                taskId: "subagent-1",
                requestId: "request-1",
                call: { dline_tid: "tool-1", name: "read_file", isNativeToolCall: true },
            },
            async () => ({
                response: "invalid path",
                failure: { stage: "validation", code: "invalid_path" },
            }),
        )

        expect(result.failed).toBe(true)
        const failures = signals.filter((signal) => signal.name === "tool.execution.failed")
        expect(failures).toHaveLength(1)
        expect(failures[0]?.attributes).toMatchObject({
            tool_name: "read_file",
            tool_native: true,
            tool_execution_scope: "subagent",
            failure_stage: "validation",
            failure_code: "invalid_path",
        })
    })
})

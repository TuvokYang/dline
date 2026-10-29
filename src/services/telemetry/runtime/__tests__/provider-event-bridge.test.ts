import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TELEMETRY_MASK_VALUE } from "../content-policy"
import { RuntimeTelemetryLifecycle } from "../lifecycle"
import { forwardRuntimeEvent } from "../provider-event-bridge"
import { RuntimeEventPriority, type RuntimeTelemetryEvent } from "../types"

const event: RuntimeTelemetryEvent = {
    eventId: "event-1",
    sequence: 7,
    timestamp: 1_000,
    monotonicMs: 50,
    name: "tool.execution.failed",
    priority: RuntimeEventPriority.Error,
    context: { sessionId: "session-1", taskId: "task-1" },
    attributes: { tool: "read_file" },
    error: { name: "TypeError", message: "must-not-forward", fingerprint: "fingerprint-1" },
}

describe("runtime provider event bridge", () => {
    let dataDir: string | undefined

    afterEach(() => {
        if (dataDir) rmSync(dataDir, { recursive: true, force: true })
    })

    it("forwards reconstruction fields and omits normalized error prose", () => {
        const sink = { captureRuntimeEvent: vi.fn() }

        forwardRuntimeEvent(event, sink)

        expect(sink.captureRuntimeEvent).toHaveBeenCalledWith(
            "tool.execution.failed",
            expect.objectContaining({
                runtime_sequence: 7,
                taskId: "task-1",
                tool: "read_file",
                error_type: "TypeError",
                error_message: TELEMETRY_MASK_VALUE,
                error_fingerprint: "fingerprint-1",
            }),
            "error",
        )
        expect(JSON.stringify(sink.captureRuntimeEvent.mock.calls)).not.toContain("must-not-forward")
    })

    it("lowers a logged warning to warn but never raises a local warning into the remote floor", () => {
        const sink = { captureRuntimeEvent: vi.fn() }
        const logged = (name: string, priority: RuntimeEventPriority, attributes: Record<string, string>) =>
            forwardRuntimeEvent({ ...event, name, priority, attributes }, sink)

        logged("extension.message", RuntimeEventPriority.Error, { message_level: "warning" })
        logged("extension.warning", RuntimeEventPriority.Info, { logger_level: "warn" })
        logged("extension.warning", RuntimeEventPriority.Info, { logger_level: "error" })
        logged("extension.error", RuntimeEventPriority.Error, { logger_level: "error" })

        expect(sink.captureRuntimeEvent.mock.calls.map(([name, , severity]) => [name, severity])).toEqual([
            ["extension.message", "warn"],
            ["extension.warning", "info"],
            ["extension.warning", "info"],
            ["extension.error", "error"],
        ])
    })

    it("uses the canonical sink in production mode without constructing the legacy OTLP transport", async () => {
        dataDir = mkdtempSync(join(tmpdir(), "dline-runtime-bridge-"))
        const onEvent = vi.fn()
        const processorFactory = vi.fn(() => {
            throw new Error("legacy transport must stay inactive")
        })
        const lifecycle = new RuntimeTelemetryLifecycle({
            dataDir,
            sessionId: "session-1",
            onEvent,
            processorFactory,
            samplerIntervalMs: 0,
            drainIntervalMs: 0,
            journalFlushIntervalMs: 0,
        })
        await lifecycle.applyConsent("enabled")
        lifecycle.service.recordInfo("runtime.ready", { component: "runtime" })

        await lifecycle.flush()

        expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ name: "runtime.ready" }))
        expect(processorFactory).not.toHaveBeenCalled()
        await lifecycle.dispose()
    })
})

import { afterEach, describe, expect, it } from "vitest"
import { RuntimeEventBus } from "@/services/telemetry/runtime/runtime-event-bus"
import { RuntimeSignalPipeline } from "@/services/telemetry/runtime/signal-pipeline"
import { RuntimeEventPriority } from "@/services/telemetry/runtime/types"
import { configureSignalRecording, installSignalPipeline, resetSignalRecording } from "@/services/telemetry/service/pipeline-port"
import { mcpTransportObserver } from "../mcp-transport-observation"

afterEach(() => {
    installSignalPipeline(undefined)
    resetSignalRecording()
})

describe("mcpTransportObserver", () => {
    it("separates transient reconnects from exhausted failures without content fields", () => {
        const bus = new RuntimeEventBus({ sessionId: "mcp-transport-test" })
        installSignalPipeline(new RuntimeSignalPipeline(bus))
        configureSignalRecording({ enabled: () => true })

        mcpTransportObserver.record({
            transport: "sse",
            classification: "transient",
            outcome: "scheduled",
            attempt: 1,
            maxAttempts: 6,
            error: new TypeError("PRIVATE_SERVER_MESSAGE"),
        })
        mcpTransportObserver.record({
            transport: "streamableHttp",
            classification: "exhausted",
            outcome: "exhausted",
            attempt: 6,
            maxAttempts: 6,
            error: new Error("PRIVATE_SERVER_MESSAGE"),
        })

        const [transient, exhausted] = bus.peek()
        expect(transient).toMatchObject({
            name: "mcp.transport.interrupted",
            priority: RuntimeEventPriority.Info,
            attributes: {
                mcp_transport: "sse",
                mcp_transport_class: "transient",
                reconnect_outcome: "scheduled",
            },
        })
        expect(exhausted).toMatchObject({
            name: "mcp.transport.reconnect_exhausted",
            priority: RuntimeEventPriority.Error,
            attributes: {
                mcp_transport: "streamableHttp",
                mcp_transport_class: "exhausted",
                reconnect_outcome: "exhausted",
            },
        })
        expect(JSON.stringify(bus.peek())).not.toContain("PRIVATE_SERVER_MESSAGE")
        bus.dispose()
    })
})

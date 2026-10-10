import { describe, expect, it } from "vitest"
import type { RuntimeDiagnosticSeverity } from "../contracts"
import { LoggingRuntimeDiagnostics } from "../LoggingRuntimeDiagnostics"

function collect() {
    const entries: { message: string; severity: RuntimeDiagnosticSeverity }[] = []
    const sink = new LoggingRuntimeDiagnostics("task-1", (message, severity) => entries.push({ message, severity }))
    return { entries, sink }
}

describe("LoggingRuntimeDiagnostics", () => {
    it("reports a recorded fault as a failure", () => {
        const { entries, sink } = collect()

        sink.record({ source: "outbox", code: "durable_publish_failed", message: "boom", revision: 7, commandId: "c-1" })

        expect(entries).toHaveLength(1)
        expect(entries[0].severity).toBe("failure")
        expect(entries[0].message).toContain("outbox:durable_publish_failed")
        expect(entries[0].message).toContain("commandId=c-1")
        expect(entries[0].message).toContain("revision=7")
        expect(entries[0].message).toContain("boom")
    })

    // A healthy run records what recovery decided. Reporting that as a failure
    // makes every successful open look like a fault to anything watching the
    // error channel, which is what the E2E output assertion caught.
    it("keeps a normal observation off the failure channel", () => {
        const { entries, sink } = collect()

        sink.record({
            source: "hydrate",
            code: "hydrated",
            severity: "observation",
            message: "form=new flow=idle commands=none",
            revision: 0,
        })

        expect(entries).toEqual([
            {
                message: "[TaskRuntime task-1] hydrate:hydrated revision=0 form=new flow=idle commands=none",
                severity: "observation",
            },
        ])
    })
})

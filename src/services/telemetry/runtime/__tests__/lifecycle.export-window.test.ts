import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { RuntimeTelemetryLifecycle } from "../lifecycle"

/**
 * What an export may still read after a drain.
 *
 * The periodic drain empties the bus, so the queue alone no longer describes
 * the session: after the first tick it holds only the last few seconds. An
 * investigation asks for a bundle *because* something went wrong earlier, so
 * the pipeline has to keep the drained events reachable rather than hand the
 * exporter whatever happens to be left in the queue.
 */

describe("RuntimeTelemetryLifecycle session events", () => {
    let dataDir: string

    beforeEach(() => {
        dataDir = mkdtempSync(path.join(tmpdir(), "dline-telemetry-window-"))
    })

    afterEach(() => {
        rmSync(dataDir, { recursive: true, force: true })
    })

    const makeLifecycle = () =>
        new RuntimeTelemetryLifecycle({
            dataDir,
            sessionId: "window-session",
            samplerIntervalMs: 0,
            drainIntervalMs: 0,
            journalFlushIntervalMs: 5,
            // No exporter: this test observes the retained export window, and a
            // collector connection would make it depend on the network.
            processorFactory: () => undefined,
        })

    it("still reports events a drain already wrote to the sinks", async () => {
        const lifecycle = makeLifecycle()
        try {
            await lifecycle.applyConsent("enabled")
            lifecycle.service.recordInfo("early.event", { component: "runtime", operation: "start" })

            await lifecycle.flush()
            lifecycle.service.recordInfo("late.event", { component: "runtime", operation: "finish" })

            const names = lifecycle.sessionEvents().map((event) => event.name)
            expect(names).toContain("early.event")
            expect(names).toContain("late.event")
        } finally {
            await lifecycle.dispose()
        }
    })

    it("keeps the session events in the order they were recorded", async () => {
        const lifecycle = makeLifecycle()
        try {
            await lifecycle.applyConsent("enabled")
            lifecycle.service.recordInfo("first", { component: "runtime", operation: "a" })
            await lifecycle.flush()
            lifecycle.service.recordInfo("second", { component: "runtime", operation: "b" })
            await lifecycle.flush()
            lifecycle.service.recordInfo("third", { component: "runtime", operation: "c" })

            const names = lifecycle.sessionEvents().map((event) => event.name)
            expect(names).toEqual(["first", "second", "third"])
        } finally {
            await lifecycle.dispose()
        }
    })

    it("bounds the retained events so a long session cannot grow without limit", async () => {
        const lifecycle = new RuntimeTelemetryLifecycle({
            dataDir,
            sessionId: "bounded-session",
            samplerIntervalMs: 0,
            drainIntervalMs: 0,
            journalFlushIntervalMs: 5,
            capacity: 4,
            // No exporter: this case asserts on the retained export window, not
            // on collector behaviour.
            processorFactory: () => undefined,
        })
        try {
            await lifecycle.applyConsent("enabled")
            for (let index = 0; index < 12; index++) {
                lifecycle.service.recordInfo(`event.${index}`, { component: "runtime", operation: "loop" })
                await lifecycle.flush()
            }

            const names = lifecycle.sessionEvents().map((event) => event.name)
            expect(names).toHaveLength(4)
            // The newest events are the ones worth keeping: a diagnosis is
            // drawn from what happened just before the report.
            expect(names).toEqual(["event.8", "event.9", "event.10", "event.11"])
        } finally {
            await lifecycle.dispose()
        }
    })

    it("discards the session events when the user opts out", async () => {
        const lifecycle = makeLifecycle()
        try {
            await lifecycle.applyConsent("enabled")
            lifecycle.service.recordInfo("collected.event", { component: "runtime", operation: "start" })
            await lifecycle.flush()
            expect(lifecycle.sessionEvents()).not.toHaveLength(0)

            await lifecycle.applyConsent("disabled")
            expect(lifecycle.sessionEvents()).toHaveLength(0)
        } finally {
            await lifecycle.dispose()
        }
    })
})

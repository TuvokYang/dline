import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs"
import type { TelemetrySetting } from "@shared/TelemetrySetting"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { getSharedLoggerProvider, resetSharedLoggerProviderForTesting } from "@/services/telemetry/otel/shared-logger-provider"
import { RuntimeTelemetryLifecycle } from "../lifecycle"

/**
 * WS-017 / AC-031 — VER-RTD-006-CONSENT-BOUNDARY.
 *
 * Runtime diagnostics and product analytics now share one `LoggerProvider`.
 * That is an efficiency, not a merge of permissions: sharing export
 * infrastructure must not let one subsystem's consent decision start the other.
 *
 * The risk this pins down is specific. `unset` means the user has not yet
 * answered the reporting prompt. If sharing a provider ever made runtime
 * telemetry start on someone else's consent, the extension would write a
 * journal of the user's activity and open a collector connection before being
 * allowed to — a silent privacy regression that no type or lint check would
 * catch. So the assertions are about observable side effects: files on disk and
 * records handed to an exporter.
 */

const SESSION_ID = "consent-session"

describe("runtime telemetry consent boundary", () => {
    let dataDir: string
    let exporter: InMemoryLogRecordExporter

    function sessionsDir(): string {
        return path.join(dataDir, "telemetry", "sessions")
    }

    function makeLifecycle(): RuntimeTelemetryLifecycle {
        return new RuntimeTelemetryLifecycle({
            dataDir,
            sessionId: SESSION_ID,
            samplerIntervalMs: 0,
            drainIntervalMs: 0,
            journalFlushIntervalMs: 5,
            // Substituting only the exporting stage keeps the consent gate,
            // the journal and the redaction policy exactly as they ship.
            processorFactory: () => new SimpleLogRecordProcessor(exporter),
        })
    }

    /**
     * Records one event under the given consent and returns what was exported.
     *
     * The snapshot is taken before disposal because shutting a
     * `SimpleLogRecordProcessor` down also shuts down its exporter, and the
     * in-memory exporter discards its records at that point. Reading it
     * afterwards would report an empty list no matter what the pipeline did.
     */
    async function recordUnder(setting: TelemetrySetting): Promise<unknown[]> {
        const lifecycle = makeLifecycle()
        try {
            await lifecycle.applyConsent(setting)
            lifecycle.service.recordInfo("consent.probe", { component: "runtime", operation: "probe" })
            await lifecycle.flush()
            return exporter.getFinishedLogRecords().map((record) => record.body)
        } finally {
            await lifecycle.dispose()
        }
    }

    beforeEach(() => {
        resetSharedLoggerProviderForTesting()
        dataDir = mkdtempSync(path.join(tmpdir(), "dline-consent-"))
        exporter = new InMemoryLogRecordExporter()
    })

    afterEach(() => {
        resetSharedLoggerProviderForTesting()
        rmSync(dataDir, { recursive: true, force: true })
    })

    it("writes nothing and exports nothing while consent is unset", async () => {
        const exported = await recordUnder("unset")

        expect(existsSync(sessionsDir())).toBe(false)
        expect(exported).toHaveLength(0)
    })

    it("writes nothing and exports nothing once telemetry is disabled", async () => {
        const exported = await recordUnder("disabled")

        expect(existsSync(sessionsDir())).toBe(false)
        expect(exported).toHaveLength(0)
    })

    it("does not build a shared logger provider for an unconsented host", async () => {
        await recordUnder("unset")

        // Constructing the provider is itself the observable step that would
        // precede any export, so its absence proves nothing was prepared.
        expect(getSharedLoggerProvider()).toBeUndefined()
    })

    it("journals and exports once the user enables reporting", async () => {
        const exported = await recordUnder("enabled")

        expect(readdirSync(sessionsDir())).toContain(`${SESSION_ID}.jsonl`)
        expect(exported).toContain("consent.probe")
    })

    it("stops journaling and exporting when consent is withdrawn mid-session", async () => {
        const lifecycle = makeLifecycle()
        try {
            await lifecycle.applyConsent("enabled")
            lifecycle.service.recordInfo("before.optout", { component: "runtime", operation: "probe" })
            await lifecycle.flush()

            // Opting out flushes what was already recorded, so the count is
            // taken after the transition rather than before it.
            await lifecycle.applyConsent("disabled")
            const exportedAtOptOut = exporter.getFinishedLogRecords().length

            lifecycle.service.recordInfo("after.optout", { component: "runtime", operation: "probe" })
            await lifecycle.flush()

            expect(exporter.getFinishedLogRecords()).toHaveLength(exportedAtOptOut)
            const bodies = exporter.getFinishedLogRecords().map((record) => record.body)
            expect(bodies).not.toContain("after.optout")
        } finally {
            await lifecycle.dispose()
        }
    })
})

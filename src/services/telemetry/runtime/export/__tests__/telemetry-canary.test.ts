import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetSharedLoggerProviderForTesting } from "@/services/telemetry/otel/shared-logger-provider"
import { RuntimeTelemetryLifecycle } from "../../lifecycle"
import { exportDiagnosticBundle } from "../diagnostic-exporter"

/**
 * RTD-004 — AC-016 / AC-017.
 *
 * A canary sweep of the diagnostic bundle: feed values that must never leave
 * the machine through a live pipeline, then assert the exported bundle carries
 * none of them.
 *
 * The exporter's own unit tests redact hand-built events, so they choose their
 * own input and cannot show that the events a running pipeline produces are
 * the shape the redactor handles. Recording through the real service and
 * exporting its real buffer is the only way to cover that seam.
 *
 * Scope: the journal and the OTLP body are sinks owned by the transport layer,
 * not by the exporter. They are read here to prove the producer emitted the
 * canaries at all — otherwise a bundle with no canaries would prove nothing —
 * but redaction is asserted only for the bundle.
 */

/**
 * Values that must not appear in the exported bundle.
 *
 * Written as opaque tokens rather than realistic secrets so a match is
 * unambiguous: a canary in an output can only have come from the input.
 */
const CANARIES = {
    prompt: "CANARY-USER-PROMPT-TEXT",
    command: "CANARY-SHELL-COMMAND",
    token: "CANARY-BEARER-abcdef0123456789",
    filePath: "CANARY-ABSOLUTE-PATH",
} as const

const SESSION_ID = "canary-session"
const EVENT_NAME = "terminal.execute_complete"

describe("runtime telemetry canary sweep", () => {
    let dataDir: string
    let requestBodies: string[]

    let exporter: InMemoryLogRecordExporter

    beforeEach(() => {
        // The logger provider is process-wide; a leftover one would route this
        // test's records to an exporter belonging to an earlier test.
        resetSharedLoggerProviderForTesting()
        dataDir = mkdtempSync(path.join(tmpdir(), "dline-canary-"))
        requestBodies = []
        exporter = new InMemoryLogRecordExporter()
    })

    afterEach(() => {
        resetSharedLoggerProviderForTesting()
        rmSync(dataDir, { recursive: true, force: true })
    })

    it("keeps canaries out of the journal, the OTLP body and the exported bundle", async () => {
        const lifecycle = new RuntimeTelemetryLifecycle({
            dataDir,
            sessionId: SESSION_ID,
            otlpEndpoint: "http://127.0.0.1:4318",
            // Capturing the records the pipeline actually exports is stricter
            // than inspecting a serialized request body: it proves redaction
            // happened before anything could leave the process. Only the
            // exporting stage is substituted, so the policy under test is the
            // one the transport installs in production rather than one the
            // test supplied.
            processorFactory: () => new SimpleLogRecordProcessor(exporter),
            journalFlushIntervalMs: 5,
            // Host sampling would add unrelated events and wall-clock timing to
            // a test that only cares about what a producer's payload leaks.
            samplerIntervalMs: 0,
        })

        try {
            await lifecycle.applyConsent("enabled")

            // A producer that ignored the attribute policy: forbidden keys, a
            // credential hidden inside an allowed field, and a path where a
            // dimension was expected.
            lifecycle.service.recordPhase(EVENT_NAME, 1200, {
                component: "terminal",
                operation: "execute",
                outcome: "failed",
                command: CANARIES.command,
                prompt: CANARIES.prompt,
                filePath: CANARIES.filePath,
                note: `Authorization: Bearer ${CANARIES.token}`,
            })

            // Read the buffer before flushing: flush drains the bus, and the
            // exporter needs the same events the sinks received.
            const events = [...lifecycle.service.buffered()]
            await lifecycle.flush()

            const journal = readFileSync(path.join(dataDir, "telemetry", "sessions", `${SESSION_ID}.jsonl`), "utf8")
            for (const record of exporter.getFinishedLogRecords()) {
                requestBodies.push(JSON.stringify({ body: record.body, attributes: record.attributes }))
            }
            const otlpBody = requestBodies.join("\n")
            const sinkOutput = `${journal}\n${otlpBody}`

            const { bundle } = await exportDiagnosticBundle(
                {
                    sessionId: SESSION_ID,
                    events: () => events,
                    diagnoses: () => [],
                },
                {
                    destinationPath: path.join(dataDir, "bundle.zip"),
                    extensionVersion: "0.9.1",
                    hostVersion: "1.96.0",
                    now: () => 1_000,
                },
            )
            const bundleText = bundle.entries.map((entry) => entry.content).join("\n")

            for (const [field, canary] of Object.entries(CANARIES)) {
                expect(bundleText, `bundle leaked ${field}`).not.toContain(canary)
            }

            // The bundle assertions would also pass on an empty pipeline, so
            // confirm the event reached the exporter carrying values the
            // redactor had to remove.
            expect(bundleText).toContain(EVENT_NAME)
            expect(sinkOutput).toContain(EVENT_NAME)
            expect(
                Object.values(CANARIES).some((canary) => sinkOutput.includes(canary)),
                "no canary reached a sink, so the bundle proves nothing",
            ).toBe(true)
        } finally {
            await lifecycle.dispose()
        }
    })
})

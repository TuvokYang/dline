import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DiagnosisConfidence, RootCauseCategory, type RootCauseDiagnosis } from "../../analysis/root-cause-types"
import {
    clearRuntimeDiagnoses,
    getDiagnosticSource,
    getRuntimeTelemetryLifecycle,
    recordRuntimeDiagnosis,
    setRuntimeTelemetryLifecycle,
} from "../../host"
import { RuntimeTelemetryLifecycle } from "../../lifecycle"

/**
 * RTD-004 — the seam between the running pipeline and the export command.
 *
 * The exporter takes a `DiagnosticSource`. Something has to build one from the
 * live pipeline, and the export handler cannot: it runs in the controller and
 * has no reference to the lifecycle. These tests pin that adapter, including
 * the case the handler must be able to distinguish — telemetry never started.
 */

const SESSION_ID = "host-session"

/**
 * A pipeline with no export processor.
 *
 * These cases read the diagnostic source, never the collector, so attaching a
 * live OTLP exporter would only make every disposal that has events to flush
 * wait out an export timeout against an endpoint nothing is listening on.
 */
function makeLifecycle(dataDir: string, sessionId: string): RuntimeTelemetryLifecycle {
    return new RuntimeTelemetryLifecycle({
        dataDir,
        sessionId,
        samplerIntervalMs: 0,
        processorFactory: () => undefined,
    })
}

function stubDiagnosis(id: string): RootCauseDiagnosis {
    return {
        incidentId: id,
        category: RootCauseCategory.Unknown,
        confidence: DiagnosisConfidence.Low,
        component: "runtime",
        operation: "probe",
        evidenceEventIds: [],
        missingEvidence: [],
        failingEventId: `${id}-event`,
        reproductionSteps: [],
    }
}

describe("runtime telemetry host", () => {
    let dataDir: string
    let previous: RuntimeTelemetryLifecycle | undefined

    beforeEach(() => {
        dataDir = mkdtempSync(path.join(tmpdir(), "dline-host-"))
        previous = setRuntimeTelemetryLifecycle(undefined)
        clearRuntimeDiagnoses()
    })

    afterEach(() => {
        setRuntimeTelemetryLifecycle(previous)
        clearRuntimeDiagnoses()
        rmSync(dataDir, { recursive: true, force: true })
    })

    it("reports no source before a pipeline is installed", () => {
        expect(getRuntimeTelemetryLifecycle()).toBeUndefined()
        expect(getDiagnosticSource()).toBeUndefined()
    })

    it("exposes the installed pipeline's session and buffered events", async () => {
        const lifecycle = makeLifecycle(dataDir, SESSION_ID)
        setRuntimeTelemetryLifecycle(lifecycle)

        try {
            await lifecycle.applyConsent("enabled")
            lifecycle.service.recordPhase("host.probe", 12, { component: "runtime", operation: "probe" })

            const source = getDiagnosticSource()
            expect(source?.sessionId).toBe(SESSION_ID)
            expect(source?.events().map((event) => event.name)).toContain("host.probe")
        } finally {
            await lifecycle.dispose()
        }
    })

    it("returns the previous pipeline so a caller can tell it is orphaning one", async () => {
        const first = makeLifecycle(dataDir, "first")
        const second = makeLifecycle(dataDir, "second")

        try {
            expect(setRuntimeTelemetryLifecycle(first)).toBeUndefined()
            expect(setRuntimeTelemetryLifecycle(second)).toBe(first)
            expect(getRuntimeTelemetryLifecycle()).toBe(second)
        } finally {
            await first.dispose()
            await second.dispose()
        }
    })

    it("collects diagnoses independently of the pipeline so an export can carry them", async () => {
        const lifecycle = makeLifecycle(dataDir, SESSION_ID)
        setRuntimeTelemetryLifecycle(lifecycle)

        try {
            // Consent gates the export, so the source only exists once the
            // pipeline is collecting.
            await lifecycle.applyConsent("enabled")
            recordRuntimeDiagnosis(stubDiagnosis("incident-1"))
            expect(getDiagnosticSource()?.diagnoses()).toHaveLength(1)

            clearRuntimeDiagnoses()
            expect(getDiagnosticSource()?.diagnoses()).toHaveLength(0)
        } finally {
            await lifecycle.dispose()
        }
    })
})

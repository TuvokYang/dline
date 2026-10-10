import type { RootCauseDiagnosis } from "./analysis/root-cause-types"
import type { DiagnosticSource } from "./export/diagnostic-exporter"
import type { RuntimeTelemetryLifecycle } from "./lifecycle"

/**
 * Process-wide holder for the running telemetry pipeline.
 *
 * The lifecycle owns disk and network sinks, so exactly one may exist per
 * extension host. Command handlers reach it through this module rather than
 * through a constructor chain, for the same reason the event bus is reachable
 * that way: producers and consumers are spread across services with no shared
 * owner.
 *
 * The holder is deliberately separate from `index.ts`. Importing the lifecycle
 * from the package entry point would pull the journal, the transport and the
 * sampler into every module that only wants to record an event.
 */

let lifecycle: RuntimeTelemetryLifecycle | undefined

/**
 * Install the running pipeline, returning the previous one.
 *
 * Returning the previous value lets a test restore what it replaced, and lets
 * a caller detect that it is about to orphan a pipeline that still owns open
 * sinks.
 */
export function setRuntimeTelemetryLifecycle(next: RuntimeTelemetryLifecycle | undefined): RuntimeTelemetryLifecycle | undefined {
    const previous = lifecycle
    lifecycle = next
    return previous
}

/** The running pipeline, or `undefined` before activation installs one. */
export function getRuntimeTelemetryLifecycle(): RuntimeTelemetryLifecycle | undefined {
    return lifecycle
}

/**
 * Diagnoses observed so far.
 *
 * Root cause analysis runs on demand rather than continuously, so nothing
 * accumulates diagnoses yet. Exposing the seam here keeps the exporter's
 * contract stable: when an analyzer starts publishing, only this function
 * changes.
 */
const diagnoses: RootCauseDiagnosis[] = []

/** Record a diagnosis so a later export can include it. */
export function recordRuntimeDiagnosis(diagnosis: RootCauseDiagnosis): void {
    diagnoses.push(diagnosis)
}

/** Discard accumulated diagnoses. Used when a session ends and by tests. */
export function clearRuntimeDiagnoses(): void {
    diagnoses.length = 0
}

/**
 * Adapt the running pipeline to the exporter's input contract.
 *
 * Returns `undefined` when no pipeline is collecting, which is the state a
 * caller must distinguish from "collecting but empty": the first means the
 * feature is unavailable, the second means there is nothing to report.
 *
 * Activation installs a lifecycle regardless of consent, so being installed is
 * not enough. Only a started pipeline may be exported; otherwise an undecided
 * or opted-out user could still produce a diagnostic archive.
 */
export function getDiagnosticSource(): DiagnosticSource | undefined {
    const current = lifecycle
    if (!current?.isEnabled) return undefined

    return {
        sessionId: current.sessionId,
        // The lifecycle drains the bus on a timer, so the bus alone would only
        // hold the last few seconds. `sessionEvents` adds the drained history
        // back, which is what makes a bundle cover the whole session.
        events: () => current.sessionEvents(),
        diagnoses: () => diagnoses,
    }
}

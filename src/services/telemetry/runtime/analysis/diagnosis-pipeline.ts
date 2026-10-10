/**
 * Turns recorded events into named causes while the session is running.
 *
 * The correlator and the analyzer were built as pure functions over events, so
 * something has to feed them. This is that seam. It lives in the analysis
 * package rather than in the lifecycle because deciding *what counts as a
 * failure* is an analysis concern; the lifecycle only owns sinks and consent.
 *
 * Cost is bounded by design. Every event costs one ring-buffer append; the rule
 * set runs only for events that report a failure or a breached budget, which
 * are rare by construction. Diagnostics must never become the reason the
 * extension host is busy — that is the problem this subsystem exists to find.
 */

import type { RuntimeTelemetryEvent } from "../types"
import { IncidentCorrelator } from "./incident-correlator"
import { ANALYSIS_ATTRIBUTES, OUTCOME, RootCauseAnalyzer } from "./root-cause-analyzer"
import type { RootCauseDiagnosis } from "./root-cause-types"

/** Suffix the threshold policy appends when a metric leaves its budget. */
const BREACH_EVENT_SUFFIX = ".breach"

export interface DiagnosisPipelineOptions {
    /** Receives each diagnosis. Failures here must not reach the producer. */
    readonly onDiagnosis: (diagnosis: RootCauseDiagnosis) => void
    readonly correlator?: IncidentCorrelator
    readonly analyzer?: RootCauseAnalyzer
}

/**
 * Does this event describe something going wrong?
 *
 * Two independent signals qualify: a producer that explicitly reported
 * `outcome: failure`, and the sampler reporting a budget breach. The second
 * matters most for this project's symptom — a saturated event loop produces no
 * failed operation, only degraded timings.
 */
function isFailureSignal(event: RuntimeTelemetryEvent): boolean {
    if (event.attributes[ANALYSIS_ATTRIBUTES.outcome] === OUTCOME.failure) return true
    return event.name.endsWith(BREACH_EVENT_SUFFIX)
}

export class DiagnosisPipeline {
    private readonly correlator: IncidentCorrelator
    private readonly analyzer: RootCauseAnalyzer
    private readonly onDiagnosis: (diagnosis: RootCauseDiagnosis) => void

    constructor(options: DiagnosisPipelineOptions) {
        this.correlator = options.correlator ?? new IncidentCorrelator()
        this.analyzer = options.analyzer ?? new RootCauseAnalyzer()
        this.onDiagnosis = options.onDiagnosis
    }

    /**
     * Feed one event through correlation and, when it signals a failure,
     * classification.
     *
     * Returns the diagnosis so callers can assert on it; production callers
     * ignore the result and rely on `onDiagnosis`.
     */
    observe(event: RuntimeTelemetryEvent): RootCauseDiagnosis | undefined {
        if (!isFailureSignal(event)) {
            this.correlator.observe(event)
            return undefined
        }

        const diagnosis = this.analyzer.analyze(this.correlator.correlate(event))
        this.onDiagnosis(diagnosis)
        return diagnosis
    }

    /** Drops retained history. Used when a session ends. */
    reset(): void {
        this.correlator.reset()
    }
}

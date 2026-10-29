import { emitSignal, isSignalRecordingEnabled, type SignalContext } from "../service/pipeline-port"
import { type DiagnosticDomain, type DiagnosticKind, type DiagnosticOutcome, diagnosticEventName } from "./diagnostic-events"

/**
 * Single entry point for recording a runtime diagnostic.
 *
 * Diagnostics answer "what happened" rather than "how long did it take", so
 * unlike `duration-recorder` there is no handle to hold open: the fact is
 * complete at the moment it is observed. What the two share is the disabled
 * contract — when recording is off this returns before building any attribute
 * object, so a call site pays a boolean check and nothing else.
 *
 * Recording is gated by the same predicate as performance recording. Splitting
 * the switches would let a user disable timings while diagnostics kept flowing,
 * which is not a distinction the telemetry setting offers.
 */

/** Dimensions attached to a diagnostic. Values must stay non-identifying. */
export type DiagnosticDimensions = Readonly<Record<string, string | number | boolean>>

/**
 * Record a diagnostic observation.
 *
 * Emitted at `Debug` priority so a burst of diagnostics is shed before
 * performance samples when the event queue is under pressure. The `outcome`
 * dimension is required because a diagnostic without one cannot be triaged:
 * the same kind means different things when it recovered versus when it failed.
 */
export function recordDiagnostic<D extends DiagnosticDomain>(
    domain: D,
    kind: DiagnosticKind<D>,
    outcome: DiagnosticOutcome,
    dimensions?: DiagnosticDimensions,
    context?: SignalContext,
): void {
    if (!isSignalRecordingEnabled()) return
    emitSignal({
        name: diagnosticEventName(domain, kind),
        level: "debug",
        attributes: { ...dimensions, outcome },
        context,
    })
}

/**
 * Whether diagnostics are currently being recorded.
 *
 * Exposed so a call site that would have to do real work to build its
 * dimensions — resolving a path, counting a collection — can skip that work
 * entirely rather than computing values the recorder will discard.
 */
export function isDiagnosticRecordingEnabled(): boolean {
    return isSignalRecordingEnabled()
}

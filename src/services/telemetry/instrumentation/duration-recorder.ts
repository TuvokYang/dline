import {
    configureSignalRecording,
    emitSignal,
    isSignalRecordingEnabled,
    recordDurationHistogram,
    resetSignalRecording,
    type SignalContext,
} from "../service/pipeline-port"
import { type PerfDomain, type PerfPhase, perfEventName } from "./perf-domains"

/**
 * Single entry point for recording how long a runtime phase took.
 *
 * The shape is deliberately "acquire a handle, then stop it" rather than
 * "compute a duration, then report it". A call site that computes the duration
 * itself must read the clock and build an attribute object before it can know
 * whether anyone is listening, which is exactly the cost telemetry must not
 * impose when it is switched off. Here, `startPerfPhase` returns a shared
 * no-op handle while telemetry is disabled, so the disabled path performs no
 * clock read, no object allocation, and no string interpolation.
 *
 * Measurements leave through the pipeline port rather than a runtime queue, so
 * this module stays independent of whichever pipeline is installed.
 */

/** Dimensions attached to a measurement. Values must stay non-identifying. */
export type PerfDimensions = Readonly<Record<string, string | number | boolean>>

/** Handle returned by `startPerfPhase`. Stopping it emits the measurement. */
export interface PerfPhaseHandle {
    /** Emit the measurement. Calling more than once is ignored. */
    stop(dimensions?: PerfDimensions): void
    /** Whether this handle will emit anything. Lets a caller skip its own prep work. */
    readonly active: boolean
}

/**
 * Shared handle used whenever recording is disabled.
 *
 * One frozen instance is reused for every disabled call site so that turning
 * telemetry off costs a boolean check and a constant return.
 */
const INERT_HANDLE: PerfPhaseHandle = Object.freeze({
    stop(): void {},
    active: false,
})

type Clock = () => number
type EnabledPredicate = () => boolean

let clock: Clock = () => performance.now()

/**
 * Configure the recorder.
 *
 * `enabled` is a predicate rather than a boolean because the user can change
 * the telemetry setting while the extension host is running; capturing the
 * value once would strand every call site on the setting that happened to be
 * active at module load. It is stored on the shared port so performance,
 * diagnostic, and domain recorders answer to one switch instead of drifting
 * apart.
 */
export function configurePerfRecorder(options: { enabled?: EnabledPredicate; now?: Clock }): void {
    if (options.enabled) configureSignalRecording({ enabled: options.enabled })
    if (options.now) clock = options.now
}

/** Restore the defaults. Intended for tests. */
export function resetPerfRecorder(): void {
    clock = () => performance.now()
    resetSignalRecording()
}

/** Whether measurements are currently being recorded. */
export function isPerfRecordingEnabled(): boolean {
    return isSignalRecordingEnabled()
}

class ActivePerfPhase implements PerfPhaseHandle {
    readonly active = true
    private stopped = false

    constructor(
        private readonly name: string,
        private readonly startedAt: number,
        private readonly context: SignalContext | undefined,
        private readonly baseDimensions: PerfDimensions | undefined,
    ) {}

    stop(dimensions?: PerfDimensions): void {
        if (this.stopped) return
        this.stopped = true
        const durationMs = Math.round(clock() - this.startedAt)
        const attributes = { ...this.baseDimensions, ...dimensions, durationMs }
        recordDurationHistogram(durationMs, metricAttributes(this.name, attributes))
        emitSignal({
            name: this.name,
            level: "performance",
            attributes,
            context: this.context,
        })
    }
}

/**
 * Begin measuring `phase` within `domain`.
 *
 * Dimensions may be supplied at start, at stop, or both; stop-time values win.
 * Splitting them matters because some dimensions (a terminal id) are known up
 * front while others (the outcome) are only known once the work finishes.
 */
export function startPerfPhase<D extends PerfDomain>(
    domain: D,
    phase: PerfPhase<D>,
    dimensions?: PerfDimensions,
    context?: SignalContext,
): PerfPhaseHandle {
    if (!isSignalRecordingEnabled()) return INERT_HANDLE
    return new ActivePerfPhase(perfEventName(domain, phase), clock(), context, dimensions)
}

/**
 * Record a duration the caller already measured.
 *
 * Used where the timing comes from an external source, such as a value handed
 * back by a child process or a span that started before this module was
 * reachable. Prefer `startPerfPhase` when the call site owns both endpoints.
 */
export function recordPerfPhase<D extends PerfDomain>(
    domain: D,
    phase: PerfPhase<D>,
    durationMs: number,
    dimensions?: PerfDimensions,
    context?: SignalContext,
): void {
    if (!isSignalRecordingEnabled()) return
    const roundedDurationMs = Math.round(durationMs)
    const attributes = { ...dimensions, durationMs: roundedDurationMs }
    recordDurationHistogram(roundedDurationMs, metricAttributes(perfEventName(domain, phase), attributes))
    emitSignal({
        name: perfEventName(domain, phase),
        level: "performance",
        attributes,
        context,
    })
}

/**
 * Record a phase that has no duration, such as an entry marker.
 *
 * Emitted at `Debug` priority so a burst of markers is dropped before real
 * timing data when the queue is under pressure.
 */
function metricAttributes(operation: string, dimensions: PerfDimensions): Record<string, string | number | boolean> {
    const attributes: Record<string, string | number | boolean> = { operation }
    for (const [key, value] of Object.entries(dimensions)) {
        if (key === "durationMs" || isIdentityDimension(key)) continue
        attributes[key] = value
    }
    return attributes
}

function isIdentityDimension(key: string): boolean {
    const normalized = key.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`).toLowerCase()
    return /(^|_)(id|ulid|user_id|task_id|controller_id|workspace_id|terminal_id|organization_id|member_id)$/.test(normalized)
}

export function markPerfPhase<D extends PerfDomain>(
    domain: D,
    phase: PerfPhase<D>,
    dimensions?: PerfDimensions,
    context?: SignalContext,
): void {
    if (!isSignalRecordingEnabled()) return
    emitSignal({
        name: perfEventName(domain, phase),
        level: "debug",
        attributes: dimensions,
        context,
    })
}

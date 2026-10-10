/**
 * Decides when a measured value is bad enough to report.
 *
 * A fixed threshold alone produces two failure modes we care about: it fires
 * constantly on a slow machine, and it stays silent on a fast machine that has
 * regressed. So a value is judged against both a fixed budget and a robust
 * baseline derived from the metric's own recent history, and only the stronger
 * verdict is kept.
 *
 * The baseline uses median + MAD rather than mean + standard deviation because
 * the samples we watch are latency-like: a single 3-second stall would drag a
 * mean far enough to hide every subsequent stall.
 */

import type { RuntimeAttributes } from "../types"

/** How serious a breach is. */
export enum AnomalySeverity {
    Warning = "warning",
    Critical = "critical",
}

/** Scale factor converting MAD to a standard-deviation-equivalent for normal data. */
const MAD_TO_SIGMA = 1.4826

/** Deviations above the baseline before a sample counts as anomalous. */
const DEFAULT_BASELINE_SIGMA = 6

/** Samples retained per metric for baseline computation. */
const DEFAULT_WINDOW_SIZE = 60

/** Minimum samples before a baseline is trusted; below this only fixed budgets apply. */
const MIN_BASELINE_SAMPLES = 12

/** Consecutive breaching samples before a non-critical anomaly is raised. */
const DEFAULT_CONSECUTIVE_BREACHES = 3

/** Consecutive healthy samples before an open incident is considered recovered. */
const DEFAULT_RECOVERY_SAMPLES = 3

/** Window within which repeated breaches of one metric fold into one incident. */
const DEFAULT_INCIDENT_WINDOW_MS = 30_000

/** Fixed budget for one metric, in the metric's own unit. */
export interface MetricBudget {
    /** Breaching this raises a warning after `consecutiveBreaches` samples. */
    readonly warning: number
    /** Breaching this raises a critical anomaly on the first sample. */
    readonly critical?: number
    /** Overrides the default consecutive-breach requirement for warnings. */
    readonly consecutiveBreaches?: number
}

export interface ThresholdPolicyOptions {
    readonly budgets: Readonly<Record<string, MetricBudget>>
    readonly windowSize?: number
    readonly baselineSigma?: number
    readonly recoverySamples?: number
    readonly incidentWindowMs?: number
}

/** One measurement handed to the policy. */
export interface MetricSample {
    readonly metric: string
    readonly value: number
    /** Monotonic milliseconds; used for incident windowing, never wall clock. */
    readonly monotonicMs: number
    /** Identity of the work being measured, so two tasks do not share an incident. */
    readonly scopeKey?: string
    readonly attributes?: RuntimeAttributes
}

/** Why a sample was judged anomalous. */
export enum BreachKind {
    /** Exceeded the configured fixed budget. */
    FixedBudget = "fixed_budget",
    /** Exceeded the robust baseline derived from recent samples. */
    DynamicBaseline = "dynamic_baseline",
}

export interface PerformanceAnomaly {
    readonly incidentId: string
    readonly metric: string
    readonly scopeKey: string
    readonly severity: AnomalySeverity
    readonly kind: BreachKind
    readonly value: number
    /** Budget or baseline limit the value exceeded. */
    readonly limit: number
    /** Median of the recent window, when a baseline was available. */
    readonly baseline?: number
    /** Number of consecutive breaching samples that produced this anomaly. */
    readonly consecutiveBreaches: number
    readonly monotonicMs: number
    readonly attributes?: RuntimeAttributes
}

export interface RecoveryNotice {
    readonly incidentId: string
    readonly metric: string
    readonly scopeKey: string
    readonly monotonicMs: number
    /** Milliseconds between the first breach and recovery. */
    readonly durationMs: number
}

/** Outcome of observing one sample. */
export interface PolicyVerdict {
    /** Present when this sample opened or escalated an incident. */
    readonly anomaly?: PerformanceAnomaly
    /** Present when this sample closed an open incident. */
    readonly recovery?: RecoveryNotice
    /** True when the sample breached a limit but was folded into an open incident. */
    readonly suppressed: boolean
}

interface MetricState {
    readonly samples: number[]
    consecutiveBreaches: number
    consecutiveHealthy: number
    incident?: {
        readonly id: string
        readonly startedAtMs: number
        lastBreachAtMs: number
        severity: AnomalySeverity
    }
}

/**
 * Robust spread of a sorted sample window.
 *
 * Returns `undefined` when MAD is zero, which happens whenever more than half
 * the window holds the same value. Treating that as "zero tolerance" would make
 * every subsequent sample anomalous, so callers fall back to the fixed budget.
 */
function medianAbsoluteDeviation(sorted: readonly number[], median: number): number | undefined {
    const deviations = sorted.map((value) => Math.abs(value - median)).sort((a, b) => a - b)
    const mad = percentileOfSorted(deviations, 0.5)
    return mad > 0 ? mad : undefined
}

function percentileOfSorted(sorted: readonly number[], fraction: number): number {
    if (sorted.length === 0) {
        return 0
    }
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))))
    return sorted[index] as number
}

export class ThresholdPolicy {
    private readonly budgets: Readonly<Record<string, MetricBudget>>
    private readonly windowSize: number
    private readonly baselineSigma: number
    private readonly recoverySamples: number
    private readonly incidentWindowMs: number
    private readonly states = new Map<string, MetricState>()
    private incidentCounter = 0

    constructor(options: ThresholdPolicyOptions) {
        this.budgets = options.budgets
        this.windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE
        this.baselineSigma = options.baselineSigma ?? DEFAULT_BASELINE_SIGMA
        this.recoverySamples = options.recoverySamples ?? DEFAULT_RECOVERY_SAMPLES
        this.incidentWindowMs = options.incidentWindowMs ?? DEFAULT_INCIDENT_WINDOW_MS
    }

    /**
     * Judges one sample and updates the metric's rolling state.
     *
     * The sample is always appended to the window, including breaching samples:
     * excluding them would freeze the baseline at the pre-regression level and
     * report a permanent anomaly after a genuine, stable slowdown.
     */
    observe(sample: MetricSample): PolicyVerdict {
        const scopeKey = sample.scopeKey ?? "global"
        const stateKey = `${sample.metric}::${scopeKey}`
        const state = this.stateFor(stateKey)

        const breach = this.evaluate(sample, state)
        this.appendSample(state, sample.value)

        if (!breach) {
            return this.handleHealthySample(state, sample, scopeKey)
        }

        state.consecutiveHealthy = 0
        state.consecutiveBreaches += 1

        const budget = this.budgets[sample.metric]
        const required =
            breach.severity === AnomalySeverity.Critical ? 1 : (budget?.consecutiveBreaches ?? DEFAULT_CONSECUTIVE_BREACHES)

        if (state.consecutiveBreaches < required) {
            return { suppressed: false }
        }

        return this.openOrEscalate(state, sample, scopeKey, breach)
    }

    /** Drops all rolling state, for example when a session ends. */
    reset(): void {
        this.states.clear()
    }

    private stateFor(key: string): MetricState {
        const existing = this.states.get(key)
        if (existing) {
            return existing
        }
        const created: MetricState = { samples: [], consecutiveBreaches: 0, consecutiveHealthy: 0 }
        this.states.set(key, created)
        return created
    }

    private appendSample(state: MetricState, value: number): void {
        state.samples.push(value)
        if (state.samples.length > this.windowSize) {
            state.samples.shift()
        }
    }

    private evaluate(
        sample: MetricSample,
        state: MetricState,
    ): { severity: AnomalySeverity; kind: BreachKind; limit: number; baseline?: number } | undefined {
        const budget = this.budgets[sample.metric]

        if (budget?.critical !== undefined && sample.value > budget.critical) {
            return { severity: AnomalySeverity.Critical, kind: BreachKind.FixedBudget, limit: budget.critical }
        }
        if (budget !== undefined && sample.value > budget.warning) {
            return { severity: AnomalySeverity.Warning, kind: BreachKind.FixedBudget, limit: budget.warning }
        }

        const baseline = this.baselineFor(state)
        if (baseline !== undefined && sample.value > baseline.limit) {
            return {
                severity: AnomalySeverity.Warning,
                kind: BreachKind.DynamicBaseline,
                limit: baseline.limit,
                baseline: baseline.median,
            }
        }
        return undefined
    }

    private baselineFor(state: MetricState): { median: number; limit: number } | undefined {
        if (state.samples.length < MIN_BASELINE_SAMPLES) {
            return undefined
        }
        const sorted = [...state.samples].sort((a, b) => a - b)
        const median = percentileOfSorted(sorted, 0.5)
        const mad = medianAbsoluteDeviation(sorted, median)
        if (mad === undefined) {
            return undefined
        }
        return { median, limit: median + this.baselineSigma * MAD_TO_SIGMA * mad }
    }

    private handleHealthySample(state: MetricState, sample: MetricSample, scopeKey: string): PolicyVerdict {
        state.consecutiveBreaches = 0
        const incident = state.incident
        if (!incident) {
            state.consecutiveHealthy = 0
            return { suppressed: false }
        }

        state.consecutiveHealthy += 1
        if (state.consecutiveHealthy < this.recoverySamples) {
            return { suppressed: false }
        }

        state.incident = undefined
        state.consecutiveHealthy = 0
        return {
            suppressed: false,
            recovery: {
                incidentId: incident.id,
                metric: sample.metric,
                scopeKey,
                monotonicMs: sample.monotonicMs,
                durationMs: sample.monotonicMs - incident.startedAtMs,
            },
        }
    }

    private openOrEscalate(
        state: MetricState,
        sample: MetricSample,
        scopeKey: string,
        breach: { severity: AnomalySeverity; kind: BreachKind; limit: number; baseline?: number },
    ): PolicyVerdict {
        const open = state.incident
        const withinWindow = open !== undefined && sample.monotonicMs - open.lastBreachAtMs <= this.incidentWindowMs

        if (open && withinWindow) {
            open.lastBreachAtMs = sample.monotonicMs
            // A warning that follows an open incident adds nothing; only an
            // escalation to critical is worth a second report.
            if (breach.severity !== AnomalySeverity.Critical || open.severity === AnomalySeverity.Critical) {
                return { suppressed: true }
            }
            open.severity = AnomalySeverity.Critical
            return { suppressed: false, anomaly: this.buildAnomaly(open.id, state, sample, scopeKey, breach) }
        }

        this.incidentCounter += 1
        const incidentId = `incident-${this.incidentCounter}`
        state.incident = {
            id: incidentId,
            startedAtMs: sample.monotonicMs,
            lastBreachAtMs: sample.monotonicMs,
            severity: breach.severity,
        }
        return { suppressed: false, anomaly: this.buildAnomaly(incidentId, state, sample, scopeKey, breach) }
    }

    private buildAnomaly(
        incidentId: string,
        state: MetricState,
        sample: MetricSample,
        scopeKey: string,
        breach: { severity: AnomalySeverity; kind: BreachKind; limit: number; baseline?: number },
    ): PerformanceAnomaly {
        return {
            incidentId,
            metric: sample.metric,
            scopeKey,
            severity: breach.severity,
            kind: breach.kind,
            value: sample.value,
            limit: breach.limit,
            baseline: breach.baseline,
            consecutiveBreaches: state.consecutiveBreaches,
            monotonicMs: sample.monotonicMs,
            attributes: sample.attributes,
        }
    }
}

/**
 * Default budgets from the WS-017 performance contract.
 *
 * Units are milliseconds unless the metric name says otherwise; ratios are
 * expressed as fractions of one so a consumer never has to guess whether 85
 * means percent or milliseconds.
 */
export const DEFAULT_METRIC_BUDGETS: Readonly<Record<string, MetricBudget>> = {
    "runtime.event_loop_delay_ms": { warning: 200, critical: 1000 },
    "runtime.cpu_utilization_ratio": { warning: 0.85 },
    "runtime.heap_growth_bytes": { warning: 128 * 1024 * 1024 },
    "state.build_duration_ms": { warning: 100 },
    "provider.local_prepare_ms": { warning: 250 },
    "persistence.journal_append_ms": { warning: 25 },
    "persistence.journal_queue_wait_ms": { warning: 100 },
    "telemetry.queue_occupancy_ratio": { warning: 0.75 },
}

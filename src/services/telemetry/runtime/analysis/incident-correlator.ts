/**
 * Gathers the events surrounding a failure so it can be explained.
 *
 * The correlator keeps a bounded ring of recent events per scope. When a
 * failure arrives it hands the analyzer the events that preceded it plus the
 * last time the same operation succeeded — the contrast between "worked then"
 * and "failed now" is what makes a diagnosis possible.
 *
 * Ordering uses the bus `sequence`, never arrival time at a collector. A
 * transport that reorders or retries would otherwise invent false causality.
 */

import type { RuntimeTelemetryEvent } from "../types"
import { ANALYSIS_ATTRIBUTES, OUTCOME } from "./root-cause-analyzer"
import type { Incident } from "./root-cause-types"

/** Events retained per scope for correlation. */
const DEFAULT_HISTORY_SIZE = 50

/** How far back a preceding event may be and still be considered related. */
const DEFAULT_CORRELATION_WINDOW_MS = 30_000

export interface IncidentCorrelatorOptions {
    readonly historySize?: number
    readonly correlationWindowMs?: number
}

function stringAttr(event: RuntimeTelemetryEvent, key: string): string | undefined {
    const value = event.attributes[key]
    return typeof value === "string" ? value : undefined
}

/**
 * Scope key for correlation.
 *
 * Task id separates concurrent editor panels; without it a failure in one task
 * would be explained using another task's events.
 */
function scopeKeyOf(event: RuntimeTelemetryEvent): string {
    return event.context.taskId ?? event.context.controllerId ?? event.context.sessionId
}

function operationKeyOf(event: RuntimeTelemetryEvent): string {
    const component = stringAttr(event, ANALYSIS_ATTRIBUTES.component) ?? "unknown"
    const operation = stringAttr(event, ANALYSIS_ATTRIBUTES.operation) ?? "unknown"
    return `${component}::${operation}`
}

export class IncidentCorrelator {
    private readonly historySize: number
    private readonly correlationWindowMs: number
    private readonly history = new Map<string, RuntimeTelemetryEvent[]>()
    private readonly lastSuccess = new Map<string, RuntimeTelemetryEvent>()
    private incidentCounter = 0

    constructor(options: IncidentCorrelatorOptions = {}) {
        this.historySize = options.historySize ?? DEFAULT_HISTORY_SIZE
        this.correlationWindowMs = options.correlationWindowMs ?? DEFAULT_CORRELATION_WINDOW_MS
    }

    /** Records an event that is not itself a failure. */
    observe(event: RuntimeTelemetryEvent): void {
        this.remember(event)
        if (stringAttr(event, ANALYSIS_ATTRIBUTES.outcome) === OUTCOME.success) {
            this.lastSuccess.set(`${scopeKeyOf(event)}::${operationKeyOf(event)}`, event)
        }
    }

    /**
     * Builds an incident around a failing event.
     *
     * The failing event is recorded too, so a later failure can cite it as a
     * preceding cause — repeated failures of the same dependency are themselves
     * evidence.
     */
    correlate(failingEvent: RuntimeTelemetryEvent): Incident {
        const scopeKey = scopeKeyOf(failingEvent)
        const preceding = this.precedingWithinWindow(scopeKey, failingEvent)
        const lastSuccess = this.lastSuccess.get(`${scopeKey}::${operationKeyOf(failingEvent)}`)

        this.remember(failingEvent)
        this.incidentCounter += 1

        return {
            incidentId: `rc-${this.incidentCounter}`,
            failingEvent,
            precedingEvents: preceding,
            lastSuccess,
        }
    }

    /** Drops retained history, for example when a session ends. */
    reset(): void {
        this.history.clear()
        this.lastSuccess.clear()
    }

    private remember(event: RuntimeTelemetryEvent): void {
        const key = scopeKeyOf(event)
        const bucket = this.history.get(key) ?? []
        bucket.push(event)
        if (bucket.length > this.historySize) {
            bucket.shift()
        }
        this.history.set(key, bucket)
    }

    private precedingWithinWindow(scopeKey: string, failingEvent: RuntimeTelemetryEvent): RuntimeTelemetryEvent[] {
        const bucket = this.history.get(scopeKey) ?? []
        const cutoff = failingEvent.monotonicMs - this.correlationWindowMs
        return bucket
            .filter((event) => event.sequence < failingEvent.sequence && event.monotonicMs >= cutoff)
            .sort((a, b) => a.sequence - b.sequence)
    }
}

/**
 * Turns a correlated incident into a named cause.
 *
 * The rules are ordered and deterministic. That matters more than cleverness:
 * a diagnosis a maintainer cannot re-derive from the same events is worse than
 * no diagnosis, because it invites chasing the wrong component.
 *
 * Every rule must cite at least two events. A single slow span proves that
 * something was slow, not what caused it; the second event is what excludes
 * the competing explanation.
 */

import type { RuntimeTelemetryEvent } from "../types"
import {
    DiagnosisConfidence,
    type Incident,
    MissingEvidence,
    RootCauseCategory,
    type RootCauseDiagnosis,
} from "./root-cause-types"

/**
 * Attribute names the analyzer reads.
 *
 * Producers agree to these names so the rules can stay free of per-call-site
 * special cases.
 */
export const ANALYSIS_ATTRIBUTES = {
    component: "component",
    operation: "operation",
    outcome: "outcome",
    /** Total wall time of the operation. */
    durationMs: "durationMs",
    /** Time spent preparing the request locally, before any network wait. */
    localPrepareMs: "localPrepareMs",
    /** Time from request sent to first upstream byte. */
    upstreamTtfbMs: "upstreamTtfbMs",
    /** Time spent consuming the response stream. */
    streamMs: "streamMs",
    /** Observed event-loop delay at the time of the operation. */
    eventLoopDelayMs: "eventLoopDelayMs",
    /** Serialized size of the state projection. */
    stateBytes: "stateBytes",
    /** Time spent building the state projection. */
    buildMs: "buildMs",
    /** Time the extension host spent delivering state over gRPC. */
    transportMs: "transportMs",
    /** Time the webview spent applying and rendering the update. */
    renderMs: "renderMs",
    /** Time an append waited in the journal queue. */
    queueWaitMs: "queueWaitMs",
    /** Time the journal append itself took. */
    appendMs: "appendMs",
    /** Time spent establishing an MCP connection. */
    connectMs: "connectMs",
    /** Time the command process itself ran. */
    commandRuntimeMs: "commandRuntimeMs",
    /** Time spent capturing and finalizing command output after exit. */
    captureMs: "captureMs",
    /** HTTP status reported by an upstream dependency. */
    statusCode: "statusCode",
    /** True once the response stream produced at least one chunk. */
    streamStarted: "streamStarted",
} as const

/** Outcome values producers report. */
export const OUTCOME = {
    success: "success",
    failure: "failure",
} as const

/** Thresholds separating "normal" from "notable" during classification. */
const CLASSIFICATION_LIMITS = {
    eventLoopBlockedMs: 200,
    localPrepareMs: 250,
    stateBuildMs: 100,
    renderMs: 100,
    queueWaitMs: 100,
    appendMs: 25,
    captureMs: 250,
} as const

function attr(event: RuntimeTelemetryEvent | undefined, key: string): unknown {
    return event?.attributes[key]
}

function numberAttr(event: RuntimeTelemetryEvent | undefined, key: string): number | undefined {
    const value = attr(event, key)
    return typeof value === "number" ? value : undefined
}

function stringAttr(event: RuntimeTelemetryEvent | undefined, key: string): string | undefined {
    const value = attr(event, key)
    return typeof value === "string" ? value : undefined
}

/** A candidate explanation produced by one rule. */
interface RuleResult {
    readonly category: RootCauseCategory
    readonly confidence: DiagnosisConfidence
    readonly evidenceEventIds: readonly string[]
    readonly reproductionSteps: readonly string[]
}

type Rule = (incident: Incident) => RuleResult | undefined

/** Finds the most recent preceding event matching a predicate. */
function findLatest(incident: Incident, predicate: (event: RuntimeTelemetryEvent) => boolean): RuntimeTelemetryEvent | undefined {
    for (let i = incident.precedingEvents.length - 1; i >= 0; i--) {
        const candidate = incident.precedingEvents[i] as RuntimeTelemetryEvent
        if (predicate(candidate)) {
            return candidate
        }
    }
    return undefined
}

/** The runtime health snapshot closest to the failure, if one was recorded. */
function findRuntimeSnapshot(incident: Incident): RuntimeTelemetryEvent | undefined {
    return findLatest(incident, (event) => stringAttr(event, ANALYSIS_ATTRIBUTES.component) === "runtime")
}

function observedEventLoopDelayMs(incident: Incident): number | undefined {
    const inline = numberAttr(incident.failingEvent, ANALYSIS_ATTRIBUTES.eventLoopDelayMs)
    if (inline !== undefined) {
        return inline
    }
    return numberAttr(findRuntimeSnapshot(incident), ANALYSIS_ATTRIBUTES.eventLoopDelayMs)
}

/**
 * Authentication and rate limiting are decided by status code alone.
 *
 * These come first because a 401 explains the failure completely; any latency
 * measured alongside it is a consequence, not a cause.
 */
const providerStatusRule: Rule = (incident) => {
    const event = incident.failingEvent
    if (stringAttr(event, ANALYSIS_ATTRIBUTES.component) !== "provider") {
        return undefined
    }
    const status = numberAttr(event, ANALYSIS_ATTRIBUTES.statusCode)
    if (status === undefined) {
        return undefined
    }

    const evidence = [event.eventId, ...(incident.lastSuccess ? [incident.lastSuccess.eventId] : [])]
    if (status === 401 || status === 403) {
        return {
            category: RootCauseCategory.ProviderAuthentication,
            confidence: DiagnosisConfidence.High,
            evidenceEventIds: evidence,
            reproductionSteps: [
                "Select the same provider and model",
                "Issue any request with the stored credentials",
                `Observe the upstream rejection with status ${status}`,
            ],
        }
    }
    if (status === 429) {
        return {
            category: RootCauseCategory.ProviderRateLimit,
            confidence: DiagnosisConfidence.High,
            evidenceEventIds: evidence,
            reproductionSteps: [
                "Select the same provider and model",
                "Issue requests until the upstream quota is reached",
                "Observe status 429 and the retry-after hint",
            ],
        }
    }
    return undefined
}

/** A stream that started and then failed points at the protocol, not latency. */
const providerStreamRule: Rule = (incident) => {
    const event = incident.failingEvent
    if (stringAttr(event, ANALYSIS_ATTRIBUTES.component) !== "provider") {
        return undefined
    }
    if (attr(event, ANALYSIS_ATTRIBUTES.streamStarted) !== true) {
        return undefined
    }
    if (stringAttr(event, ANALYSIS_ATTRIBUTES.outcome) !== OUTCOME.failure) {
        return undefined
    }

    const streamStart = findLatest(
        incident,
        (candidate) =>
            stringAttr(candidate, ANALYSIS_ATTRIBUTES.component) === "provider" &&
            attr(candidate, ANALYSIS_ATTRIBUTES.streamStarted) === true,
    )
    return {
        category: RootCauseCategory.ProviderStreamProtocol,
        confidence: DiagnosisConfidence.High,
        evidenceEventIds: [event.eventId, ...(streamStart ? [streamStart.eventId] : [])],
        reproductionSteps: [
            "Select the same provider and model",
            "Issue a streaming request",
            "Observe that the stream starts and then fails before completion",
        ],
    }
}

/**
 * A slow provider call is only the provider's fault if our loop was healthy.
 *
 * Without that check a blocked extension host looks exactly like a slow API:
 * both show a large total duration.
 */
const providerLatencyRule: Rule = (incident) => {
    const event = incident.failingEvent
    if (stringAttr(event, ANALYSIS_ATTRIBUTES.component) !== "provider") {
        return undefined
    }
    const ttfb = numberAttr(event, ANALYSIS_ATTRIBUTES.upstreamTtfbMs)
    const localPrepare = numberAttr(event, ANALYSIS_ATTRIBUTES.localPrepareMs)
    if (ttfb === undefined) {
        return undefined
    }

    const loopDelay = observedEventLoopDelayMs(incident)
    const loopHealthy = loopDelay !== undefined && loopDelay < CLASSIFICATION_LIMITS.eventLoopBlockedMs
    const localFast = localPrepare === undefined || localPrepare < CLASSIFICATION_LIMITS.localPrepareMs
    if (!localFast || ttfb <= (localPrepare ?? 0)) {
        return undefined
    }

    const snapshot = findRuntimeSnapshot(incident)
    return {
        category: RootCauseCategory.ProviderUpstreamLatency,
        confidence: loopHealthy ? DiagnosisConfidence.High : DiagnosisConfidence.Medium,
        evidenceEventIds: [event.eventId, ...(snapshot ? [snapshot.eventId] : [])],
        reproductionSteps: [
            "Select the same provider and model",
            "Issue a request and measure time to first byte",
            "Confirm local preparation stays well under the upstream wait",
        ],
    }
}

/** A blocked loop makes every local phase slow, so it is diagnosed on its own. */
const eventLoopRule: Rule = (incident) => {
    const loopDelay = observedEventLoopDelayMs(incident)
    if (loopDelay === undefined || loopDelay < CLASSIFICATION_LIMITS.eventLoopBlockedMs) {
        return undefined
    }
    const localPrepare = numberAttr(incident.failingEvent, ANALYSIS_ATTRIBUTES.localPrepareMs)
    if (localPrepare === undefined || localPrepare < CLASSIFICATION_LIMITS.localPrepareMs) {
        return undefined
    }

    const snapshot = findRuntimeSnapshot(incident)
    return {
        category: RootCauseCategory.RuntimeEventLoopBlocked,
        confidence: DiagnosisConfidence.High,
        evidenceEventIds: [incident.failingEvent.eventId, ...(snapshot ? [snapshot.eventId] : [])],
        reproductionSteps: [
            "Reproduce the same workload concurrency",
            "Sample event-loop delay during the operation",
            "Confirm local phases slow down in step with the delay",
        ],
    }
}

/** State build cost scales with projection size, so both are required. */
const stateProjectionRule: Rule = (incident) => {
    const event = incident.failingEvent
    if (stringAttr(event, ANALYSIS_ATTRIBUTES.component) !== "state") {
        return undefined
    }
    const buildMs = numberAttr(event, ANALYSIS_ATTRIBUTES.buildMs)
    const stateBytes = numberAttr(event, ANALYSIS_ATTRIBUTES.stateBytes)
    if (buildMs === undefined || buildMs < CLASSIFICATION_LIMITS.stateBuildMs || stateBytes === undefined) {
        return undefined
    }

    const priorBuild = findLatest(incident, (candidate) => stringAttr(candidate, ANALYSIS_ATTRIBUTES.component) === "state")
    return {
        category: RootCauseCategory.StateProjectionSerialization,
        confidence: DiagnosisConfidence.High,
        evidenceEventIds: [event.eventId, ...(priorBuild ? [priorBuild.eventId] : [])],
        reproductionSteps: [
            "Open a task with a comparable message count",
            "Trigger a state broadcast",
            "Measure projection build time against serialized size",
        ],
    }
}

/** Blaming the webview requires showing that delivery to it was fast. */
const webviewRenderRule: Rule = (incident) => {
    const event = incident.failingEvent
    if (stringAttr(event, ANALYSIS_ATTRIBUTES.component) !== "webview") {
        return undefined
    }
    const renderMs = numberAttr(event, ANALYSIS_ATTRIBUTES.renderMs)
    const transportMs = numberAttr(event, ANALYSIS_ATTRIBUTES.transportMs)
    if (renderMs === undefined || renderMs < CLASSIFICATION_LIMITS.renderMs) {
        return undefined
    }
    if (transportMs === undefined || transportMs >= renderMs) {
        return undefined
    }

    const delivery = findLatest(incident, (candidate) => numberAttr(candidate, ANALYSIS_ATTRIBUTES.transportMs) !== undefined)
    return {
        category: RootCauseCategory.WebviewRenderLatency,
        confidence: DiagnosisConfidence.High,
        evidenceEventIds: [event.eventId, ...(delivery ? [delivery.eventId] : [])],
        reproductionSteps: [
            "Open the same view with a comparable message count",
            "Push a state update and record transport and render phases",
            "Confirm transport completes well before rendering finishes",
        ],
    }
}

/** Queue wait and append time separate "disk is slow" from "we asked too often". */
const persistenceRule: Rule = (incident) => {
    const event = incident.failingEvent
    if (stringAttr(event, ANALYSIS_ATTRIBUTES.component) !== "persistence") {
        return undefined
    }
    const queueWaitMs = numberAttr(event, ANALYSIS_ATTRIBUTES.queueWaitMs)
    const appendMs = numberAttr(event, ANALYSIS_ATTRIBUTES.appendMs)
    if (queueWaitMs === undefined || appendMs === undefined) {
        return undefined
    }
    if (queueWaitMs < CLASSIFICATION_LIMITS.queueWaitMs || appendMs < CLASSIFICATION_LIMITS.appendMs) {
        return undefined
    }

    const priorWrite = findLatest(incident, (candidate) => stringAttr(candidate, ANALYSIS_ATTRIBUTES.component) === "persistence")
    return {
        category: RootCauseCategory.PersistenceDiskBackpressure,
        confidence: DiagnosisConfidence.High,
        evidenceEventIds: [event.eventId, ...(priorWrite ? [priorWrite.eventId] : [])],
        reproductionSteps: [
            "Run the same number of concurrent tasks",
            "Record journal queue wait and append duration",
            "Confirm both exceed their budgets together",
        ],
    }
}

/**
 * A connect or reconnect before the failure implicates the transport.
 *
 * Checked before tool latency: a tool call that fails right after a reconnect
 * is a symptom of the reconnect, and reporting it as slow tooling would send
 * the reader to the wrong server.
 */
const mcpTransportRule: Rule = (incident) => {
    const event = incident.failingEvent
    if (stringAttr(event, ANALYSIS_ATTRIBUTES.component) !== "mcp") {
        return undefined
    }
    const connect = findLatest(
        incident,
        (candidate) =>
            stringAttr(candidate, ANALYSIS_ATTRIBUTES.component) === "mcp" &&
            stringAttr(candidate, ANALYSIS_ATTRIBUTES.operation) === "connect",
    )
    if (!connect) {
        return undefined
    }
    const connectFailed = stringAttr(connect, ANALYSIS_ATTRIBUTES.outcome) === OUTCOME.failure
    if (!connectFailed) {
        return undefined
    }

    return {
        category: RootCauseCategory.McpTransportLifecycle,
        confidence: DiagnosisConfidence.High,
        evidenceEventIds: [event.eventId, connect.eventId],
        reproductionSteps: [
            "Configure the same MCP server",
            "Restart the server so the client reconnects",
            "Invoke a tool during the reconnect window",
        ],
    }
}

/** With a healthy connection, a slow MCP call is the tool's own cost. */
const mcpToolRule: Rule = (incident) => {
    const event = incident.failingEvent
    if (stringAttr(event, ANALYSIS_ATTRIBUTES.component) !== "mcp") {
        return undefined
    }
    if (stringAttr(event, ANALYSIS_ATTRIBUTES.operation) !== "call_tool") {
        return undefined
    }
    const durationMs = numberAttr(event, ANALYSIS_ATTRIBUTES.durationMs)
    if (durationMs === undefined) {
        return undefined
    }
    const connect = findLatest(
        incident,
        (candidate) =>
            stringAttr(candidate, ANALYSIS_ATTRIBUTES.component) === "mcp" &&
            stringAttr(candidate, ANALYSIS_ATTRIBUTES.operation) === "connect",
    )
    const connectHealthy = connect !== undefined && stringAttr(connect, ANALYSIS_ATTRIBUTES.outcome) === OUTCOME.success
    if (!connectHealthy) {
        return undefined
    }

    return {
        category: RootCauseCategory.McpToolLatency,
        confidence: DiagnosisConfidence.High,
        evidenceEventIds: [event.eventId, (connect as RuntimeTelemetryEvent).eventId],
        reproductionSteps: [
            "Connect to the same MCP server and confirm the handshake succeeds",
            "Invoke the same tool",
            "Measure the call duration against the connect duration",
        ],
    }
}

/** Output finalization is separate from the command's own runtime. */
const terminalRule: Rule = (incident) => {
    const event = incident.failingEvent
    if (stringAttr(event, ANALYSIS_ATTRIBUTES.component) !== "terminal") {
        return undefined
    }
    const captureMs = numberAttr(event, ANALYSIS_ATTRIBUTES.captureMs)
    const commandRuntimeMs = numberAttr(event, ANALYSIS_ATTRIBUTES.commandRuntimeMs)
    if (captureMs === undefined || commandRuntimeMs === undefined) {
        return undefined
    }
    if (captureMs < CLASSIFICATION_LIMITS.captureMs || captureMs <= commandRuntimeMs) {
        return undefined
    }

    const priorCommand = findLatest(incident, (candidate) => stringAttr(candidate, ANALYSIS_ATTRIBUTES.component) === "terminal")
    return {
        category: RootCauseCategory.TerminalOutputFinalization,
        confidence: DiagnosisConfidence.High,
        evidenceEventIds: [event.eventId, ...(priorCommand ? [priorCommand.eventId] : [])],
        reproductionSteps: [
            "Run a command producing a comparable volume of output",
            "Record command runtime and output capture separately",
            "Confirm capture dominates after the process exits",
        ],
    }
}

/** A rejected transition or failed effect before the error indicates our own bug. */
const taskInvariantRule: Rule = (incident) => {
    const invariant = findLatest(
        incident,
        (candidate) =>
            stringAttr(candidate, ANALYSIS_ATTRIBUTES.component) === "task" &&
            stringAttr(candidate, ANALYSIS_ATTRIBUTES.outcome) === OUTCOME.failure,
    )
    if (!invariant) {
        return undefined
    }
    return {
        category: RootCauseCategory.TaskRuntimeInvariant,
        confidence: DiagnosisConfidence.High,
        evidenceEventIds: [incident.failingEvent.eventId, invariant.eventId],
        reproductionSteps: [
            "Drive the task into the same phase",
            "Trigger the transition recorded before the failure",
            "Observe the rejected transition or failed effect",
        ],
    }
}

/**
 * Telemetry problems must never be reported as product problems.
 *
 * Placed last so a genuine business failure occurring while the collector is
 * also down is still attributed to the business component.
 */
const telemetryHealthRule: Rule = (incident) => {
    const event = incident.failingEvent
    if (stringAttr(event, ANALYSIS_ATTRIBUTES.component) !== "telemetry") {
        return undefined
    }
    const prior = findLatest(incident, (candidate) => stringAttr(candidate, ANALYSIS_ATTRIBUTES.component) === "telemetry")
    return {
        category: RootCauseCategory.TelemetryTransportUnhealthy,
        confidence: DiagnosisConfidence.High,
        evidenceEventIds: [event.eventId, ...(prior ? [prior.eventId] : [])],
        reproductionSteps: [
            "Stop the local collector",
            "Enable telemetry and generate events",
            "Observe transport failures while product operations still succeed",
        ],
    }
}

/**
 * Ordered rules. The first match wins.
 *
 * Order encodes precedence between overlapping explanations, so changing it
 * changes diagnoses. Status and stream rules precede latency because a
 * definitive failure outranks a timing observation; transport precedes tool
 * latency for the same reason.
 */
const RULES: readonly Rule[] = [
    providerStatusRule,
    providerStreamRule,
    eventLoopRule,
    providerLatencyRule,
    stateProjectionRule,
    webviewRenderRule,
    persistenceRule,
    mcpTransportRule,
    mcpToolRule,
    terminalRule,
    taskInvariantRule,
    telemetryHealthRule,
]

function collectMissingEvidence(incident: Incident): MissingEvidence[] {
    const missing: MissingEvidence[] = []
    if (!findRuntimeSnapshot(incident)) {
        missing.push(MissingEvidence.RuntimeSnapshot)
    }
    const hasTimings = [
        ANALYSIS_ATTRIBUTES.durationMs,
        ANALYSIS_ATTRIBUTES.upstreamTtfbMs,
        ANALYSIS_ATTRIBUTES.localPrepareMs,
        ANALYSIS_ATTRIBUTES.buildMs,
        ANALYSIS_ATTRIBUTES.renderMs,
        ANALYSIS_ATTRIBUTES.appendMs,
        ANALYSIS_ATTRIBUTES.captureMs,
    ].some((key) => numberAttr(incident.failingEvent, key) !== undefined)
    if (!hasTimings) {
        missing.push(MissingEvidence.PhaseTimings)
    }
    if (!incident.failingEvent.error) {
        missing.push(MissingEvidence.NormalizedError)
    }
    if (!incident.lastSuccess) {
        missing.push(MissingEvidence.PriorSuccess)
    }
    return missing
}

export class RootCauseAnalyzer {
    /**
     * Classifies one incident.
     *
     * Returns `Unknown` with `missingEvidence` rather than guessing: an
     * incorrect category costs more investigation time than an honest gap.
     */
    analyze(incident: Incident): RootCauseDiagnosis {
        for (const rule of RULES) {
            const result = rule(incident)
            if (result) {
                return {
                    incidentId: incident.incidentId,
                    category: result.category,
                    confidence: result.confidence,
                    component: stringAttr(incident.failingEvent, ANALYSIS_ATTRIBUTES.component) ?? "unknown",
                    operation: stringAttr(incident.failingEvent, ANALYSIS_ATTRIBUTES.operation) ?? "unknown",
                    evidenceEventIds: result.evidenceEventIds,
                    failingEventId: incident.failingEvent.eventId,
                    lastSuccessEventId: incident.lastSuccess?.eventId,
                    reproductionSteps: result.reproductionSteps,
                }
            }
        }

        return {
            incidentId: incident.incidentId,
            category: RootCauseCategory.Unknown,
            confidence: DiagnosisConfidence.Low,
            component: stringAttr(incident.failingEvent, ANALYSIS_ATTRIBUTES.component) ?? "unknown",
            operation: stringAttr(incident.failingEvent, ANALYSIS_ATTRIBUTES.operation) ?? "unknown",
            evidenceEventIds: [incident.failingEvent.eventId],
            failingEventId: incident.failingEvent.eventId,
            lastSuccessEventId: incident.lastSuccess?.eventId,
            reproductionSteps: [
                "Re-run the same operation with telemetry enabled",
                "Capture the missing evidence listed with this diagnosis",
            ],
            missingEvidence: collectMissingEvidence(incident),
        }
    }
}

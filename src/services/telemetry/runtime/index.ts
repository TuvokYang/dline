import { runtimeEventRecorder } from "../events/runtime"
import { RuntimeEventBus, type RuntimeEventBusOptions } from "./runtime-event-bus"
import type { RuntimeTelemetryContext } from "./types"

export { IncidentCorrelator, type IncidentCorrelatorOptions } from "./analysis/incident-correlator"
export { ANALYSIS_ATTRIBUTES, OUTCOME, RootCauseAnalyzer } from "./analysis/root-cause-analyzer"
export {
    DiagnosisConfidence,
    type Incident,
    MissingEvidence,
    RootCauseCategory,
    type RootCauseDiagnosis,
} from "./analysis/root-cause-types"
export { AttributeRejection, RuntimeContentPolicy, runtimeContentPolicyLimits } from "./content-policy"
export { RuntimeTelemetryContextHolder, type RuntimeTelemetryScope } from "./context"
export { normalizeRuntimeError } from "./error-normalizer"
export { type BuildIdentity, readBuildIdentity, UNKNOWN_BUILD_ID } from "./export/build-identity"
export { BundleArchiveError, type BundleArchiveResult, writeBundleArchive } from "./export/bundle-archive-writer"
export {
    type BuiltBundle,
    type BuiltBundleEntry,
    type BundleEnvironment,
    type BundleInput,
    buildDiagnosticBundle,
    type RawArtifact,
    type ScenarioStep,
    verifyBundleChecksums,
} from "./export/bundle-builder"
export {
    BUNDLE_ENTRIES,
    type BundleChecksums,
    type BundleEntryName,
    type BundleManifest,
    isForbiddenBundleField,
    redactBundleValue,
} from "./export/bundle-contract"
export {
    type DiagnosticSource,
    describeEnvironment,
    type ExportRequest,
    type ExportResult,
    exportDiagnosticBundle,
    type RawArtifactConsent,
} from "./export/diagnostic-exporter"
export {
    RUNTIME_METRICS,
    RuntimeSampler,
    type RuntimeSamplerClock,
    type RuntimeSamplerOptions,
    type RuntimeSnapshot,
} from "./performance/runtime-sampler"
export {
    AnomalySeverity,
    BreachKind,
    DEFAULT_METRIC_BUDGETS,
    type MetricBudget,
    type MetricSample,
    type PerformanceAnomaly,
    type PolicyVerdict,
    type RecoveryNotice,
    ThresholdPolicy,
    type ThresholdPolicyOptions,
} from "./performance/threshold-policy"
export {
    countReplayedEffects,
    ReplayEffect,
    ReplayNotPermitted,
    ReplayPolicy,
    type ReplayPort,
    type ReplayRequest,
    type ReplayResult,
    resolveReplayPort,
} from "./reproduction/replay-ports"
export {
    classifyStepEffect,
    type ReplayedStep,
    replayScenario,
    type ScenarioReplayReport,
} from "./reproduction/scenario-runner"
export { RuntimeEventBus, type RuntimeEventBusOptions } from "./runtime-event-bus"
export { SessionJournal, type SessionJournalOptions, type SessionJournalStats } from "./transports/session-journal"
export {
    type NormalizedRuntimeError,
    type RuntimeAttributes,
    type RuntimeAttributeValue,
    type RuntimeDropAccounting,
    RuntimeDropReason,
    type RuntimeEventInput,
    RuntimeEventPriority,
    type RuntimeEventSubscriber,
    type RuntimeTelemetryContext,
    type RuntimeTelemetryEvent,
} from "./types"

/**
 * Process-wide runtime telemetry entry point.
 *
 * Producers are spread across services that have no shared owner, so the bus
 * is reachable through a module-level accessor rather than threaded through
 * every constructor. Tests replace it with `setRuntimeTelemetryBus`.
 */

let bus: RuntimeEventBus | undefined

export function getRuntimeTelemetryBus(): RuntimeEventBus {
    if (!bus) bus = new RuntimeEventBus()
    return bus
}

/** Install a bus, returning the previous one so a test can restore it. */
export function setRuntimeTelemetryBus(next: RuntimeEventBus | undefined): RuntimeEventBus | undefined {
    const previous = bus
    bus = next
    return previous
}

export function createRuntimeTelemetryBus(options?: RuntimeEventBusOptions): RuntimeEventBus {
    return new RuntimeEventBus(options)
}

/**
 * Record a phase measurement.
 *
 * `durationMs` is the reason this helper exists: performance producers all
 * report the same shape, and giving them one entry point keeps the attribute
 * names consistent across domains.
 */
export function recordRuntimePhase(
    name: string,
    durationMs: number,
    attributes?: Readonly<Record<string, unknown>>,
    context?: Partial<RuntimeTelemetryContext>,
): void {
    runtimeEventRecorder.performance(name, { ...attributes, durationMs: Math.round(durationMs) }, context)
}

/** Record a failure that the extension recovered from or surfaced to the user. */
export function recordRuntimeFailure(
    name: string,
    error: unknown,
    attributes?: Readonly<Record<string, unknown>>,
    context?: Partial<RuntimeTelemetryContext>,
): void {
    runtimeEventRecorder.failure(name, error, attributes, context)
}

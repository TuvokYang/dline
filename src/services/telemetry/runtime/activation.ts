import type { TelemetrySetting } from "@shared/TelemetrySetting"
import { getProcessTelemetrySessionId } from "../journal"
import { clearRuntimeDiagnoses, recordRuntimeDiagnosis, setRuntimeTelemetryLifecycle } from "./host"
import { createRuntimeTelemetryBus, setRuntimeTelemetryBus } from "./index"
import { RuntimeTelemetryLifecycle, type RuntimeTelemetryLifecycleOptions } from "./lifecycle"
import { type RuntimeOperationKind, runtimeOperationRegistry } from "./operation-registry"
import { type PreviousSessionReconciliation, RuntimeSessionLedger, type RuntimeSessionStage } from "./session-ledger"
import {
    drainBootstrapSignalsInto,
    installRuntimeSignalPipeline,
    resetRuntimeSignalRecording,
    uninstallRuntimeSignalPipeline,
} from "./signal-pipeline"
import { RuntimeEventPriority } from "./types"

/**
 * Starts and stops the runtime telemetry pipeline for one extension host.
 *
 * The activation lives here rather than in `common.ts` so the startup path only
 * states *when* telemetry starts, while *how* it starts — which bus it drains,
 * where the journal goes, how consent is applied — stays inside this package.
 *
 * The lifecycle is given the process-wide bus rather than the private one it
 * would otherwise create. Producers across the extension record through
 * `getRuntimeTelemetryBus()`; if the pipeline drained a different bus, every
 * one of those measurements would be invisible to the journal, the collector
 * and the diagnostic export, and the export would contain only the sampler's
 * own breach events.
 *
 * That bus is built here rather than taken from the lazy accessor so it can
 * carry the session id. A bus left to its own default stamps events with a
 * private identifier that has nothing to do with the journal file name, which
 * makes a bundle impossible to line up with the journal it came from.
 */

let activeSessionLedger: RuntimeSessionLedger | undefined
const pendingSessionLedgerCompletions = new Set<RuntimeSessionLedger>()
let sessionLedgerCompletionInFlight: Promise<void> | undefined
let runtimeActivationTransition: Promise<void> = Promise.resolve()

function previousSessionAttributes(previous: PreviousSessionReconciliation): Readonly<Record<string, unknown>> {
    const activeTasks = previous.activeTasks ?? []
    return {
        component: "runtime",
        operation: "session_reconcile",
        outcome: previous.outcome,
        ...(previous.ageMs === undefined ? {} : { ageMs: previous.ageMs }),
        ...(previous.sessionId === undefined ? {} : { previous_session_id: previous.sessionId }),
        ...(previous.pid === undefined ? {} : { previous_pid: previous.pid }),
        ...(previous.stage === undefined ? {} : { previous_stage: previous.stage }),
        previous_active_task_count: activeTasks.length,
        previous_active_operation_count: previous.activeOperations?.length ?? 0,
        ...(previous.activeOperationsTruncated === undefined
            ? {}
            : { previous_active_operations_truncated: previous.activeOperationsTruncated }),
        ...(previous.activeTasksTruncated === undefined
            ? {}
            : { previous_active_tasks_truncated: previous.activeTasksTruncated }),
        ...Object.fromEntries(activeTasks.map((task, index) => [`active_task_ids.${index}`, task.taskId])),
        ...(previous.terminationHint
            ? {
                  previous_termination_kind: previous.terminationHint.kind,
                  ...(previous.terminationHint.exitCode === undefined
                      ? {}
                      : { previous_exit_code: previous.terminationHint.exitCode }),
                  ...(previous.terminationHint.origin === undefined
                      ? {}
                      : { previous_termination_origin: previous.terminationHint.origin }),
                  ...(previous.terminationHint.errorName === undefined
                      ? {}
                      : { previous_error_name: previous.terminationHint.errorName }),
                  ...(previous.terminationHint.errorCode === undefined
                      ? {}
                      : { previous_error_code: previous.terminationHint.errorCode }),
                  ...(previous.terminationHint.errorFingerprint === undefined
                      ? {}
                      : { previous_error_fingerprint: previous.terminationHint.errorFingerprint }),
              }
            : {}),
        ...(previous.lastHealth
            ? {
                  previous_health_sampled_at: previous.lastHealth.sampledAt,
                  previous_event_loop_delay_ms: previous.lastHealth.eventLoopDelayMs,
                  previous_cpu_utilization_ratio: previous.lastHealth.cpuUtilizationRatio,
                  previous_heap_used_bytes: previous.lastHealth.heapUsedBytes,
                  previous_rss_bytes: previous.lastHealth.rssBytes,
                  previous_queue_depth: previous.lastHealth.queueDepth,
                  previous_dropped_events: previous.lastHealth.droppedEvents,
              }
            : {}),
    }
}

function previousSessionPriority(outcome: PreviousSessionReconciliation["outcome"]): RuntimeEventPriority {
    return outcome === "unclean_inferred" || outcome === "corrupt" ? RuntimeEventPriority.Error : RuntimeEventPriority.Info
}

function inferredOperationEventName(kind: RuntimeOperationKind): string {
    if (kind === "api") return "task.api.interrupted_inferred"
    if (kind === "tool") return "task.tool.interrupted_inferred"
    if (kind === "subagent") return "task.subagent.interrupted_inferred"
    return "mcp.transport.interrupted_inferred"
}

export async function markRuntimeSessionStage(stage: RuntimeSessionStage): Promise<void> {
    await activeSessionLedger?.markStage(stage)
}

export function completeRuntimeSessionLedger(): Promise<void> {
    if (activeSessionLedger) pendingSessionLedgerCompletions.add(activeSessionLedger)
    if (sessionLedgerCompletionInFlight) return sessionLedgerCompletionInFlight

    const run = (async () => {
        const attempted = new Set<RuntimeSessionLedger>()
        let firstFailure: unknown
        for (;;) {
            if (activeSessionLedger) pendingSessionLedgerCompletions.add(activeSessionLedger)
            const ledgers = [...pendingSessionLedgerCompletions].filter((ledger) => !attempted.has(ledger))
            if (ledgers.length === 0) break
            for (const ledger of ledgers) attempted.add(ledger)
            const results = await Promise.allSettled(ledgers.map((ledger) => ledger.complete()))
            for (const [index, result] of results.entries()) {
                const ledger = ledgers[index]
                if (!ledger) continue
                if (result.status === "fulfilled") {
                    pendingSessionLedgerCompletions.delete(ledger)
                    if (activeSessionLedger === ledger) activeSessionLedger = undefined
                } else if (firstFailure === undefined) {
                    firstFailure = result.reason
                }
            }
        }
        if (firstFailure !== undefined) throw firstFailure
    })().finally(() => {
        if (sessionLedgerCompletionInFlight === run) sessionLedgerCompletionInFlight = undefined
    })
    sessionLedgerCompletionInFlight = run
    return run
}

export interface RuntimeTelemetryActivationOptions {
    /** Root of the Dline data directory; the journal lives under `telemetry/`. */
    readonly dataDir: string
    /** The user's current reporting choice. */
    readonly telemetrySetting: TelemetrySetting
    readonly sessionId?: string
    /** Runtime health sampling interval. Set to 0 to disable sampling entirely. */
    readonly samplerIntervalMs?: number
    /** Bounded runtime event capacity; exposed for deterministic pressure tests. */
    readonly capacity?: number
    /** Bus drain cadence. Set to 0 to drain only on stop. */
    readonly drainIntervalMs?: number
    /** Canonical provider-registry sink for runtime events. */
    readonly onEvent?: RuntimeTelemetryLifecycleOptions["onEvent"]
    readonly activeTaskIds?: () => readonly string[]
}

/**
 * Install and start the pipeline, replacing any pipeline already installed.
 *
 * Returns the lifecycle so a caller can apply later consent changes. Failure to
 * start is not propagated by design: diagnostics are an aid, and an extension
 * that cannot activate because its telemetry failed would be strictly worse
 * than one running without it.
 */
export function activateRuntimeTelemetry(options: RuntimeTelemetryActivationOptions): Promise<RuntimeTelemetryLifecycle> {
    const activation = runtimeActivationTransition.then(() => activateRuntimeTelemetryNow(options))
    runtimeActivationTransition = activation.then(
        () => undefined,
        () => undefined,
    )
    return activation
}

async function activateRuntimeTelemetryNow(options: RuntimeTelemetryActivationOptions): Promise<RuntimeTelemetryLifecycle> {
    // Replacing an existing pipeline would orphan its open sinks, so shut the
    // previous one down before installing a successor.
    await deactivateRuntimeTelemetryNow()
    await completeRuntimeSessionLedger().catch(() => undefined)

    const sessionId = options.sessionId ?? getProcessTelemetrySessionId()
    let sessionLedger: RuntimeSessionLedger | undefined
    try {
        sessionLedger = new RuntimeSessionLedger({
            dataDir: options.dataDir,
            sessionId,
            activeTaskIds: options.activeTaskIds,
            activeOperations: () => runtimeOperationRegistry.snapshot(),
        })
        await sessionLedger.startAndReconcile()
        activeSessionLedger = sessionLedger
    } catch {
        // Runtime diagnostics must not block extension activation.
    }
    const bus = createRuntimeTelemetryBus({ sessionId, capacity: options.capacity })
    setRuntimeTelemetryBus(bus)

    let lifecycle!: RuntimeTelemetryLifecycle
    let admissionInFlight: Promise<void> | undefined
    const admitPreviousSessions = (): Promise<void> => {
        if (admissionInFlight) return admissionInFlight
        const admission = (async () => {
            const sessions = (await sessionLedger?.claimReconciliationsForReporting()) ?? []
            for (const previous of sessions) {
                const admitted =
                    bus.record({
                        name: "runtime.previous_session_reconciled",
                        priority: previousSessionPriority(previous.outcome),
                        attributes: previousSessionAttributes(previous),
                        processScoped: true,
                    }) !== undefined
                if (!admitted) throw new Error("Previous-session reconciliation was not admitted to the runtime event bus")
                if (previous.outcome === "unclean_inferred") {
                    for (const task of previous.activeTasks ?? []) {
                        if (
                            !bus.record({
                                name: "task.session.interrupted_inferred",
                                priority: RuntimeEventPriority.Error,
                                attributes: {
                                    component: "task",
                                    operation: "session_recover",
                                    interruption_source: "previous_session_unclean",
                                    previous_session_id: previous.sessionId ?? "unknown",
                                    previous_pid: previous.pid ?? 0,
                                    ...(previous.stage ? { previous_stage: previous.stage } : {}),
                                },
                                context: { taskId: task.taskId },
                            })
                        ) {
                            throw new Error("Previous-session task interruption was not admitted to the runtime event bus")
                        }
                    }
                    for (const operation of previous.activeOperations ?? []) {
                        if (
                            !bus.record({
                                name: inferredOperationEventName(operation.kind),
                                priority: RuntimeEventPriority.Error,
                                attributes: {
                                    component: operation.kind,
                                    operation: operation.name,
                                    outcome: "interrupted_inferred",
                                    interruption_source: "previous_session_unclean",
                                    previous_session_id: previous.sessionId ?? "unknown",
                                    previous_pid: previous.pid ?? 0,
                                    operation_id: operation.operationId,
                                    operation_started_at: operation.startedAt,
                                },
                                ...(operation.taskId ? { context: { taskId: operation.taskId } } : { processScoped: true }),
                            })
                        ) {
                            throw new Error("Previous-session operation interruption was not admitted to the runtime event bus")
                        }
                    }
                }
                await previous.commit()
            }
        })().finally(() => {
            if (admissionInFlight === admission) admissionInFlight = undefined
        })
        admissionInFlight = admission
        return admission
    }

    lifecycle = new RuntimeTelemetryLifecycle({
        dataDir: options.dataDir,
        sessionId,
        bus,
        capacity: options.capacity,
        samplerIntervalMs: options.samplerIntervalMs,
        drainIntervalMs: options.drainIntervalMs,
        onEvent: options.onEvent,
        onEnabled: admitPreviousSessions,
        onSnapshot: (snapshot, queueDepth, droppedEvents) => {
            sessionLedger?.updateHealth({
                eventLoopDelayMs: snapshot.eventLoopDelayMs,
                cpuUtilizationRatio: snapshot.cpuUtilizationRatio,
                heapUsedBytes: snapshot.heapUsedBytes,
                rssBytes: snapshot.rssBytes,
                queueDepth,
                droppedEvents,
            })
        },
        activeTaskIds: options.activeTaskIds,
        // Diagnoses go to the process-wide store the export reads, and are
        // also recorded as events so the session journal carries the
        // conclusion next to the evidence it was drawn from.
        onDiagnosis: (diagnosis) => {
            recordRuntimeDiagnosis(diagnosis)
            lifecycle.service.recordInfo("runtime.diagnosis", {
                component: "runtime",
                operation: "diagnose",
                incidentId: diagnosis.incidentId,
                category: diagnosis.category,
                confidence: diagnosis.confidence,
                failingEventId: diagnosis.failingEventId,
            })
        },
    })
    setRuntimeTelemetryLifecycle(lifecycle)

    // The ~70 instrumented call sites ask this predicate before they read a
    // clock or build an attribute object. Left unconfigured it answers "yes"
    // for the whole host, so an undecided or opted-out user would still pay
    // for measurements nothing is allowed to report. Installing the pipeline
    // in the same step is what makes those call sites reach this bus without
    // importing it.
    installRuntimeSignalPipeline(bus, () => lifecycle.isEnabled)

    await lifecycle.applyConsent(options.telemetrySetting)

    // Only now is the user's choice known, so only now can the signals recorded
    // during startup be admitted. Draining earlier would record them before
    // consent; never draining would make the buffer pointless.
    drainBootstrapSignalsInto(bus, lifecycle.isEnabled)
    await sessionLedger?.markStage("running").catch(() => undefined)

    return lifecycle
}

/**
 * Stop and uninstall the pipeline.
 *
 * Safe to call when nothing is installed, which is the normal case for hosts
 * that never activated telemetry and for a second deactivation during shutdown.
 */
export function deactivateRuntimeTelemetry(): Promise<void> {
    const deactivation = runtimeActivationTransition.then(() => deactivateRuntimeTelemetryNow())
    runtimeActivationTransition = deactivation.catch(() => undefined)
    return deactivation
}

async function deactivateRuntimeTelemetryNow(): Promise<void> {
    const previous = setRuntimeTelemetryLifecycle(undefined)
    clearRuntimeDiagnoses()
    if (!previous) {
        // Nothing was collecting, but a recorder may still point at a pipeline
        // from an earlier host; restoring the default keeps the two in step.
        // Buffered startup signals are deliberately kept: this is the path a
        // first activation takes on its way in, and they are what it will
        // drain once consent is known.
        resetRuntimeSignalRecording()
        return
    }

    // `dispose` flushes before closing, so events recorded up to shutdown still
    // reach the journal. Until it returns the predicate must keep answering for
    // the pipeline being torn down, so it is uninstalled afterwards.
    try {
        await previous.dispose()
    } finally {
        // Pin recording off even when a sink fails during its final flush.
        uninstallRuntimeSignalPipeline()
        setRuntimeTelemetryBus(undefined)
    }
}

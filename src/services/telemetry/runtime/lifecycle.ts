import path from "node:path"
import type { TelemetrySetting } from "@shared/TelemetrySetting"
import {
	type RuntimeTelemetryAuthorizationStatus,
	TelemetryAuthorizationStore,
} from "@/core/storage/secrets/TelemetryAuthorizationStore"
import { isTelemetryDevelopmentMode } from "../development-mode"
import { RuntimeEventRecorder } from "../events/runtime"
import { recordRuntimeGauge } from "../service/pipeline-port"
import { DiagnosisPipeline } from "./analysis/diagnosis-pipeline"
import type { RootCauseDiagnosis } from "./analysis/root-cause-types"
import { DevRuntimeDiagnostics } from "./dev-diagnostics"
import { RUNTIME_METRICS, RuntimeSampler, type RuntimeSnapshot } from "./performance/runtime-sampler"
import { DEFAULT_METRIC_BUDGETS, type PolicyVerdict, ThresholdPolicy } from "./performance/threshold-policy"
import { RuntimeEventBus } from "./runtime-event-bus"
import { RuntimeTelemetryService } from "./service"
import { RuntimeSignalPipeline } from "./signal-pipeline"
import { enforceJournalRetention } from "./transports/journal-retention"
import { OtelLogTransport, type OtelLogTransportOptions, type OtelLogTransportStats } from "./transports/otel-log-transport"
import { SessionJournal, type SessionJournalStats } from "./transports/session-journal"
import type { RuntimeDropAccounting, RuntimeTelemetryEvent } from "./types"

/**
 * Turns the user's "Allow error reporting" choice into a running (or stopped)
 * runtime diagnostics pipeline.
 *
 * This is the only place that decides whether diagnostics may touch the disk or
 * the network. Keeping the decision here means the bus, journal and transport
 * stay unaware of consent, and a disabled user provably produces neither a
 * journal file nor a collector request — the property the tests assert.
 *
 * Events reach the sinks only through `flush`, which drains the bus queue.
 * The bus is the single buffer, so its bounded capacity and priority eviction
 * are what actually protect memory; a second delivery path would both
 * duplicate records and bypass that protection.
 *
 * Ordering matters on disable: events already recorded are flushed before the
 * sinks close, so turning telemetry off does not destroy evidence the user
 * produced while it was on.
 */

/**
 * Default local collector, per the WS-017 transport contract.
 *
 * The exporter appends the `/v1/logs` path itself, so the base endpoint is
 * configured here rather than the full URL.
 */
const DEFAULT_OTLP_ENDPOINT = "http://127.0.0.1:4318"

/**
 * How often the bus is drained into the sinks.
 *
 * Nothing else calls `flush`, so without this the queue would only reach disk
 * at shutdown: the bus would evict its oldest events once full, and the
 * journal an investigation reads would stay empty for the entire session.
 * Draining on a timer keeps the queue short and the journal current, at the
 * cost of one pass over a small array.
 */
const DEFAULT_DRAIN_INTERVAL_MS = 5_000

/**
 * How many drained events stay reachable by an export.
 *
 * Matched to the bus default so the retained history and the queue shed
 * pressure at the same scale; a lifecycle that narrows `capacity` narrows both.
 */
const DEFAULT_SESSION_EVENT_CAPACITY = 512

export interface RuntimeTelemetryLifecycleOptions {
	/** Root of the Dline data directory; the journal lives under `telemetry/`. */
	readonly dataDir: string
	readonly sessionId: string
	/** Collector base URL; the exporter appends the signal path. */
	readonly otlpEndpoint?: string
	/** `http/protobuf`, `http/json` or `grpc`; defaults to `http/protobuf`. */
	readonly otlpProtocol?: string
	readonly capacity?: number
	readonly journalFlushIntervalMs?: number
	readonly journalMaxBytes?: number
	/**
	 * Replaces the transport's export processor.
	 *
	 * Tests use an in-memory processor to observe emitted records without
	 * running a collector.
	 */
	readonly processorFactory?: OtelLogTransportOptions["processorFactory"]
	/** Runtime health sampling interval. Set to 0 to disable sampling entirely. */
	readonly samplerIntervalMs?: number
	/** Bus drain cadence. Set to 0 to drain only on stop, as tests do. */
	readonly drainIntervalMs?: number
	/**
	 * Receives each diagnosis produced while the pipeline runs.
	 *
	 * Activation forwards these to the process-wide store the export reads.
	 * Tests pass their own sink to observe classification without a host.
	 */
	readonly onDiagnosis?: (diagnosis: RootCauseDiagnosis) => void
	/** Canonical provider-registry sink used by the production composition root. */
	readonly onEvent?: (event: RuntimeTelemetryEvent) => void
	/** Supplied by the host composition root; runtime never imports task/controller owners. */
	readonly activeTaskIds?: () => readonly string[]
	/**
	 * Bus to drain.
	 *
	 * Activation passes the process-wide bus so producers spread across the
	 * extension reach this pipeline's sinks. Tests omit it to get an isolated
	 * queue.
	 */
	readonly bus?: RuntimeEventBus
}

export class RuntimeTelemetryLifecycle {
	readonly service: RuntimeTelemetryService
	readonly diagnostics: DevRuntimeDiagnostics

	private readonly options: RuntimeTelemetryLifecycleOptions
	private readonly bus: RuntimeEventBus
	private readonly authorization: TelemetryAuthorizationStore

	private readonly policy: ThresholdPolicy

	private journal: SessionJournal | undefined
	private transport: OtelLogTransport | undefined
	private sampler: RuntimeSampler | undefined
	private diagnosis: DiagnosisPipeline | undefined
	private unsubscribeDiagnosis: (() => void) | undefined
	private drainTimer: ReturnType<typeof setInterval> | undefined
	private draining: Promise<void> | undefined
	private readonly session: RuntimeTelemetryEvent[] = []
	private readonly sessionCapacity: number
	private enabled = false
	private disposed = false

	constructor(options: RuntimeTelemetryLifecycleOptions) {
		this.options = options
		this.bus = options.bus ?? new RuntimeEventBus({ sessionId: options.sessionId, capacity: options.capacity })
		this.authorization = new TelemetryAuthorizationStore({ dataDir: options.dataDir })
		this.diagnostics = new DevRuntimeDiagnostics(this.bus, {
			enabled: () => this.enabled && isTelemetryDevelopmentMode(),
			activeTaskIds: options.activeTaskIds,
		})
		this.sessionCapacity = options.capacity ?? DEFAULT_SESSION_EVENT_CAPACITY
		const signalPipeline = new RuntimeSignalPipeline(this.bus)
		const recorder = new RuntimeEventRecorder({
			enabled: () => this.enabled,
			accept: (signal) => signalPipeline.accept(signal),
		})
		this.service = new RuntimeTelemetryService({ bus: this.bus, enabled: () => this.enabled, recorder })
		this.policy = new ThresholdPolicy({ budgets: DEFAULT_METRIC_BUDGETS })
	}

	get isEnabled(): boolean {
		return this.enabled
	}

	/** Identifies the events this pipeline produced; stamped on every export. */
	get sessionId(): string {
		return this.options.sessionId
	}

	get dropAccounting(): RuntimeDropAccounting {
		return this.bus.drops
	}

	get transportStats(): OtelLogTransportStats {
		return this.transport?.stats ?? { sentEvents: 0, failedBatches: 0, droppedEvents: 0 }
	}

	get journalStats(): SessionJournalStats {
		return this.journal?.stats ?? { written: 0, failed: 0, truncated: 0 }
	}

	/**
	 * Apply the user's telemetry choice.
	 *
	 * `unset` is deliberately treated as "not yet consented" rather than as an
	 * implicit yes: the onboarding banner still owns that decision.
	 */
	async applyConsent(setting: TelemetrySetting): Promise<void> {
		if (this.disposed) return
		if (setting === "enabled") {
			await this.start()
			return
		}
		await this.stop({ revokePairingCode: setting === "disabled" })
	}

	/** Public projection of the pairing credential; never contains the code. */
	getStatus(): RuntimeTelemetryAuthorizationStatus {
		return this.authorization.getStatus()
	}

	/**
	 * Hand the pairing code to a future remote transport exactly once.
	 *
	 * The local OTLP transport never calls this: a loopback collector needs no
	 * credential, and sending one would leak it into local capture files.
	 */
	consumePairingCodeForRemoteExchange(): string | undefined {
		return this.authorization.consumePairingCode()
	}

	/**
	 * Events this session recorded, oldest first.
	 *
	 * The bus alone cannot answer this: draining empties it, so after the
	 * first tick the queue describes only the last few seconds. An export is
	 * requested precisely because something went wrong earlier, so the drained
	 * events are retained here up to the same bound the queue uses.
	 */
	sessionEvents(): readonly RuntimeTelemetryEvent[] {
		return [...this.session, ...this.bus.peek()]
	}

	/**
	 * Push everything buffered to the journal and the collector.
	 *
	 * Draining unconditionally keeps a disabled pipeline from accumulating
	 * events that would be written later if the user re-enables telemetry.
	 */
	async flush(): Promise<void> {
		const events = this.bus.drain()
		if (!this.enabled) return

		for (const event of events) {
			// The journal is the durable record and the transport is
			// best-effort, so a collector problem never blocks the disk write.
			this.journal?.append(event)
			if (this.options.onEvent) this.options.onEvent(event)
			else this.transport?.enqueue(event)
			this.retainForExport(event)
		}
		await Promise.all([this.journal?.flush(), this.transport?.flush()])
	}

	/**
	 * Keep a drained event reachable by an export.
	 *
	 * The oldest events are dropped first: a diagnosis is drawn from what
	 * happened just before the report, and an unbounded history would make a
	 * long session grow without limit.
	 */
	private retainForExport(event: RuntimeTelemetryEvent): void {
		this.session.push(event)
		if (this.session.length > this.sessionCapacity) {
			this.session.splice(0, this.session.length - this.sessionCapacity)
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return
		try {
			await this.stop({ revokePairingCode: false })
		} finally {
			this.disposed = true
			this.bus.dispose()
		}
	}

	private async start(): Promise<void> {
		if (this.enabled) return

		this.authorization.ensurePairingCode()
		const sessionsDirectory = path.join(this.options.dataDir, "telemetry", "sessions")

		// Bound the directory before opening a new journal. The session id is
		// new on every host start, so without this the file count grows without
		// limit. Failure only costs disk space, so it must not block telemetry.
		void enforceJournalRetention({
			directory: sessionsDirectory,
			activeSessionId: this.options.sessionId,
		}).catch(() => undefined)

		this.journal = new SessionJournal({
			directory: sessionsDirectory,
			sessionId: this.options.sessionId,
			flushIntervalMs: this.options.journalFlushIntervalMs,
			maxBytes: this.options.journalMaxBytes,
		})
		// Standalone compatibility path. Production supplies `onEvent` and uses
		// the capability registry, where local journal delivery is ordered first.
		if (!this.options.onEvent) {
			this.transport = new OtelLogTransport({
				sessionId: this.options.sessionId,
				endpoint: this.options.otlpEndpoint ?? DEFAULT_OTLP_ENDPOINT,
				protocol: this.options.otlpProtocol,
				processorFactory: this.options.processorFactory,
			})
		}
		// Enable before starting the sampler: the service drops events while
		// disabled, so a verdict arriving first would be silently discarded.
		this.enabled = true
		this.diagnostics.phase("telemetry.started", "completed")
		this.startDiagnosis()
		this.startSampler()
		this.startDraining()
	}

	/**
	 * Starts the periodic drain that moves recorded events to the sinks.
	 *
	 * Flushes are chained rather than overlapped: two drains in flight would
	 * both write to the journal stream, and the second would find an empty
	 * queue anyway.
	 */
	private startDraining(): void {
		if (this.options.drainIntervalMs === 0) return

		const timer = setInterval(() => {
			this.draining = (this.draining ?? Promise.resolve()).then(() =>
				this.flush().catch(() => {
					// Sinks already count their own failures; a rejected drain
					// must not surface as an unhandled rejection in the host.
				}),
			)
		}, this.options.drainIntervalMs ?? DEFAULT_DRAIN_INTERVAL_MS)
		// Without unref a running pipeline would keep the host process alive.
		timer.unref?.()
		this.drainTimer = timer
	}

	/**
	 * Subscribes classification to the event stream.
	 *
	 * Subscribing rather than inspecting the queue at flush time keeps
	 * correlation ordered by the bus sequence and lets history survive a
	 * drain — the events explaining a failure are usually already written.
	 *
	 * A classification fault must never propagate into the producer that
	 * recorded the event, so the callback contains its own errors.
	 */
	private startDiagnosis(): void {
		const sink = this.options.onDiagnosis
		if (!sink) return

		const pipeline = new DiagnosisPipeline({ onDiagnosis: sink })
		this.diagnosis = pipeline
		this.unsubscribeDiagnosis = this.bus.subscribe((event) => {
			try {
				pipeline.observe(event)
			} catch {
				// Diagnostics are best-effort; a rule defect must not break
				// the operation being measured.
			}
		})
	}

	/**
	 * Starts host health sampling, unless the caller opted out.
	 *
	 * Only breaches reach the bus. Publishing every healthy sample would make
	 * the sampler the loudest producer in the system and bury the events that
	 * actually indicate a problem.
	 */
	private startSampler(): void {
		if (this.options.samplerIntervalMs === 0) return

		this.sampler = new RuntimeSampler({
			policy: this.policy,
			intervalMs: this.options.samplerIntervalMs,
			onSnapshot: (snapshot) => this.publishSnapshot(snapshot),
			onVerdict: (verdict) => this.publishVerdict(verdict),
		})
		this.sampler.start()
	}

	private publishSnapshot(snapshot: RuntimeSnapshot): void {
		recordRuntimeGauge(RUNTIME_METRICS.eventLoopDelayMs, snapshot.eventLoopDelayMs, "Event loop delay in milliseconds")
		recordRuntimeGauge(RUNTIME_METRICS.cpuUtilizationRatio, snapshot.cpuUtilizationRatio, "CPU utilisation ratio")
		recordRuntimeGauge(RUNTIME_METRICS.heapGrowthBytes, snapshot.heapGrowthBytes, "Heap growth in bytes")
		recordRuntimeGauge(RUNTIME_METRICS.rssBytes, snapshot.rssBytes, "Resident set size in bytes")
		this.diagnostics.snapshot(snapshot)
	}

	private publishVerdict(verdict: PolicyVerdict): void {
		if (verdict.anomaly) {
			// The breached value is the duration for delay-like metrics and a
			// ratio otherwise, so it is reported both as the phase duration and
			// under its own metric name rather than being reinterpreted.
			this.service.recordPerformanceAnomaly(`${verdict.anomaly.metric}.breach`, {
				component: "runtime",
				operation: "sample",
				metric: verdict.anomaly.metric,
				severity: verdict.anomaly.severity,
				kind: verdict.anomaly.kind,
				limit: verdict.anomaly.limit,
				incidentId: verdict.anomaly.incidentId,
				value: verdict.anomaly.value,
			})
		}
		if (verdict.recovery) {
			this.service.recordInfo("runtime.incident.recovered", {
				component: "runtime",
				operation: "recover",
				metric: verdict.recovery.metric,
				incidentId: verdict.recovery.incidentId,
				durationMs: verdict.recovery.durationMs,
			})
		}
	}

	private async stop(options: { revokePairingCode: boolean }): Promise<void> {
		if (!this.enabled) {
			if (options.revokePairingCode) this.authorization.revokePairingCode()
			return
		}

		this.diagnostics.phase("telemetry.stopping", "started")
		// Stop sampling first so no new verdict lands after the final flush.
		this.sampler?.dispose()
		this.sampler = undefined
		this.policy.reset()

		if (this.drainTimer) {
			clearInterval(this.drainTimer)
			this.drainTimer = undefined
		}
		// Let an in-flight drain settle so it cannot write after the sinks close.
		await this.draining?.catch(() => undefined)
		this.draining = undefined

		this.unsubscribeDiagnosis?.()
		this.unsubscribeDiagnosis = undefined
		this.diagnosis?.reset()
		this.diagnosis = undefined

		// This marker means producers are drained, not that the process exited.
		this.diagnostics.phase("telemetry.final_flush", "started")
		// A forwarding failure must not strand timers or open journals on shutdown.
		try {
			await this.flush()
		} finally {
			this.diagnostics.reset()
			this.enabled = false
			const journal = this.journal
			const transport = this.transport
			this.journal = undefined
			this.transport = undefined
			this.session.length = 0
			await Promise.allSettled([journal?.dispose(), transport?.dispose()])
			if (options.revokePairingCode) this.authorization.revokePairingCode()
		}
	}
}

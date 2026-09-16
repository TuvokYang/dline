/**
 * The single contract shared by telemetry producers and the pipeline that records them.
 *
 * Three groups of modules need to reach each other: the instrumentation helpers
 * (`instrumentation/`), the domain recorders (`events/`), and the runtime
 * pipeline (`runtime/`). Wiring them directly produced a cycle — the recorders
 * reached into the runtime bus while the runtime activation reached back into
 * the instrumentation switch — so a change on either side could silently break
 * the other. This port is the only module all three are allowed to depend on,
 * and it depends on nothing, which is what makes the direction enforceable.
 *
 * The port deliberately does not expose the runtime queue's numeric priority.
 * Producers describe *what kind of fact* they are reporting; how the queue
 * orders or evicts that fact is the pipeline's concern and must stay
 * replaceable without touching ~70 instrumented call sites.
 */

/** Kind of fact a signal reports, independent of any queue implementation. */
export type SignalLevel = "debug" | "info" | "performance" | "error" | "invariant"

/** Stable field-preserving replacement for telemetry content, credentials and identities. */
export const TELEMETRY_MASK_VALUE = "*****"

/** Producer-supplied dimensions. The pipeline applies the content policy. */
export type SignalAttributes = Readonly<Record<string, unknown>>

/**
 * Identity of the work that produced a signal.
 *
 * Every field is optional: a producer supplies only what it knows, and the
 * pipeline fills the rest from its ambient context.
 */
export interface SignalContext {
	readonly sessionId?: string
	readonly taskId?: string
	readonly controllerId?: string
	readonly workspaceId?: string
}

/** One fact handed to the pipeline. */
export interface TelemetrySignal {
	readonly name: string
	readonly level: SignalLevel
	/** Original producer clocks, preserved when startup signals are replayed. */
	readonly timestamp?: number
	readonly monotonicMs?: number
	readonly attributes?: SignalAttributes
	readonly error?: unknown
	readonly context?: SignalContext
}

/**
 * What a pipeline must provide to receive signals.
 *
 * `accept` must not throw: a producer reporting a failure cannot be allowed to
 * fail because of the reporting itself.
 */
export interface SignalPipeline {
	accept(signal: TelemetrySignal): void
}

/** Low-cardinality scalar attributes accepted by metric and trace backends. */
export type ObservabilityAttributes = Readonly<Record<string, string | number | boolean>>

export interface SignalSpanContext {
	readonly traceId: string
	readonly spanId: string
	readonly traceFlags: number
}

export interface SignalSpanHandle {
	readonly active: boolean
	readonly spanContext?: SignalSpanContext
	readonly taskId?: string
	/** Establish async-local correlation without making the SDK a producer dependency. */
	run?<T>(action: () => T): T
	setAttribute(name: string, value: string | number | boolean): void
	recordException(error: unknown): void
	/** Instant state change, captured at its source rather than at exporter drain. */
	addEvent?(name: string, attributes?: ObservabilityAttributes, timestamp?: number): void
	end(outcome?: "success" | "failure" | "cancelled", endTime?: number): void
}

export interface SignalSpanStartOptions {
	readonly name: string
	readonly attributes?: ObservabilityAttributes
	readonly parent?: SignalSpanHandle
	readonly startTime?: number
	/** Start an independent trace even when a different operation is ambient. */
	readonly root?: boolean
}

/** Standard metric/trace destination installed by the process telemetry owner. */
export interface ObservabilityPipeline {
	recordHistogram(name: string, value: number, attributes?: ObservabilityAttributes, description?: string): void
	recordGauge(name: string, value: number | null, attributes?: ObservabilityAttributes, description?: string): void
	startSpan(options: SignalSpanStartOptions): SignalSpanHandle
}

/**
 * Bound on the bootstrap buffer.
 *
 * Startup instrumentation runs before any pipeline exists. Buffering keeps
 * those facts, but an unbounded buffer would turn a pipeline that never
 * arrives into a memory leak.
 *
 * When full, the *oldest* signal is evicted rather than the newest being
 * refused. Overflow means startup is taking far longer than expected, and in
 * that case the recent signals are the ones that describe where it is stuck;
 * the earliest ones only say that it began.
 */
export const BOOTSTRAP_CAPACITY = 256

let pipeline: SignalPipeline | undefined
let observabilityPipeline: ObservabilityPipeline | undefined
let recordingEnabled: () => boolean = () => true

const bootstrapBuffer: TelemetrySignal[] = []
let bootstrapDropped = 0

type ObservabilityBootstrapRecord =
	| {
			readonly kind: "histogram"
			readonly name: string
			readonly value: number
			readonly attributes?: ObservabilityAttributes
			readonly description?: string
	  }
	| {
			readonly kind: "gauge"
			readonly name: string
			readonly value: number | null
			readonly attributes?: ObservabilityAttributes
			readonly description?: string
	  }
	| {
			readonly kind: "span"
			readonly span: DeferredSignalSpan
	  }

const observabilityBootstrapBuffer: ObservabilityBootstrapRecord[] = []

/**
 * Install the pipeline that receives subsequent signals.
 *
 * Swapping the destination is all this does. It deliberately does not touch the
 * bootstrap buffer, in either direction: admitting those facts is a consent
 * decision and discarding them is a session-boundary decision, and both belong
 * to the lifecycle owner. Folding the discard in here made uninstalling — which
 * a first activation does on its way in, before any pipeline exists — silently
 * throw away the startup window it was about to drain.
 *
 * Callers that end a session uninstall and then call
 * `discardBootstrapSignals()` explicitly.
 *
 * Returns the previous pipeline so a caller can restore it.
 */
export function installSignalPipeline(next: SignalPipeline | undefined): SignalPipeline | undefined {
	const previous = pipeline
	pipeline = next
	return previous
}

/** Install or clear the standard metrics/traces destination. */
export function installObservabilityPipeline(next: ObservabilityPipeline | undefined): ObservabilityPipeline | undefined {
	const previous = observabilityPipeline
	observabilityPipeline = next
	if (next && observabilityBootstrapBuffer.length > 0) {
		const held = observabilityBootstrapBuffer.splice(0)
		if (recordingEnabled()) {
			for (const record of held) replayObservabilityRecord(next, record)
		} else {
			for (const record of held) if (record.kind === "span") record.span.discard()
		}
	}
	return previous
}

/** Record one standard duration distribution when a destination is installed. */
export function recordDurationHistogram(value: number, attributes: ObservabilityAttributes): void {
	const record = {
		kind: "histogram" as const,
		name: "dline.runtime.operation.duration",
		value,
		attributes,
		description: "Runtime operation duration in milliseconds",
	}
	if (observabilityPipeline) observabilityPipeline.recordHistogram(record.name, value, attributes, record.description)
	else bufferObservabilityRecord(record)
}

/** Record one point-in-time runtime health value. */
export function recordRuntimeGauge(name: string, value: number, description: string): void {
	if (observabilityPipeline) observabilityPipeline.recordGauge(name, value, undefined, description)
	else bufferObservabilityRecord({ kind: "gauge", name, value, description })
}

/** Start a real span when tracing is installed and authorised. */
export function startSignalSpan(options: SignalSpanStartOptions): SignalSpanHandle {
	if (!recordingEnabled()) return INERT_SIGNAL_SPAN
	if (observabilityPipeline) return observabilityPipeline.startSpan(options)
	const span = new DeferredSignalSpan(options)
	bufferObservabilityRecord({ kind: "span", span })
	return span
}

/** Run work inside a span when supported; business errors propagate unchanged. */
export function runWithSignalSpan<T>(span: SignalSpanHandle, action: () => T): T {
	return span.run ? span.run(action) : action()
}

/**
 * Hand one signal to the pipeline, or buffer it until one is installed.
 *
 * Buffered signals are not auto-flushed on install. Whether early startup
 * facts may be admitted into a session is a consent decision owned by the
 * pipeline lifecycle, not by whichever call site happened to record first.
 */
export function emitSignal(signal: TelemetrySignal): void {
	signal = { timestamp: Date.now(), monotonicMs: performance.now(), ...signal }
	const target = pipeline
	if (target) {
		target.accept(signal)
		return
	}

	if (bootstrapBuffer.length >= BOOTSTRAP_CAPACITY) {
		bootstrapBuffer.shift()
		bootstrapDropped += 1
	}
	bootstrapBuffer.push(signal)
}

/**
 * Configure whether producers should record at all.
 *
 * A predicate rather than a boolean: the user can change the reporting setting
 * while the extension host runs, and capturing the value once would strand
 * every call site on whichever setting was active at module load.
 */
export function configureSignalRecording(options: { readonly enabled: () => boolean }): void {
	recordingEnabled = options.enabled
}

/** Restore the default predicate. Intended for tests and deactivation. */
export function resetSignalRecording(): void {
	recordingEnabled = () => true
}

/** Whether producers should build and emit signals right now. */
export function isSignalRecordingEnabled(): boolean {
	return recordingEnabled()
}

/** Signals held while no pipeline was installed, plus what did not fit. */
export interface BootstrapSignalDrain {
	readonly signals: readonly TelemetrySignal[]
	readonly dropped: number
}

/**
 * Take everything buffered before a pipeline existed.
 *
 * Exposed for the lifecycle owner, which decides — after consent is known —
 * whether those facts may enter the session.
 */
export function drainBootstrapSignals(): BootstrapSignalDrain {
	const signals = bootstrapBuffer.splice(0, bootstrapBuffer.length)
	const dropped = bootstrapDropped
	bootstrapDropped = 0
	return { signals, dropped }
}

/** Drop everything buffered without delivering it. */
export function discardBootstrapSignals(): void {
	bootstrapBuffer.length = 0
	bootstrapDropped = 0
	for (const record of observabilityBootstrapBuffer) if (record.kind === "span") record.span.discard()
	observabilityBootstrapBuffer.length = 0
}

/** How many signals are currently buffered. */
export function bootstrapSignalCount(): number {
	return bootstrapBuffer.length
}

export function observabilityBootstrapCount(): number {
	return observabilityBootstrapBuffer.length
}

function bufferObservabilityRecord(record: ObservabilityBootstrapRecord): void {
	if (observabilityBootstrapBuffer.length >= BOOTSTRAP_CAPACITY) {
		const evicted = observabilityBootstrapBuffer.shift()
		if (evicted?.kind === "span") evicted.span.discard()
	}
	observabilityBootstrapBuffer.push(record)
}

function replayObservabilityRecord(target: ObservabilityPipeline, record: ObservabilityBootstrapRecord): void {
	switch (record.kind) {
		case "histogram":
			target.recordHistogram(record.name, record.value, record.attributes, record.description)
			return
		case "gauge":
			target.recordGauge(record.name, record.value, record.attributes, record.description)
			return
		case "span":
			record.span.attach((options) => target.startSpan(options))
			return
	}
}

/** Bounded owner buffers this handle at start, so spans still open during attachment are not lost. */
export class DeferredSignalSpan implements SignalSpanHandle {
	private readonly attributes: Record<string, string | number | boolean>
	private readonly options: SignalSpanStartOptions
	private error: unknown
	private ended: { outcome: "success" | "failure" | "cancelled"; time: number } | undefined
	private delegate: SignalSpanHandle | undefined
	private discarded = false
	private readonly events: { name: string; attributes?: ObservabilityAttributes; timestamp: number }[] = []
	private droppedEvents = 0

	constructor(options: SignalSpanStartOptions) {
		this.options = { ...options, startTime: options.startTime ?? Date.now() }
		this.attributes = { ...options.attributes }
	}

	get active(): boolean {
		return !this.discarded && !this.ended && (this.delegate?.active ?? true)
	}
	get spanContext(): SignalSpanContext | undefined {
		return this.delegate?.spanContext
	}
	get taskId(): string | undefined {
		return this.delegate?.taskId
	}
	run<T>(action: () => T): T {
		return this.delegate?.run ? this.delegate.run(action) : action()
	}

	attach(start: (options: SignalSpanStartOptions) => SignalSpanHandle): SignalSpanHandle {
		if (this.discarded) return INERT_SIGNAL_SPAN
		if (this.delegate) return this.delegate
		const parent = this.options.parent instanceof DeferredSignalSpan ? this.options.parent.attach(start) : this.options.parent
		this.delegate = start({ ...this.options, attributes: this.attributes, parent })
		for (const event of this.events.splice(0)) this.delegate.addEvent?.(event.name, event.attributes, event.timestamp)
		if (this.droppedEvents) this.delegate.setAttribute("telemetry_dropped_span_events", this.droppedEvents)
		if (this.error !== undefined) this.delegate.recordException(this.error)
		if (this.ended) this.delegate.end(this.ended.outcome, this.ended.time)
		this.error = undefined
		return this.delegate
	}

	discard(): void {
		this.discarded = true
		this.error = undefined
		this.events.length = 0
	}

	setAttribute(name: string, value: string | number | boolean): void {
		if (!this.active) return
		if (this.delegate) this.delegate.setAttribute(name, value)
		else if (Object.keys(this.attributes).length < 128) this.attributes[name] = value
	}

	recordException(error: unknown): void {
		if (!this.active) return
		if (this.delegate) this.delegate.recordException(error)
		else this.error = error
	}

	addEvent(name: string, attributes?: ObservabilityAttributes, timestamp = Date.now()): void {
		if (!this.active) return
		if (this.delegate) this.delegate.addEvent?.(name, attributes, timestamp)
		else if (this.events.length < 128) this.events.push({ name, attributes: { ...attributes }, timestamp })
		else this.droppedEvents += 1
	}

	end(outcome: "success" | "failure" | "cancelled" = "success", endTime = Date.now()): void {
		if (!this.active) return
		this.ended = { outcome, time: endTime }
		this.delegate?.end(outcome, endTime)
	}
}

const INERT_SIGNAL_SPAN: SignalSpanHandle = Object.freeze({
	active: false,
	setAttribute(): void {},
	recordException(): void {},
	end(): void {},
})

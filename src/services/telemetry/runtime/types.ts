/**
 * Runtime telemetry event contract.
 *
 * A runtime telemetry event describes something that happened inside the
 * extension host: a phase started, a threshold was crossed, a dependency
 * failed. It never carries what the user typed, what a tool produced, or what
 * a file contains. Producers therefore emit identity, timing, counts, and
 * outcome only, and the content policy rejects anything else.
 */

import type { SignalSpanContext } from "../service/pipeline-port"

/** Severity ordering used when the queue is full and events must be dropped. */
export enum RuntimeEventPriority {
	/** Diagnostic detail. First to be dropped under pressure. */
	Debug = 0,
	/** Ordinary lifecycle and phase timing. */
	Info = 1,
	/** Ordinary performance sample. Kept as the compatibility value for existing producers. */
	PerformanceSample = 2,
	Performance = PerformanceSample,
	/** Threshold breaches and degraded behaviour worth investigating. */
	PerformanceAnomaly = 3,
	/** Dependency or transport failures. */
	Error = 4,
	/** Broken internal assumptions. Retained longest because they indicate defects. */
	Invariant = 5,
}

/** Reason an event was not admitted to the queue. */
export enum RuntimeDropReason {
	/** The queue was full and no lower-priority event could be evicted. */
	QueueFull = "queue_full",
	/** The payload violated the content policy and could not be normalized. */
	PolicyRejected = "policy_rejected",
	/** The bus was disposed before the event was admitted. */
	Disposed = "disposed",
}

/**
 * Attribute values allowed on an event payload.
 *
 * Nested objects are deliberately excluded: they are the usual way raw request
 * bodies and tool results leak into telemetry. Producers that need structure
 * should flatten it into named scalar attributes.
 */
export type RuntimeAttributeValue = string | number | boolean

export type RuntimeAttributes = Readonly<Record<string, RuntimeAttributeValue>>

/** Identity of the work that produced an event. */
export interface RuntimeTelemetryContext {
	/** Stable per-extension-host-session id. Never persisted across restarts. */
	readonly sessionId: string
	/** Active task id, when the event belongs to a task. */
	readonly taskId?: string
	/** Controller instance id, used to separate concurrent editor panels. */
	readonly controllerId?: string
	/** Workspace root fingerprint. Never the absolute path. */
	readonly workspaceId?: string
}

/** A failure reduced to fields that are safe to publish. */
export interface NormalizedRuntimeError {
	/** Constructor name, for example `AxiosError`. */
	readonly name: string
	/** Field-preserving mask; the original prose participates only in the in-memory fingerprint. */
	readonly message: string
	/** Library or platform error code, when the error carries one. */
	readonly code?: string
	/** HTTP or protocol status, when the error carries one. */
	readonly status?: number
	/** First stack frame that belongs to this project, without absolute paths. */
	readonly sourceFrame?: string
	/** Stable identity for grouping. Excludes ids, ports, and user content. */
	readonly fingerprint: string
	/** Normalized cause chain, bounded in depth. */
	readonly cause?: NormalizedRuntimeError
}

/**
 * One recorded event.
 *
 * `sequence` is assigned by the bus and is strictly increasing within a
 * session, so a consumer can detect gaps caused by drops even when timestamps
 * collide.
 */
export interface RuntimeTelemetryEvent {
	readonly eventId: string
	readonly sequence: number
	/** Wall-clock time in epoch milliseconds. */
	readonly timestamp: number
	/** Monotonic time in milliseconds, unaffected by clock adjustments. */
	readonly monotonicMs: number
	/** Dotted domain name, for example `terminal.execute`. */
	readonly name: string
	readonly priority: RuntimeEventPriority
	readonly context: RuntimeTelemetryContext
	readonly traceContext?: SignalSpanContext
	readonly attributes: RuntimeAttributes
	readonly error?: NormalizedRuntimeError
}

/** What a producer supplies; the bus fills in identity and ordering. */
export interface RuntimeEventInput {
	/** Process lifecycle/health must not inherit task or active span identity. */
	readonly processScoped?: boolean
	readonly timestamp?: number
	readonly monotonicMs?: number
	readonly name: string
	readonly priority: RuntimeEventPriority
	readonly attributes?: Readonly<Record<string, unknown>>
	readonly error?: unknown
	/** Overrides the ambient context when a producer knows better. */
	readonly context?: Partial<RuntimeTelemetryContext>
}

/** Per-priority and per-reason counters for events that were not recorded. */
export interface RuntimeDropAccounting {
	readonly total: number
	readonly byPriority: Readonly<Record<RuntimeEventPriority, number>>
	readonly byReason: Readonly<Record<RuntimeDropReason, number>>
}

export type RuntimeEventSubscriber = (event: RuntimeTelemetryEvent) => void

import { randomUUID } from "node:crypto"
import { currentSignalSpan } from "../service/trace-scope"
import { RuntimeContentPolicy } from "./content-policy"
import { RuntimeTelemetryContextHolder } from "./context"
import { normalizeRuntimeError } from "./error-normalizer"
import {
	RuntimeDropAccounting,
	RuntimeDropReason,
	RuntimeEventInput,
	RuntimeEventPriority,
	RuntimeEventSubscriber,
	RuntimeTelemetryEvent,
} from "./types"

/**
 * In-process bus for runtime telemetry events.
 *
 * The bus is the only component that assigns sequence numbers, so ordering is
 * total within a session even when producers run concurrently. It is bounded:
 * telemetry must never become the reason the extension host runs out of
 * memory, so a full queue evicts the least important event rather than
 * growing. Every drop is counted, because silent loss would make a gap in the
 * sequence unexplainable.
 *
 * `record` never throws. A producer reporting a failure must not fail because
 * of the reporting itself.
 */

const DEFAULT_CAPACITY = 512

function emptyPriorityCounters(): Record<RuntimeEventPriority, number> {
	return {
		[RuntimeEventPriority.Debug]: 0,
		[RuntimeEventPriority.Info]: 0,
		[RuntimeEventPriority.Performance]: 0,
		[RuntimeEventPriority.PerformanceAnomaly]: 0,
		[RuntimeEventPriority.Error]: 0,
		[RuntimeEventPriority.Invariant]: 0,
	}
}

function emptyReasonCounters(): Record<RuntimeDropReason, number> {
	return {
		[RuntimeDropReason.QueueFull]: 0,
		[RuntimeDropReason.PolicyRejected]: 0,
		[RuntimeDropReason.Disposed]: 0,
	}
}

export interface RuntimeEventBusOptions {
	readonly sessionId?: string
	readonly capacity?: number
	readonly contentPolicy?: RuntimeContentPolicy
	/** Monotonic clock, injectable so tests do not depend on wall time. */
	readonly monotonicNow?: () => number
	/** Wall clock, injectable for deterministic timestamps in tests. */
	readonly wallNow?: () => number
}

export class RuntimeEventBus {
	private readonly capacity: number
	private readonly policy: RuntimeContentPolicy
	private readonly contextHolder: RuntimeTelemetryContextHolder
	private readonly monotonicNow: () => number
	private readonly wallNow: () => number

	private readonly queue: RuntimeTelemetryEvent[] = []
	private readonly subscribers = new Set<RuntimeEventSubscriber>()
	private readonly dropsByPriority = emptyPriorityCounters()
	private readonly dropsByReason = emptyReasonCounters()

	private nextSequence = 1
	private droppedTotal = 0
	private disposed = false

	constructor(options: RuntimeEventBusOptions = {}) {
		this.capacity = options.capacity ?? DEFAULT_CAPACITY
		this.policy = options.contentPolicy ?? RuntimeContentPolicy.forEvents()
		this.contextHolder = new RuntimeTelemetryContextHolder(options.sessionId ?? randomUUID())
		this.monotonicNow = options.monotonicNow ?? (() => performance.now())
		this.wallNow = options.wallNow ?? (() => Date.now())
	}

	get context(): RuntimeTelemetryContextHolder {
		return this.contextHolder
	}

	get contentPolicy(): RuntimeContentPolicy {
		return this.policy
	}

	/**
	 * Admit one event.
	 *
	 * Returns the recorded event, or `undefined` when it was dropped. Callers
	 * normally ignore the result; it exists so tests and the diagnostics view
	 * can assert admission.
	 */
	record(input: RuntimeEventInput): RuntimeTelemetryEvent | undefined {
		if (this.disposed) {
			this.countDrop(input.priority, RuntimeDropReason.Disposed)
			return undefined
		}

		const { attributes } = this.policy.apply(input.attributes)
		const span = input.processScoped ? undefined : currentSignalSpan()
		const resolvedContext = input.processScoped
			? this.contextHolder.sessionContext
			: this.contextHolder.resolve(input.context)
		const event: RuntimeTelemetryEvent = {
			eventId: randomUUID(),
			sequence: this.nextSequence++,
			timestamp: input.timestamp ?? this.wallNow(),
			monotonicMs: input.monotonicMs ?? this.monotonicNow(),
			name: input.name,
			priority: input.priority,
			context: { ...resolvedContext, taskId: resolvedContext.taskId ?? span?.taskId },
			traceContext: span?.spanContext,
			attributes,
			error: input.error === undefined ? undefined : normalizeRuntimeError(input.error),
		}

		if (!this.admit(event)) return undefined
		this.publish(event)
		return event
	}

	subscribe(subscriber: RuntimeEventSubscriber): () => void {
		this.subscribers.add(subscriber)
		return () => {
			this.subscribers.delete(subscriber)
		}
	}

	/** Events currently buffered, oldest first. */
	drain(): RuntimeTelemetryEvent[] {
		return this.queue.splice(0, this.queue.length)
	}

	/** Buffered events without removing them. */
	peek(): readonly RuntimeTelemetryEvent[] {
		return this.queue
	}

	get drops(): RuntimeDropAccounting {
		return {
			total: this.droppedTotal,
			byPriority: { ...this.dropsByPriority },
			byReason: { ...this.dropsByReason },
		}
	}

	dispose(): void {
		this.disposed = true
		this.queue.length = 0
		this.subscribers.clear()
		this.policy.reset()
	}

	/**
	 * Place the event in the queue, evicting the least important older event
	 * when full.
	 *
	 * Eviction favours keeping failures over routine timing: a dropped Info
	 * event costs a data point, while a dropped Invariant event costs the
	 * evidence for a defect.
	 */
	private admit(event: RuntimeTelemetryEvent): boolean {
		if (this.queue.length < this.capacity) {
			this.queue.push(event)
			return true
		}

		const victimIndex = this.findEvictionCandidate(event.priority)
		if (victimIndex === undefined) {
			this.countDrop(event.priority, RuntimeDropReason.QueueFull)
			return false
		}

		const [victim] = this.queue.splice(victimIndex, 1)
		this.countDrop(victim.priority, RuntimeDropReason.QueueFull)
		this.queue.push(event)
		return true
	}

	/** Oldest queued event with a priority strictly below `incoming`. */
	private findEvictionCandidate(incoming: RuntimeEventPriority): number | undefined {
		let candidate: number | undefined
		let candidatePriority = incoming
		for (let index = 0; index < this.queue.length; index++) {
			const priority = this.queue[index].priority
			if (priority < candidatePriority) {
				candidate = index
				candidatePriority = priority
			}
		}
		return candidate
	}

	/**
	 * Notify subscribers, isolating failures.
	 *
	 * A diagnostics view that throws must not stop the exporter from seeing
	 * the same event, and neither must reach the producer.
	 */
	private publish(event: RuntimeTelemetryEvent): void {
		for (const subscriber of this.subscribers) {
			try {
				subscriber(event)
			} catch {
				// A broken subscriber is isolated; reporting it through the bus
				// would risk unbounded recursion.
			}
		}
	}

	private countDrop(priority: RuntimeEventPriority, reason: RuntimeDropReason): void {
		this.droppedTotal += 1
		this.dropsByPriority[priority] += 1
		this.dropsByReason[reason] += 1
	}
}

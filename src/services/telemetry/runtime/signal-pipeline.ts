import { Logger } from "@/shared/services/Logger"
import {
	configureSignalRecording,
	discardBootstrapSignals,
	drainBootstrapSignals,
	installSignalPipeline,
	resetSignalRecording,
	type SignalLevel,
	type SignalPipeline,
	type TelemetrySignal,
} from "../service/pipeline-port"
import type { RuntimeEventBus } from "./runtime-event-bus"
import { RuntimeEventPriority } from "./types"

/**
 * Adapts the producer-facing signal port onto the runtime event bus.
 *
 * The port speaks in kinds of facts; the bus speaks in queue priorities. This
 * module is the only place the two vocabularies meet, so the bus can change how
 * it orders or evicts events without reaching any of the instrumented call
 * sites, and the port stays free of runtime queue concepts.
 */

/**
 * Queue priority for each signal kind.
 *
 * A record rather than a switch so that adding a `SignalLevel` fails to compile
 * until its ordering is decided: an unmapped level silently defaulting to
 * `Debug` would make new facts the first thing dropped under pressure.
 */
const PRIORITY_BY_LEVEL: Record<SignalLevel, RuntimeEventPriority> = {
	debug: RuntimeEventPriority.Debug,
	info: RuntimeEventPriority.Info,
	performance: RuntimeEventPriority.PerformanceSample,
	error: RuntimeEventPriority.Error,
	invariant: RuntimeEventPriority.Invariant,
}

export function signalLevelToPriority(level: SignalLevel): RuntimeEventPriority {
	return PRIORITY_BY_LEVEL[level]
}

/**
 * Pipeline backed by one runtime event bus.
 *
 * `accept` swallows bus failures by contract: a producer reporting a problem
 * must not fail because the reporting path did.
 */
export class RuntimeSignalPipeline implements SignalPipeline {
	constructor(private readonly bus: RuntimeEventBus) {}

	accept(signal: TelemetrySignal): void {
		try {
			this.bus.record({
				name: signal.name,
				timestamp: signal.timestamp,
				monotonicMs: signal.monotonicMs,
				priority: signalLevelToPriority(signal.level),
				attributes: signal.attributes,
				error: signal.error,
				// `sessionId` is owned by the bus context holder; a producer
				// cannot relabel which host session produced the event.
				context: signal.context,
			})
		} catch {
			// Isolated on purpose: see the class comment.
		}
	}
}

/**
 * Point the port at `bus` and gate recording on `enabled`.
 *
 * Returns the pipeline that was previously installed so a caller can restore
 * it; tests rely on that to keep suites independent.
 */
export function installRuntimeSignalPipeline(bus: RuntimeEventBus, enabled: () => boolean): SignalPipeline | undefined {
	const previous = installSignalPipeline(new RuntimeSignalPipeline(bus))
	configureSignalRecording({ enabled })
	return previous
}

/**
 * Admit the signals recorded before this pipeline existed.
 *
 * Kept separate from installation because the two answer different questions.
 * Installation says where signals go; this says whether the startup facts —
 * recorded before the user's choice was known — may enter the session at all.
 * Only the lifecycle, after applying consent, can answer the second.
 *
 * @param admit Whether the buffered signals may be recorded.
 */
export function drainBootstrapSignalsInto(bus: RuntimeEventBus, admit: boolean): void {
	const { signals, dropped } = drainBootstrapSignals()

	if (!admit) {
		// Declining consent discards them rather than holding them for a later
		// opt-in: the user did not agree to the session in which they occurred.
		return
	}

	const pipeline = new RuntimeSignalPipeline(bus)
	for (const signal of signals) {
		pipeline.accept(signal)
	}

	if (dropped > 0) {
		// A gap must be visible; silently shorter evidence is worse than
		// evidence that admits it is incomplete.
		Logger.warn(`[RuntimeTelemetry] Dropped ${dropped} startup signal(s) before the pipeline was installed`)
	}
}

/**
 * Uninstall the pipeline and stop recording.
 *
 * Recording is pinned off rather than reset to the permissive default: after
 * teardown there is no pipeline to report to, so leaving producers enabled
 * would only refill the bootstrap buffer.
 */
export function uninstallRuntimeSignalPipeline(): void {
	installSignalPipeline(undefined)
	discardBootstrapSignals()
	configureSignalRecording({ enabled: () => false })
}

/**
 * Restore the port's defaults without touching buffered signals.
 *
 * Used when no pipeline was installed, which is the normal state during the
 * teardown that precedes a first activation. Discarding here would throw away
 * the startup signals that activation is about to drain — they were recorded
 * before any pipeline existed, which is precisely why they were buffered.
 */
export function resetRuntimeSignalRecording(): void {
	installSignalPipeline(undefined)
	resetSignalRecording()
}

/** Restore the port's defaults and drop buffered signals. Intended for tests. */
export function resetRuntimeSignalPipeline(): void {
	installSignalPipeline(undefined)
	discardBootstrapSignals()
	resetSignalRecording()
}

/**
 * The only interface a Task may use to record metrics.
 *
 * `emit` is synchronous, takes no callback and returns nothing: a Task that awaited
 * metrics would make an optional accounting concern part of its own lifecycle. The
 * implementation only writes into a bounded queue, so it performs no I/O and takes no
 * lock. Note that TypeScript permits `await` on a `void` expression — the signature
 * cannot forbid it, so the real call sites are checked instead of relying on types.
 */

import type { MetricsEvent } from "./events"

export interface MetricsEmitter {
    /**
     * Record one settled fact.
     *
     * Must not throw: a metrics failure is never a Task failure. Must not block:
     * queue insertion is the whole synchronous work.
     */
    emit(event: MetricsEvent): void
}

/** An emitter that discards everything, for tests and for disabling metrics. */
export class NoopEmitter implements MetricsEmitter {
    emit(_event: MetricsEvent): void {}
}

/**
 * A no-op emitter instance shared by callers that only need a placeholder.
 *
 * It is stateless, so sharing it keeps construction out of hot paths.
 */
export const noopEmitter: MetricsEmitter = new NoopEmitter()

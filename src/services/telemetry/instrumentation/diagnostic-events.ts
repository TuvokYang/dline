/**
 * Typed catalogue of runtime diagnostic events.
 *
 * `perf-domains.ts` covers measurements that answer "how long did X take".
 * This table covers the other half of the runtime picture: facts that have no
 * duration but change how a later timing should be read — a warm terminal that
 * had to fall back to a cold one, a cache that was invalidated, a retry that
 * fired. Those currently live only in `Logger.debug` strings, so they vanish at
 * the default log level exactly when a user reports a slowdown.
 *
 * Kept separate from the performance catalogue on purpose. A diagnostic has an
 * outcome rather than a duration, and it is emitted at `Debug` priority so a
 * burst of diagnostics is shed before real timing data when the queue is under
 * pressure. Merging the two tables would force one of those properties onto the
 * wrong kind of event.
 */

/** Subsystem a diagnostic belongs to. Becomes the first segment of the event name. */
export enum DiagnosticDomain {
	Terminal = "terminal",
	Checkpoint = "checkpoint",
	Hook = "hook",
	Settings = "settings",
	Task = "task",
	Profile = "profile",
	Capability = "capability",
	Storage = "storage",
	Workspace = "workspace",
}

/**
 * Diagnostic kinds declared per domain.
 *
 * Names describe the observed fact, not the code path that produced it, so a
 * kind stays meaningful after the surrounding implementation is refactored.
 */
export const DIAGNOSTIC_KINDS = {
	[DiagnosticDomain.Terminal]: [
		"warm_pool_miss",
		"shell_integration_unavailable",
		"process_terminated",
		"reuse_rejected",
		// Distinct from `warm_pool_miss`: a miss is one command that found the
		// pool empty, while this is the refill itself failing, which is why the
		// pool was empty in the first place.
		"prewarm_failed",
	],
	[DiagnosticDomain.Checkpoint]: ["baseline_rebuilt", "paths_unstageable", "nested_repository_skipped", "add_failed"],
	[DiagnosticDomain.Hook]: ["discovery_cache_miss", "discovery_cache_invalidated", "execution_skipped"],
	[DiagnosticDomain.Settings]: ["reconcile_conflict", "listener_failure", "broadcast_skipped"],
	[DiagnosticDomain.Task]: ["history_truncated", "context_window_exceeded", "stream_retry", "resume_interrupted"],
	[DiagnosticDomain.Profile]: ["catalog_repaired", "resolution_fallback"],
	[DiagnosticDomain.Capability]: ["refresh_failure", "source_unavailable"],
	[DiagnosticDomain.Storage]: ["lock_contended", "stale_lock_broken", "write_retry"],
	[DiagnosticDomain.Workspace]: ["root_unresolved", "watcher_restarted"],
} as const satisfies Record<DiagnosticDomain, readonly string[]>

/** Diagnostic kinds valid for `D`. */
export type DiagnosticKind<D extends DiagnosticDomain> = (typeof DIAGNOSTIC_KINDS)[D][number]

/**
 * How the subsystem continued after the diagnostic.
 *
 * Recorded as its own dimension rather than folded into the kind so a single
 * kind can be compared across outcomes — a `warm_pool_miss` that recovered and
 * one that degraded are the same fact with different consequences.
 */
export enum DiagnosticOutcome {
	/** Handled without user-visible effect. */
	Recovered = "recovered",
	/** Continued on a slower or reduced path. */
	Degraded = "degraded",
	/** The operation did not complete. */
	Failed = "failed",
	/** Neutral observation with no success or failure meaning. */
	Observed = "observed",
}

/**
 * Event name for a domain/kind pair.
 *
 * The `diagnostic.` prefix keeps these separable from `domain.phase`
 * performance events, which share the same leading domain segment.
 */
export function diagnosticEventName<D extends DiagnosticDomain>(domain: D, kind: DiagnosticKind<D>): string {
	return `diagnostic.${domain}.${kind}`
}

/** Whether `kind` is declared for `domain`. Used by parity tests and guards. */
export function isKnownDiagnosticKind(domain: DiagnosticDomain, kind: string): boolean {
	return (DIAGNOSTIC_KINDS[domain] as readonly string[]).includes(kind)
}

/** Every declared domain, in declaration order. */
export function diagnosticDomains(): readonly DiagnosticDomain[] {
	return Object.keys(DIAGNOSTIC_KINDS) as DiagnosticDomain[]
}

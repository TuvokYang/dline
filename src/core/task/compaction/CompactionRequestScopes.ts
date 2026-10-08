import type { ProviderRequestScope } from "../executors/provider/service/ProviderRequest"

/** Reads the handler and Mode one compaction run must be sent under. */
export interface CompactionRequestScopeReader {
	resolve(compactionId: string): ProviderRequestScope | undefined
}

/**
 * Handlers that some compaction runs are sent under instead of the task's own.
 *
 * A context transition compacts for the Profile or Mode it is about to adopt,
 * so the summary is requested from the target model while the task still runs
 * on the source. A live handler cannot be persisted with the run, so this is
 * in-memory only: after a restart the transition that asked for it no longer
 * exists either, and a run without a binding uses the task's current handler.
 */
export class CompactionRequestScopes implements CompactionRequestScopeReader {
	private readonly scopes = new Map<string, ProviderRequestScope>()

	bind(compactionId: string, scope: ProviderRequestScope): void {
		this.scopes.set(compactionId, scope)
	}

	resolve(compactionId: string): ProviderRequestScope | undefined {
		return this.scopes.get(compactionId)
	}

	release(compactionId: string): void {
		this.scopes.delete(compactionId)
	}
}

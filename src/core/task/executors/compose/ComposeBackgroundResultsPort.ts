/** Transfers completed background results to the conversation journal. */
export interface ComposeBackgroundResultsPort {
	/** Collection is read-only; failed persistence leaves the results available. */
	collect(input: { readonly signal: AbortSignal }): Promise<BackgroundResultsLease | undefined>
}

/** A result snapshot acknowledged only after its journal entry is durable. */
export interface BackgroundResultsLease {
	readonly text: string
	/** Idempotently transfer ownership to the durable journal, even if the round was cancelled meanwhile. */
	commit(): void
}

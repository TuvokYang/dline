/**
 * Records that a provider request happened, and what it consumed.
 *
 * The usage a provider reports is the only place the task learns how much of
 * the context window a turn occupied. Context pressure, prompt cache health,
 * subagent budgets and the chat's request row all read that one fact, so the
 * provider domain reports it through a port rather than reaching into any of
 * those consumers. A headless assembly that needs none of them omits the port.
 */
export interface ProviderRequestReportPort {
	/** Open a record before the stream starts, so the request is visible while it runs. */
	begin(input: { readonly turnId: string }): Promise<ProviderRequestRecord>
}

/**
 * How a provider request ended.
 *
 * Only a completed request describes a real turn: a cancelled one stopped on
 * the user's order and a failed one never produced the turn it was opened for.
 * Consumers that reason about context pressure or cache health must be able to
 * tell them apart, so the outcome is explicit rather than a success flag.
 */
export type ProviderRequestOutcome = "completed" | "cancelled" | "failed"

export interface ProviderRequestRecord {
	/**
	 * Settle the record with what the request actually consumed.
	 *
	 * Called once the stream ends, cancellation and failure included, so a
	 * request never stays open as a permanently running row.
	 */
	settle(input: { readonly usage?: Readonly<Record<string, number>>; readonly outcome: ProviderRequestOutcome }): Promise<void>
}

/**
 * Fold a usage chunk into what the turn has reported so far.
 *
 * A stream may report usage more than once. Token counts are increments and add
 * up, while a reported total cost already covers the whole request and would be
 * double counted if summed, so the latest total replaces the previous one.
 */
export function mergeProviderUsage(
	accumulated: Readonly<Record<string, number>> | undefined,
	next: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
	if (!accumulated) return { ...next }
	const merged: Record<string, number> = { ...accumulated }
	for (const [key, value] of Object.entries(next)) {
		if (!Number.isFinite(value)) continue
		const previous = merged[key]
		merged[key] = TOTAL_USAGE_KEYS.has(key) || previous === undefined ? value : previous + value
	}
	return merged
}

/** Usage fields a provider reports as a running total for the whole request. */
const TOTAL_USAGE_KEYS: ReadonlySet<string> = new Set(["totalCost"])

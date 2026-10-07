/**
 * Backoff schedule for one automatic retry sequence, indexed by attempt.
 *
 * The schedule is explicit rather than exponential so every attempt keeps a
 * countdown long enough to read, and so the total wait before manual recovery
 * stays bounded at one minute.
 *
 * Kept free of imports: the retry policy is read by black-box tests and by
 * runtime owners that must not load the error-classification services.
 */
export const AUTO_RETRY_DELAYS_MS: readonly number[] = [3_000, 5_000, 7_000, 15_000, 30_000]

export const MAX_AUTO_RETRY_ATTEMPTS = AUTO_RETRY_DELAYS_MS.length

/**
 * Read the auto-retry backoff for one attempt.
 *
 * Attempts outside the schedule clamp to its first or last entry so a caller
 * with a different attempt budget, such as context compaction, still receives a
 * defined delay.
 *
 * @param attempt One-based retry attempt count.
 * @returns Delay duration in milliseconds.
 */
export function getRetryDelay(attempt: number): number {
	const scheduleIndex = Math.min(Math.max(Math.trunc(attempt), 1), AUTO_RETRY_DELAYS_MS.length) - 1
	return AUTO_RETRY_DELAYS_MS[scheduleIndex]
}

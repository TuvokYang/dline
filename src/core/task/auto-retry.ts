import { setTimeout as setTimeoutPromise } from "node:timers/promises"

/**
 * Backoff schedule for one automatic retry sequence, indexed by attempt.
 *
 * The schedule is explicit rather than exponential so every attempt keeps a
 * countdown long enough to read, and so the total wait before manual recovery
 * stays bounded at one minute.
 */
export const AUTO_RETRY_DELAYS_MS: readonly number[] = [3_000, 5_000, 7_000, 15_000, 30_000]

export const MAX_AUTO_RETRY_ATTEMPTS = AUTO_RETRY_DELAYS_MS.length

export interface StreamRetryInput {
	isSpendLimitError: boolean
	autoRetryAttempts: number
}

export interface StreamRetryDecision {
	shouldRetry: boolean
	shouldPrompt: boolean
}

export interface DelayedStreamRetryInput {
	delay: number
	isAborted: () => boolean
	isCurrentTask: () => boolean
	dispatchRetry: () => Promise<void>
}

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

/**
 * Wait for the auto-retry backoff and report whether retry may continue.
 * @param delay Delay duration in milliseconds.
 * @param isAborted Callback that reports whether the task was aborted.
 * @returns True when retry may continue, false when cancellation won.
 */
export async function waitRetryDelay(delay: number, isAborted: () => boolean): Promise<boolean> {
	await setTimeoutPromise(delay)
	return !isAborted()
}

/**
 * Dispatch delayed stream retry only when cancellation and task identity still allow it.
 * @param input Delayed retry callbacks and delay configuration.
 * @returns True when the retry event ran, false when retry was suppressed.
 */
export async function runDelayedStreamRetry(input: DelayedStreamRetryInput): Promise<boolean> {
	const shouldRetry = await waitRetryDelay(input.delay, input.isAborted)
	if (!shouldRetry || !input.isCurrentTask()) {
		return false
	}

	await input.dispatchRetry()
	return true
}

/**
 * Decide whether a streaming failure should retry or prompt the user.
 * @param input Streaming retry state and error classification.
 * @returns Retry decision for streaming failure recovery.
 */
export function getStreamRetryDecision(input: StreamRetryInput): StreamRetryDecision {
	if (input.isSpendLimitError) {
		return { shouldRetry: false, shouldPrompt: false }
	}

	if (input.autoRetryAttempts < MAX_AUTO_RETRY_ATTEMPTS) {
		return { shouldRetry: true, shouldPrompt: false }
	}

	return { shouldRetry: false, shouldPrompt: true }
}

import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import { isOutputLimitExceededError } from "@core/api/stream/OutputLimitExceededError"
import { checkContextWindowExceededError } from "@core/context/context-management/context-error-handling"
import { ClineError, ClineErrorType } from "@/services/error"
import { MAX_AUTO_RETRY_ATTEMPTS } from "./auto-retry-schedule"
import { ProfileNotValidError } from "./profile-admission"

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
 * Wait out one retry delay, giving up the moment the signal aborts.
 *
 * A cancelled task must not sit in a countdown it will never use, so the wait
 * settles on abort instead of after the full delay.
 *
 * @returns True when the delay elapsed, false when cancellation won.
 */
export function waitRetryDelayUnlessAborted(delay: number, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false)
	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(timer)
			resolve(false)
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort)
			resolve(true)
		}, delay)
		signal.addEventListener("abort", onAbort, { once: true })
	})
}

/** The provider and model a failed request was sent to, for error classification. */
export interface ProviderIdentity {
	readonly providerId?: string
	readonly modelId?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function parseMessageRecord(error: unknown): Record<string, unknown> | undefined {
	if (!(error instanceof Error)) return undefined
	try {
		return asRecord(JSON.parse(error.message))
	} catch {
		return undefined
	}
}

/** The HTTP status a provider error carries, wherever the provider nested it. */
function nestedStatusOf(error: unknown, parsed: ClineError): number {
	const raw = asRecord(error)
	const messageRecord = parseMessageRecord(error)
	const rawError = asRecord(raw?.error)
	const messageError = asRecord(messageRecord?.error)
	const status =
		raw?.status ??
		raw?.statusCode ??
		asRecord(raw?.response)?.status ??
		rawError?.status ??
		asRecord(rawError?.error)?.status ??
		messageRecord?.status ??
		messageRecord?.statusCode ??
		asRecord(messageRecord?.response)?.status ??
		messageError?.status ??
		asRecord(messageError?.error)?.status ??
		parsed._error.status
	return typeof status === "number" ? status : Number(status)
}

/**
 * Decide whether sending the same request again can succeed.
 *
 * Failures are retryable by default and only errors that a replay would repeat
 * are excluded: account limits that waiting cannot lift, rejected credentials,
 * a context the model cannot hold, and an output limit the provider enforced.
 * An allow-list instead silently skipped the whole backoff for any upstream
 * code outside it, such as `stream_read_error`.
 */
export function isRetryableProviderError(error: unknown, provider: ProviderIdentity = {}): boolean {
	// A cancelled run is not a provider failure and must not be replayed.
	if (error instanceof Error && error.name === "AbortError") return false
	// Only fixing or switching the Profile can admit this request.
	if (error instanceof ProfileNotValidError) return false
	if (isOutputLimitExceededError(error)) return false
	// The same frozen request cannot fit on a second attempt either.
	if (checkContextWindowExceededError(error)) return false

	const parsed = ClineError.transform(error, provider.modelId, provider.providerId)
	const status = nestedStatusOf(error, parsed)
	// 408/409/425 are transport-level request states that can accompany an auth
	// classification without meaning the credentials themselves are rejected.
	const isRetryableRequestStatus = status === 408 || status === 409 || status === 425
	return !(
		parsed.isErrorType(ClineErrorType.Balance) ||
		parsed.isErrorType(ClineErrorType.SpendLimit) ||
		parsed.isErrorType(ClineErrorType.QuotaExceeded) ||
		(parsed.isErrorType(ClineErrorType.Auth) && !isRetryableRequestStatus)
	)
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

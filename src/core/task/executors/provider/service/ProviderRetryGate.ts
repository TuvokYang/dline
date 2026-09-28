import { getRetryDelay, MAX_AUTO_RETRY_ATTEMPTS } from "../../../auto-retry"
import type { ProviderRetryPolicy } from "./DefaultProductionProviderService"

/**
 * The automatic retry schedule, with the user able to cut a wait short.
 *
 * The countdown belongs to the provider request, but the Retry button belongs
 * to the chat. A manual Retry during the countdown sends the next attempt at
 * once instead of starting a second request beside the scheduled one, so the
 * retry budget is spent exactly as if the delay had elapsed.
 *
 * `active` spans the whole sequence, including the attempt in flight between
 * two waits, so the footer does not flicker between countdowns.
 */
export class ProviderRetryGate implements ProviderRetryPolicy {
	readonly maxAttempts = MAX_AUTO_RETRY_ATTEMPTS
	private sequence = false
	private release: (() => void) | undefined

	/** @param onChange Publishes the footer when the sequence starts or ends. */
	constructor(private readonly onChange?: () => void) {}

	/** Whether an automatic retry sequence currently owns the request. */
	get active(): boolean {
		return this.sequence
	}

	delayMs(attempt: number): number {
		return getRetryDelay(attempt)
	}

	wait(delayMs: number, signal: AbortSignal): Promise<boolean> {
		this.setSequence(true)
		if (signal.aborted) return Promise.resolve(false)
		return new Promise<boolean>((resolve) => {
			const finish = (proceed: boolean) => {
				clearTimeout(timer)
				signal.removeEventListener("abort", onAbort)
				if (this.release === now) this.release = undefined
				resolve(proceed)
			}
			const now = () => finish(true)
			const onAbort = () => finish(false)
			const timer = setTimeout(now, Math.max(0, delayMs))
			signal.addEventListener("abort", onAbort, { once: true })
			this.release = now
		})
	}

	/** Send the scheduled attempt now; false when no countdown is running. */
	retryNow(): boolean {
		const release = this.release
		if (!release) return false
		release()
		return true
	}

	/** The request produced its stream or failed for good, so the sequence is over. */
	settled(): void {
		this.setSequence(false)
	}

	private setSequence(active: boolean): void {
		if (this.sequence === active) return
		this.sequence = active
		this.onChange?.()
	}
}

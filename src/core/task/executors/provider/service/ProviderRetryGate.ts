import { getRetryDelay, MAX_AUTO_RETRY_ATTEMPTS } from "../../../auto-retry-schedule"
import type { ProviderRetryPolicy, ProviderRetryWait } from "./DefaultProductionProviderService"

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
	private release: ((outcome: ProviderRetryWait) => void) | undefined
	private takeover = false

	/** @param onChange Publishes the footer when the sequence starts or ends. */
	constructor(private readonly onChange?: () => void) {}

	/** Whether an automatic retry sequence currently owns the request. */
	get active(): boolean {
		return this.sequence
	}

	delayMs(attempt: number): number {
		return getRetryDelay(attempt)
	}

	wait(delayMs: number, signal: AbortSignal): Promise<ProviderRetryWait> {
		if (signal.aborted) return Promise.resolve("cancelled")
		return new Promise<ProviderRetryWait>((resolve) => {
			let timer: ReturnType<typeof setTimeout>
			const finish = (outcome: ProviderRetryWait) => {
				clearTimeout(timer)
				signal.removeEventListener("abort", onAbort)
				if (this.release === finish) this.release = undefined
				resolve(outcome)
			}
			const onAbort = () => finish("cancelled")
			timer = setTimeout(() => finish("send"), Math.max(0, delayMs))
			signal.addEventListener("abort", onAbort, { once: true })
			this.release = finish
			// Publish only after Retry can release the wait. The Webview may render
			// and click the button synchronously from this notification.
			this.setSequence(true)
		})
	}

	/** Send the scheduled attempt now; false when no countdown is running. */
	retryNow(): boolean {
		return this.end("send")
	}

	/**
	 * End the countdown and hand its failure back to the user, who then decides
	 * with Retry; false when no countdown is running.
	 *
	 * A Profile switch does this: the countdown retries a failure of the Profile
	 * the user just left, so silently sending it again, to either Profile, would
	 * spend a request the user did not ask for.
	 */
	handBack(): boolean {
		return this.end("handed_back")
	}

	/**
	 * The user answered a failed request with Retry, so the request that answer
	 * opens is theirs: its failure goes straight back to them with Retry rather
	 * than starting another automatic sequence they did not ask for.
	 */
	takeOver(): void {
		this.takeover = true
	}

	/** The Retry never reached a request, so a later request keeps its automatic sequence. */
	releaseTakeover(): void {
		this.takeover = false
	}

	/** Whether the request starting now was opened by a manual Retry; consumed by that request. */
	claimManualTakeover(): boolean {
		const claimed = this.takeover
		this.takeover = false
		return claimed
	}

	/** The request produced its stream or failed for good, so the sequence is over. */
	settled(): void {
		this.setSequence(false)
	}

	private end(outcome: ProviderRetryWait): boolean {
		const release = this.release
		if (!release) return false
		release(outcome)
		return true
	}

	private setSequence(active: boolean): void {
		if (this.sequence === active) return
		this.sequence = active
		this.onChange?.()
	}
}

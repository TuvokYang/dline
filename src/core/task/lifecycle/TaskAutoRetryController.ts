export interface TaskAutoRetryControllerOptions {
	readonly isAborted: () => boolean
	readonly publishState: () => Promise<void>
	readonly reportPublishError: (error: unknown) => void
}

interface PendingAutoRetry {
	readonly settle: (allowed: boolean, publish?: boolean) => void
}

/** Owns the cancellable timer and manual-takeover state for one automatic retry sequence. */
export class TaskAutoRetryController {
	private pending?: PendingAutoRetry
	private sequenceActive = false
	private manualTakeoverActive = false

	constructor(private readonly options: TaskAutoRetryControllerOptions) {}

	wait(delay: number): Promise<boolean> {
		this.cancelPending(false)
		this.sequenceActive = true
		return new Promise<boolean>((resolve) => {
			let settled = false
			let timer: NodeJS.Timeout
			const settle = (allowed: boolean, publish = true): void => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				if (!allowed) this.sequenceActive = false
				if (this.pending?.settle === settle) {
					this.pending = undefined
					if (publish) this.publishState()
				}
				resolve(allowed)
			}
			timer = setTimeout(() => settle(!this.options.isAborted()), Math.max(0, delay))
			this.pending = { settle }
			this.publishState()
		})
	}

	endSequence(publish = true): void {
		const pending = this.pending
		const wasActive = this.sequenceActive || pending !== undefined
		this.sequenceActive = false
		if (pending) {
			pending.settle(false, publish)
		} else if (wasActive && publish) {
			this.publishState()
		}
	}

	cancelPending(publish = true): void {
		this.endSequence(publish)
	}

	hasPending(): boolean {
		return this.pending !== undefined && !this.options.isAborted()
	}

	hasSequence(): boolean {
		return this.sequenceActive && !this.options.isAborted()
	}

	overridePending(): boolean {
		if (!this.sequenceActive || this.options.isAborted()) return false
		this.manualTakeoverActive = true
		this.pending?.settle(true, false)
		this.sequenceActive = false
		this.publishState()
		return true
	}

	hasManualTakeover(): boolean {
		return this.manualTakeoverActive
	}

	consumeManualTakeover(): boolean {
		const active = this.manualTakeoverActive
		this.manualTakeoverActive = false
		return active
	}

	resetManualTakeover(): void {
		this.manualTakeoverActive = false
	}

	private publishState(): void {
		void this.options.publishState().catch((error) => this.options.reportPublishError(error))
	}
}

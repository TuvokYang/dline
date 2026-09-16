import type { ApiCanonicalStream, ApiStreamChunk, ApiStreamUsageChunk } from "@core/api/transform/stream"
import { Logger } from "@/shared/services/Logger"

/*
This coordinator splits stream handling into two paths:

1) usage chunks:
   - processed immediately via onUsageChunk
   - used to keep token/cost state current while the request is still active

2) non-usage chunks (text/reasoning/tool_calls):
   - queued and consumed by the normal Task flow
   - that flow may await tool execution or ask prompts, which can block for user input

Without this split, usage updates can be delayed behind awaited UI/tool work.
*/
export type NonUsageApiStreamChunk = Exclude<ApiStreamChunk, { type: "usage" }>

interface QueueMetrics {
	queueDepth: number
	maxQueueDepth: number
	streamCompleted: boolean
}

type StreamChunkCoordinatorOptions = {
	onUsageChunk: (chunk: ApiStreamUsageChunk) => void
	/** Abort the provider-owned transport when iterator closure alone cannot end it. */
	abortStream?: () => void
	onQueueMetrics?: (metrics: QueueMetrics) => void
	queueMetricsIntervalMs?: number
}

export class StreamChunkCoordinator {
	private iterator: AsyncGenerator<ApiStreamChunk>
	private queue: NonUsageApiStreamChunk[] = []
	private maxQueueDepth = 0
	private readError: unknown
	private completed = false
	private stopRequested = false
	private streamAbortRequested = false
	private usageOnly = false
	private waiterResolve: (() => void) | undefined
	private pumpPromise: Promise<void>
	private queueMetricsTimer: ReturnType<typeof setInterval> | undefined

	constructor(
		stream: ApiCanonicalStream,
		private readonly options: StreamChunkCoordinatorOptions,
	) {
		this.iterator = stream[Symbol.asyncIterator]()
		if (options.onQueueMetrics) {
			this.queueMetricsTimer = setInterval(() => this.emitQueueMetrics(), options.queueMetricsIntervalMs ?? 1_000)
			this.queueMetricsTimer.unref?.()
		}
		this.pumpPromise = this.startPump()
	}

	private emitQueueMetrics(): void {
		this.options.onQueueMetrics?.({
			queueDepth: this.queue.length,
			maxQueueDepth: this.maxQueueDepth,
			streamCompleted: this.completed,
		})
	}

	private clearQueueMetricsTimer(): void {
		if (this.queueMetricsTimer !== undefined) clearInterval(this.queueMetricsTimer)
		this.queueMetricsTimer = undefined
	}

	private notifyWaiter() {
		if (this.waiterResolve) {
			this.waiterResolve()
			this.waiterResolve = undefined
		}
	}

	private async waitForData() {
		if (this.queue.length > 0 || this.completed || this.readError) {
			return
		}
		await new Promise<void>((resolve) => {
			this.waiterResolve = resolve
		})
	}

	private abortStream(): void {
		if (this.completed || this.streamAbortRequested) {
			return
		}
		this.streamAbortRequested = true
		try {
			this.options.abortStream?.()
		} catch (error) {
			Logger.debug(`[StreamChunkCoordinator] Failed to abort provider stream: ${error}`)
		}
	}

	private async closeIterator() {
		this.abortStream()
		if (typeof this.iterator.return !== "function") {
			return
		}
		try {
			await this.iterator.return(undefined)
		} catch (error) {
			Logger.debug(`[StreamChunkCoordinator] Failed to close stream iterator: ${error}`)
		}
	}

	private startPump(): Promise<void> {
		return (async () => {
			try {
				while (!this.stopRequested) {
					const { value: chunk, done } = await this.iterator.next()
					if (done || !chunk) {
						break
					}
					if (chunk.type === "usage") {
						this.options.onUsageChunk(chunk)
						continue
					}
					if (this.usageOnly) {
						// A completed turn-ending tool may still be followed by the final
						// usage event, but any further presentation content belongs to a
						// provider continuation Dline will never render. Close the iterator
						// instead of leaving that request alive while the user already owns
						// the next interaction.
						this.stopRequested = true
						await this.closeIterator()
						break
					}
					this.queue.push(chunk)
					this.maxQueueDepth = Math.max(this.maxQueueDepth, this.queue.length)
					this.notifyWaiter()
				}
			} catch (error) {
				if (!this.stopRequested) {
					this.readError = error
				}
			} finally {
				this.completed = true
				this.emitQueueMetrics()
				this.notifyWaiter()
			}
		})()
	}

	getQueueDepth(): number {
		return this.queue.length
	}

	getMaxQueueDepth(): number {
		return this.maxQueueDepth
	}

	async nextChunk(): Promise<NonUsageApiStreamChunk | undefined> {
		while (true) {
			if (this.readError) {
				throw this.readError
			}
			const chunk = this.queue.shift()
			if (chunk) {
				return chunk
			}
			if (this.completed) {
				return undefined
			}
			await this.waitForData()
		}
	}

	/** Drain final Provider usage, closing the stream if more presentation content follows the turn end. */
	async drainUsageOnly(): Promise<void> {
		this.usageOnly = true
		const hadQueuedPresentationContent = this.queue.length > 0
		this.queue = []
		this.notifyWaiter()
		if (hadQueuedPresentationContent) {
			await this.stop()
			return
		}
		await this.waitForCompletion()
	}

	async stop(): Promise<void> {
		this.stopRequested = true
		this.clearQueueMetricsTimer()
		await this.closeIterator()
		await this.pumpPromise.catch(() => {})
	}

	async waitForCompletion(): Promise<void> {
		await this.pumpPromise
		this.clearQueueMetricsTimer()
		if (this.readError) {
			throw this.readError
		}
	}
}

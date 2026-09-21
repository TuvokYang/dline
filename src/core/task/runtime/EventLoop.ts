import { type TaskEvent, type TaskState, transition } from "../kernel"
import type { CommitPipeline } from "./CommitPipeline"
import type { EventSubmissionResult } from "./contracts"
import type { DurableCommandOutbox } from "./DurableCommandOutbox"
import { type Deferred, deferred } from "./deferred"

interface QueuedEvent {
	readonly event: TaskEvent
	readonly result: Deferred<EventSubmissionResult>
}

export class EventLoop {
	private readonly queue: QueuedEvent[] = []
	private draining = false

	constructor(
		private state: TaskState,
		private readonly commits: CommitPipeline,
		private readonly outbox: DurableCommandOutbox,
	) {}

	getState(): Readonly<TaskState> {
		return this.state
	}

	submit(event: TaskEvent): Promise<EventSubmissionResult> {
		const result = deferred<EventSubmissionResult>()
		this.queue.push({ event, result })
		this.drain()
		return result.promise
	}

	private drain(): void {
		if (this.draining) return
		this.draining = true
		try {
			while (this.queue.length > 0) {
				const queued = this.queue.shift()!
				try {
					const reduced = transition(this.state, queued.event)
					if (reduced.kind === "rejected") {
						queued.result.resolve(reduced)
						continue
					}
					this.state = reduced.state
					const receipt = this.commits.commit(reduced.state, this.outbox.persistableAfter(reduced.commands))
					this.outbox.enqueue(reduced.commands, receipt)
					queued.result.resolve({ kind: "accepted", state: reduced.state, commands: reduced.commands, receipt })
				} catch (error) {
					queued.result.reject(error)
				}
			}
		} finally {
			this.draining = false
			if (this.queue.length > 0) this.drain()
		}
	}
}

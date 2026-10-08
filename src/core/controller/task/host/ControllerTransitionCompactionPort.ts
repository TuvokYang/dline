import type { TaskCompactionPort, TaskCompactionRequest } from "@core/controller/context-transition/types"
import { requestTaskCompaction } from "@core/task/compaction/TaskCompactionRequest"
import type { ActiveTaskSession } from "@core/task/session/ActiveTaskSession"
import { Logger } from "@shared/services/Logger"

type CompactionOutcome = "completed" | "cancelled" | "failed"

/** Resolve the compaction run owned by one transition operation. */
interface PendingTransitionCompaction {
	readonly compactionId: string
	settle(outcome: CompactionOutcome): void
}

export interface ControllerTransitionCompactionPortOptions {
	/** Current task session, or undefined when no task is open. */
	readonly getSession: () => ActiveTaskSession | undefined
}

/**
 * Run Profile/Mode transition compaction through the canonical task kernel.
 *
 * The transition Engine needs a synchronous-looking barrier ("is the context
 * small enough to adopt the target profile?"), while the kernel reports
 * compaction asynchronously through flow state. This port bridges the two: it
 * admits the request, then waits for that specific compaction identity to reach
 * a terminal status, so a later unrelated compaction can never satisfy an
 * earlier transition.
 */
export class ControllerTransitionCompactionPort implements TaskCompactionPort {
	private pending: PendingTransitionCompaction | undefined

	constructor(private readonly options: ControllerTransitionCompactionPortOptions) {}

	async compact(request: TaskCompactionRequest): Promise<CompactionOutcome> {
		const session = this.options.getSession()
		if (!session) return "failed"
		if (this.pending) return "failed"

		const admitted = await requestTaskCompaction(session, {
			stateRevision: session.state().revision,
			mode: "summarize",
			trigger: "transition",
			// The context has to fit the target, so the target condenses it;
			// the task only adopts that handler once the transition commits.
			scope: { api: request.targetApi, mode: request.targetMode },
		})
		// A refusal includes "nothing to compact": the context did not get any
		// smaller, so the transition must not commit as if it now fits.
		if (!admitted.accepted) {
			Logger.warn(`[TransitionCompaction] Compaction rejected for ${request.operationId}: ${admitted.result}`)
			return "failed"
		}
		const compactionId = admitted.compactionId ?? session.state().flow.compaction?.compactionId
		if (!compactionId) return "failed"
		try {
			return await this.awaitCompaction(session, compactionId)
		} finally {
			session.owners.compactionScopes?.release(compactionId)
		}
	}

	async complete(_operationId: string): Promise<void> {
		this.pending = undefined
	}

	async abort(operationId: string, reason: string): Promise<void> {
		const pending = this.pending
		this.pending = undefined
		if (!pending) return
		Logger.debug(`[TransitionCompaction] Aborting compaction for ${operationId}: ${reason}`)
		pending.settle("cancelled")
	}

	/**
	 * Wait until the admitted compaction reaches a terminal kernel status.
	 *
	 * Committed view notifications are the only ordered signal that state
	 * advanced, so the outcome is read from flow state rather than inferred from
	 * the executor, which would bypass halt and generation fencing.
	 */
	private awaitCompaction(session: ActiveTaskSession, compactionId: string): Promise<CompactionOutcome> {
		return new Promise<CompactionOutcome>((resolve) => {
			let settled = false
			const settle = (outcome: CompactionOutcome) => {
				if (settled) return
				settled = true
				clearInterval(poll)
				if (this.pending?.compactionId === compactionId) this.pending = undefined
				resolve(outcome)
			}
			const poll = setInterval(() => {
				const compaction = session.state().flow.compaction
				if (!compaction || compaction.compactionId !== compactionId) return settle("cancelled")
				if (compaction.status === "completed") return settle("completed")
				if (compaction.status === "expired") return settle("cancelled")
				if (compaction.status === "failed") return settle("failed")
			}, COMPACTION_POLL_INTERVAL_MS)
			this.pending = { compactionId, settle }
		})
	}
}

/**
 * Kernel flow state has no change subscription for a single compaction, so the
 * bridge samples it. The interval is short enough to stay invisible in a
 * transition that already waits on a provider request.
 */
const COMPACTION_POLL_INTERVAL_MS = 50

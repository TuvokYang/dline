import type {
	CompactionExecutionInput,
	CompactionExecutionResult,
	CompactionPort,
} from "../executors/compaction/CompactionCommandExecutor"
import { CompactionReviewWithdrawnError } from "../executors/compaction/ProductionCompactionAdapter"
import type { ComposeCompactionBarrierPort, RoundReadiness } from "../executors/compose/ProductionComposeAdapter"
import type { TaskState } from "../kernel"
import type { ActiveTaskSession } from "../session/ActiveTaskSession"
import type { LifecycleBarrierPort } from "../session/TaskInputAdmission"
import type { ContextPressureObserverPort } from "../session/TaskProviderRequestReporter"
import type { CompactionTrigger, LifecycleCommand } from "../stores/payload/TaskPayloadEnvelopes"
import { shouldCompactAutomatically } from "./AutomaticCompactionPolicy"
import type { CompactionRecoveryPort, CompactionRunOutcome } from "./CompactionRecovery"
import type { AdmissionCompaction, AdmissionCompactionPort } from "./FinalContextWindowGuard"
import { COMPACTION_FAILURE_MESSAGE } from "./MessageStateCompactionFailure"
import { NOTHING_TO_COMPACT, requestTaskCompaction } from "./TaskCompactionRequest"

/** The catalog identity of the manual compaction command and its aliases. */
export const COMPACT_COMMAND_ID = "command.compact"

/**
 * How long a round waits for an automatic compaction it scheduled.
 *
 * That wait exists to order two requests, not to guarantee one. A compaction
 * that never reports back - a fenced executor during shutdown, a provider that
 * stops answering - must not strand the round behind it, because the round is
 * what the user is waiting on. A compaction the user asked for is not bounded:
 * it waits on their review, which has no deadline.
 */
const COMPACTION_BARRIER_TIMEOUT_MS = 120_000

const ROUND_READY: RoundReadiness = { kind: "ready" }

/** Why a round stopped after the automatic compaction it waited on failed. */
export const AUTOMATIC_COMPACTION_FAILED = "automatic_compaction_failed"

interface CompactionRunResult {
	readonly outcome: CompactionRunOutcome
	/** Why a run that ran failed, in the words its failure card used. */
	readonly error?: string
	/** No run was needed because nothing answered exists to condense. */
	readonly nothingToCompact?: boolean
}

/**
 * Learns when a compaction run has finished.
 *
 * The observer wraps the executor's port rather than the provider service, so
 * settlement means the whole run is done - summary landed in the conversation
 * included - not merely that the provider answered.
 */
export interface CompactionSettlementObserverPort {
	instrument(port: CompactionPort): CompactionPort
}

export interface CompactionRoundBarrierOptions {
	readonly session: () => ActiveTaskSession | undefined
	readonly state: () => Readonly<TaskState>
	/** Whether the user allows the task to compact on its own; defaults to allowed. */
	readonly enabled?: () => boolean
	/** Reports a scheduling failure; compaction must not break the round that waited for it. */
	readonly onFailure?: (message: string) => void
	/** Bounds how long one round waits on an automatic run; tests override it to stay fast. */
	readonly barrierTimeoutMs?: number
}

interface ObservedPressure {
	readonly contextTokens: number
	readonly compactTriggerTokens: number
}

/**
 * Condenses the conversation at the barrier before the next round is composed.
 *
 * Two causes owe a round a compaction. Context pressure is only knowable after
 * a request settles, so a settled request records what it observed and the
 * next round waits for the summary first - the request that follows is the one
 * that fits. A `/compact` the user placed is carried by the input that named
 * it, so it runs before the round that admits that input, and that round only
 * goes ahead once the compaction did what the user asked.
 *
 * The barrier belongs to compose rather than to user submission, because a
 * round can also be opened by the kernel continuing a turn; a barrier that only
 * guarded submissions would let every continued round skip it.
 */
export class CompactionRoundBarrier
	implements
		ContextPressureObserverPort,
		ComposeCompactionBarrierPort,
		CompactionSettlementObserverPort,
		LifecycleBarrierPort,
		CompactionRecoveryPort,
		AdmissionCompactionPort
{
	private observed: ObservedPressure | undefined
	/** The last round stopped on a failed automatic compaction and has not been retried. */
	private stoppedOnFailure = false
	/** The round being composed already compacted, so it must not summarize its own summary. */
	private compactedThisRound = false
	/** A `/compact` typed into a dialog reply, owed to the round that reply opens. */
	private replied: { readonly command: LifecycleCommand; readonly generation: number } | undefined
	/** Rounds waiting on a run, keyed by the run so a stale one only releases its own waiter. */
	private readonly waiters = new Map<string, (result: CompactionRunResult) => void>()
	/** The last run that ended before any round waited on it. */
	private unclaimed: { readonly compactionId: string; readonly result: CompactionRunResult } | undefined

	constructor(private readonly options: CompactionRoundBarrierOptions) {}

	observe(pressure: ObservedPressure): void {
		this.observed = pressure
	}

	owns(commandId: string): boolean {
		return commandId === COMPACT_COMMAND_ID
	}

	truncationOffered(): boolean {
		return this.stoppedOnFailure
	}

	async settlement(compactionId: string): Promise<CompactionRunOutcome> {
		return (await this.awaitRun(compactionId, false, new AbortController().signal)).outcome
	}

	/**
	 * Compact for a round whose complete request measured over the trigger.
	 *
	 * The round already passed this barrier on the last request's usage; the
	 * measurement of the request itself is the final word, but a round that
	 * already compacted goes ahead rather than condensing its own summary.
	 */
	async compactForAdmission(signal: AbortSignal): Promise<AdmissionCompaction> {
		const session = this.options.session()
		if (!session || this.compactedThisRound || this.options.enabled?.() === false) return { kind: "skipped" }
		this.compactedThisRound = true
		const result = await this.compact(session, "automatic", signal)
		if (result.nothingToCompact) return { kind: "nothing_to_compact" }
		if (result.outcome === "completed") return { kind: "completed" }
		if (result.outcome !== "failed") return { kind: "skipped" }
		this.stoppedOnFailure = true
		return { kind: "failed", error: result.error ?? COMPACTION_FAILURE_MESSAGE }
	}

	/**
	 * Hold a `/compact` that arrived in an accepted dialog reply.
	 *
	 * A reply is not an intake entry, so no round admits it; the command is owed
	 * to the round the reply opens instead. It is bound to the generation it was
	 * accepted in, so a stop between the reply and that round retires it rather
	 * than letting a later, unrelated round carry it out.
	 */
	request(command: LifecycleCommand): void {
		if (!this.owns(command.commandId)) return
		this.replied = { command, generation: this.options.state().generation }
	}

	/**
	 * Observe when a compaction run finishes, and how.
	 *
	 * The barrier waits for the run itself rather than for a kernel revision,
	 * because compose and compaction are independent executor domains: a round
	 * being composed cannot wait on a revision that includes itself.
	 */
	instrument(port: CompactionPort): CompactionPort {
		return {
			run: async (input: CompactionExecutionInput): Promise<CompactionExecutionResult> => {
				let settled: CompactionRunResult = { outcome: "failed" }
				try {
					const result = await port.run(input)
					settled = { outcome: "completed" }
					// The pressure was measured on the conversation this run just
					// replaced, so it no longer says anything about the next round.
					this.observed = undefined
					this.stoppedOnFailure = false
					return result
				} catch (error) {
					// A stop or a withdrawn review is the user's own decision, not a failure.
					if (input.signal.aborted || error instanceof CompactionReviewWithdrawnError)
						settled = { outcome: "withdrawn" }
					else if (error instanceof Error && error.message.trim())
						settled = { outcome: "failed", error: error.message.trim() }
					throw error
				} finally {
					this.settle(input.compactionId, settled)
				}
			},
		}
	}

	/**
	 * Run what the round owes before it is drafted.
	 *
	 * A compaction the user asked for comes first and replaces any automatic
	 * one: it condenses the same conversation, and running both would summarize
	 * a summary. Its outcome decides the round - the user asked for a smaller
	 * context before going on, so a failed or withdrawn one gives the round up.
	 *
	 * An automatic run that failed stops the round too: the request it was
	 * clearing room for would not fit, and the user is the one to retry. The
	 * pressure stays recorded so the round that retries compacts again.
	 */
	async settleBeforeRound(input: {
		readonly signal: AbortSignal
		readonly lifecycle: readonly LifecycleCommand[]
		readonly pendingContextTokens?: number
	}): Promise<RoundReadiness> {
		const replied = this.takeReplied()
		const manual = mergeOwedCompactions([
			...input.lifecycle.filter((command) => this.owns(command.commandId)),
			...(replied ? [replied] : []),
		])
		const observed = this.observed
		const pendingContextTokens = Math.max(0, input.pendingContextTokens ?? 0)
		const pressure = observed ? { ...observed, contextTokens: observed.contextTokens + pendingContextTokens } : undefined
		// Consumed whatever the outcome: a refused or failed compaction must not
		// make every later round retry the same request forever.
		this.observed = undefined
		// This is the round the user chose to go on with instead of truncating.
		this.stoppedOnFailure = false
		this.compactedThisRound = false
		const session = this.options.session()
		if (!session) return ROUND_READY
		if (manual) {
			this.compactedThisRound = true
			const { outcome } = await this.compact(session, "manual", input.signal, manual.premessage)
			if (outcome === "completed") return ROUND_READY
			return { kind: "withdrawn", reason: `manual_compaction_${outcome === "refused" ? "failed" : outcome}` }
		}
		if (!observed || !pressure || this.options.enabled?.() === false) return ROUND_READY
		if (!shouldCompactAutomatically(this.options.state(), pressure)) return ROUND_READY
		this.compactedThisRound = true
		const result = await this.compact(session, "automatic", input.signal)
		if (result.outcome !== "failed") return ROUND_READY
		this.observed ??= observed
		this.stoppedOnFailure = true
		return {
			kind: "failed",
			reason: AUTOMATIC_COMPACTION_FAILED,
			presentation: result.error ?? COMPACTION_FAILURE_MESSAGE,
		}
	}

	/** A reply's command, unless a stop since it was accepted retired it. */
	private takeReplied(): LifecycleCommand | undefined {
		const replied = this.replied
		this.replied = undefined
		return replied && replied.generation === this.options.state().generation ? replied.command : undefined
	}

	private async compact(
		session: ActiveTaskSession,
		trigger: Exclude<CompactionTrigger, "transition">,
		signal: AbortSignal,
		guidance?: string,
	): Promise<CompactionRunResult> {
		let compactionId: string
		try {
			const request = await requestTaskCompaction(session, {
				stateRevision: this.options.state().revision,
				mode: "summarize",
				trigger,
				...(guidance ? { guidance } : {}),
			})
			if (!request.accepted || !request.compactionId) {
				this.options.onFailure?.(`${trigger} compaction not scheduled: ${request.result}`)
				// Nothing settled yet means the context is already as small as it gets.
				return request.result === NOTHING_TO_COMPACT
					? { outcome: "completed", nothingToCompact: true }
					: { outcome: "refused" }
			}
			compactionId = request.compactionId
		} catch (error) {
			this.options.onFailure?.(
				`${trigger} compaction not scheduled: ${error instanceof Error ? error.message : String(error)}`,
			)
			return { outcome: "refused" }
		}
		return await this.awaitRun(compactionId, trigger === "automatic", signal)
	}

	/**
	 * Wait for one run by identity.
	 *
	 * A stopped round stops waiting even if the run never reports back, because
	 * the stop may have fenced it before it could.
	 */
	private async awaitRun(compactionId: string, bounded: boolean, signal: AbortSignal): Promise<CompactionRunResult> {
		const unclaimed = this.unclaimed
		if (unclaimed?.compactionId === compactionId) {
			this.unclaimed = undefined
			return unclaimed.result
		}
		const settled = new Promise<CompactionRunResult>((resolve) => this.waiters.set(compactionId, resolve))
		try {
			const released = untilAborted(settled, signal)
			return bounded ? await this.withTimeout(released) : await released
		} finally {
			this.waiters.delete(compactionId)
		}
	}

	private async withTimeout(promise: Promise<CompactionRunResult>): Promise<CompactionRunResult> {
		const limit = this.options.barrierTimeoutMs ?? COMPACTION_BARRIER_TIMEOUT_MS
		let timer: ReturnType<typeof setTimeout> | undefined
		const deadline = new Promise<CompactionRunResult>((resolve) => {
			timer = setTimeout(() => resolve({ outcome: "timed_out" }), limit)
		})
		try {
			return await Promise.race([promise, deadline])
		} finally {
			if (timer) clearTimeout(timer)
		}
	}

	private settle(compactionId: string, result: CompactionRunResult): void {
		const waiter = this.waiters.get(compactionId)
		if (waiter) {
			this.waiters.delete(compactionId)
			waiter(result)
			return
		}
		this.unclaimed = { compactionId, result }
	}
}

/**
 * Fold every compaction a round owes into the one run it performs.
 *
 * Several accepted inputs, or an input and a dialog reply, can each ask for
 * `/compact` before the same round. They condense the same conversation, so
 * one run serves them all, but each carried its own guidance and taking only
 * the first silently dropped the others. Guidance is kept in causal order.
 */
function mergeOwedCompactions(owed: readonly LifecycleCommand[]): LifecycleCommand | undefined {
	const [first] = owed
	if (!first) return undefined
	const guidance = owed.map((command) => command.premessage.trim()).filter((text) => text.length > 0)
	return { ...first, premessage: guidance.join("\n\n") }
}

/** Resolve with the run's result, or as withdrawn as soon as the signal aborts. */
async function untilAborted(promise: Promise<CompactionRunResult>, signal: AbortSignal): Promise<CompactionRunResult> {
	if (signal.aborted) return { outcome: "withdrawn" }
	let release: () => void = () => undefined
	const aborted = new Promise<CompactionRunResult>((resolve) => {
		release = () => resolve({ outcome: "withdrawn" })
	})
	signal.addEventListener("abort", release, { once: true })
	try {
		return await Promise.race([promise, aborted])
	} finally {
		signal.removeEventListener("abort", release)
	}
}

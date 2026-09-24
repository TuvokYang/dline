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

/** How one compaction run ended, as far as the round waiting on it cares. */
type CompactionRunOutcome = "completed" | "failed" | "withdrawn"

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
	implements ContextPressureObserverPort, ComposeCompactionBarrierPort, CompactionSettlementObserverPort, LifecycleBarrierPort
{
	private observed: ObservedPressure | undefined
	/** A `/compact` typed into a dialog reply, owed to the round that reply opens. */
	private replied: { readonly command: LifecycleCommand; readonly generation: number } | undefined
	/** Rounds waiting on a run, keyed by the run so a stale one only releases its own waiter. */
	private readonly waiters = new Map<string, (outcome: CompactionRunOutcome) => void>()
	/** The last run that ended before any round waited on it. */
	private unclaimed: { readonly compactionId: string; readonly outcome: CompactionRunOutcome } | undefined

	constructor(private readonly options: CompactionRoundBarrierOptions) {}

	observe(pressure: ObservedPressure): void {
		this.observed = pressure
	}

	owns(commandId: string): boolean {
		return commandId === COMPACT_COMMAND_ID
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
				let outcome: CompactionRunOutcome = "failed"
				try {
					const result = await port.run(input)
					outcome = "completed"
					return result
				} catch (error) {
					// A stop or a withdrawn review is the user's own decision, not a failure.
					if (input.signal.aborted || error instanceof CompactionReviewWithdrawnError) outcome = "withdrawn"
					throw error
				} finally {
					this.settle(input.compactionId, outcome)
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
	 */
	async settleBeforeRound(input: {
		readonly signal: AbortSignal
		readonly lifecycle: readonly LifecycleCommand[]
	}): Promise<RoundReadiness> {
		const replied = this.takeReplied()
		const manual = mergeOwedCompactions([
			...input.lifecycle.filter((command) => this.owns(command.commandId)),
			...(replied ? [replied] : []),
		])
		const pressure = this.observed
		// Consumed whatever the outcome: a refused or failed compaction must not
		// make every later round retry the same request forever.
		this.observed = undefined
		const session = this.options.session()
		if (!session) return ROUND_READY
		if (manual) {
			const outcome = await this.compact(session, "manual", input.signal, manual.premessage)
			return outcome === "completed" ? ROUND_READY : { kind: "withdrawn", reason: `manual_compaction_${outcome}` }
		}
		if (!pressure || this.options.enabled?.() === false) return ROUND_READY
		if (!shouldCompactAutomatically(this.options.state(), pressure)) return ROUND_READY
		await this.compact(session, "automatic", input.signal)
		return ROUND_READY
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
	): Promise<CompactionRunOutcome> {
		try {
			const outcome = await requestTaskCompaction(session, {
				stateRevision: this.options.state().revision,
				mode: "summarize",
				trigger,
				...(guidance ? { guidance } : {}),
			})
			if (!outcome.accepted || !outcome.compactionId) {
				this.options.onFailure?.(`${trigger} compaction not scheduled: ${outcome.result}`)
				// Nothing settled yet means the context is already as small as it gets.
				return outcome.result === NOTHING_TO_COMPACT ? "completed" : "failed"
			}
			return await this.awaitRun(outcome.compactionId, trigger === "automatic", signal)
		} catch (error) {
			this.options.onFailure?.(`${trigger} compaction failed: ${error instanceof Error ? error.message : String(error)}`)
			return "failed"
		}
	}

	/**
	 * Wait for one run by identity.
	 *
	 * A stopped round stops waiting even if the run never reports back, because
	 * the stop may have fenced it before it could.
	 */
	private async awaitRun(compactionId: string, bounded: boolean, signal: AbortSignal): Promise<CompactionRunOutcome> {
		const unclaimed = this.unclaimed
		if (unclaimed?.compactionId === compactionId) {
			this.unclaimed = undefined
			return unclaimed.outcome
		}
		const settled = new Promise<CompactionRunOutcome>((resolve) => this.waiters.set(compactionId, resolve))
		try {
			const released = untilAborted(settled, signal)
			return bounded ? await this.withTimeout(released) : await released
		} finally {
			this.waiters.delete(compactionId)
		}
	}

	private async withTimeout(promise: Promise<CompactionRunOutcome>): Promise<CompactionRunOutcome> {
		const limit = this.options.barrierTimeoutMs ?? COMPACTION_BARRIER_TIMEOUT_MS
		let timer: ReturnType<typeof setTimeout> | undefined
		const deadline = new Promise<CompactionRunOutcome>((resolve) => {
			timer = setTimeout(() => resolve("failed"), limit)
		})
		try {
			return await Promise.race([promise, deadline])
		} finally {
			if (timer) clearTimeout(timer)
		}
	}

	private settle(compactionId: string, outcome: CompactionRunOutcome): void {
		const waiter = this.waiters.get(compactionId)
		if (waiter) {
			this.waiters.delete(compactionId)
			waiter(outcome)
			return
		}
		this.unclaimed = { compactionId, outcome }
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

/** Resolve with the run's outcome, or as withdrawn as soon as the signal aborts. */
async function untilAborted(promise: Promise<CompactionRunOutcome>, signal: AbortSignal): Promise<CompactionRunOutcome> {
	if (signal.aborted) return "withdrawn"
	let release: () => void = () => undefined
	const aborted = new Promise<CompactionRunOutcome>((resolve) => {
		release = () => resolve("withdrawn")
	})
	signal.addEventListener("abort", release, { once: true })
	try {
		return await Promise.race([promise, aborted])
	} finally {
		signal.removeEventListener("abort", release)
	}
}

import { formatResponse } from "@core/prompts/responses"
import {
	type CompactionLandingInput,
	type CompactionLandingPort,
	type CompactionSummary,
	readCompactionSummary,
} from "../../compaction/CompactionSummaryLanding"
import type { TaskPayloadStore } from "../../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type {
	CompactionContextEnvelope,
	CompactionResultEnvelope,
	CompactionTrigger,
} from "../../stores/payload/TaskPayloadEnvelopes"
import type { CompactionExecutionInput, CompactionPort } from "./CompactionCommandExecutor"

export interface ProductionCompactionService {
	run(input: {
		readonly compactionId: string
		readonly attempt: string
		readonly context: unknown
		/** Who asked; a manual run is the user's to retry, so its failed Passes are not replayed. */
		readonly trigger?: CompactionTrigger
		readonly signal: AbortSignal
		readonly publish: CompactionExecutionInput["publish"]
	}): Promise<unknown>
}

/**
 * The span a summary actually replaces, and whether a reply goes with it.
 *
 * A summary that covered only the oldest turns stands for those turns alone;
 * the rest of the span stays verbatim, and so does the reply at its end, which
 * is still where the conversation left off. When those turns end on a call the
 * user answered, the answer opens the next turn, which the summary did not
 * cover: the landed span takes the answer as well, so the call is not left
 * behind as a result without a call, and replays it after the summary.
 */
function landedSpan(
	context: CompactionContextEnvelope,
	summary: CompactionSummary,
): Pick<CompactionLandingInput, "span" | "continuation"> {
	const span = context.span
	if (!span) return {}
	const coveredThrough = summary.coveredThrough
	if (coveredThrough === undefined || coveredThrough >= span.to.seq) {
		return { span, ...(context.continuation === undefined ? {} : { continuation: context.continuation }) }
	}
	const answer = context.replies?.find((reply) => reply.callSeq === coveredThrough)
	if (answer) return { span: { from: span.from, to: { ...span.to, seq: answer.replySeq } }, continuation: answer.continuation }
	return { span: { from: span.from, to: { ...span.to, seq: coveredThrough } } }
}

/**
 * Raised by a review port whose dialog was withdrawn rather than answered.
 *
 * A stop releases every dialog receiver, and the dialog domain may be released
 * before this run's own signal aborts. Without a distinct error that
 * withdrawal looked like a broken run and was shown as a failure for a
 * compaction the user had just cancelled.
 */
export class CompactionReviewWithdrawnError extends Error {
	constructor(readonly reason: string) {
		super(`compaction review withdrawn: ${reason}`)
		this.name = "CompactionReviewWithdrawnError"
	}
}

/** The user's verdict on one generated summary. */
export type CompactionReviewDecision =
	| { readonly action: "accept" }
	| { readonly action: "regenerate"; readonly feedback: string }

/**
 * Shows a summary the user asked for before it replaces anything.
 *
 * Condensing is the user's decision when they requested it, so the summary is
 * a proposal until they accept it. A rejection carries what they want changed,
 * and the same run asks again with that feedback. Declared by the compaction
 * domain and implemented where dialogs live, so this module never opens UI.
 */
export interface CompactionReviewPort {
	review(input: {
		readonly compactionId: string
		readonly attempt: string
		readonly summary: string
		readonly signal: AbortSignal
	}): Promise<CompactionReviewDecision>
}

/**
 * Tells the user a compaction produced nothing to land.
 *
 * A failed run leaves the conversation as it was, which is invisible unless it
 * is said: the user asked for a smaller context, or the task needed one, and
 * would otherwise believe it happened. Declared here and implemented where the
 * chat lives, so this module never writes UI rows.
 */
export interface CompactionFailurePresentationPort {
	/** `error` is the reason the run failed, shown to the user; absent when there is none to state. */
	present(input: { readonly compactionId: string; readonly attempt: string; readonly error?: string }): Promise<void>
}

export interface ProductionCompactionAdapterOptions {
	readonly payloads: TaskPayloadStore
	readonly service: ProductionCompactionService
	/** Applies the finished summary to the conversation; absent in headless assemblies. */
	readonly landing?: CompactionLandingPort
	/** Reviews manually requested summaries; absent means they land like automatic ones. */
	readonly review?: CompactionReviewPort
	/** Shows a run that failed; absent in headless assemblies, where the kernel event is the record. */
	readonly failure?: CompactionFailurePresentationPort
}

/**
 * Upper bound on regenerations within one run.
 *
 * Each one is a paid request the user asked for, so the bound only exists to
 * keep a run from looping forever on a broken review port, not to ration them.
 */
const MAX_REGENERATIONS = 20

/** Owns compaction payload decoding and result materialization around the host service. */
export class ProductionCompactionAdapter implements CompactionPort {
	constructor(private readonly options: ProductionCompactionAdapterOptions) {}

	async run(input: CompactionExecutionInput): Promise<{ readonly resultRef: string }> {
		if (input.signal.aborted) throw input.signal.reason
		try {
			return await this.condense(input)
		} catch (error) {
			// A stop is the user's own decision and needs no explanation; anything
			// else left the conversation unchanged without them knowing.
			const stopped = input.signal.aborted || error instanceof CompactionReviewWithdrawnError
			if (!stopped) {
				await this.options.failure?.present({
					compactionId: input.compactionId,
					attempt: input.attempt,
					...(error instanceof Error && error.message ? { error: error.message } : {}),
				})
			}
			throw error
		}
	}

	private async condense(input: CompactionExecutionInput): Promise<{ readonly resultRef: string }> {
		const context = decodeTaskPayload<CompactionContextEnvelope>(await this.options.payloads.read(input.contextRef))
		if (context.kind !== "compaction_context") throw new Error("InvalidCompactionContextPayload")
		const { result, summary } = await this.produce(input, context)
		// Landing happens before the result is reported complete: the kernel only
		// records the ref, so a summary that is not applied here is paid for and
		// then discarded, leaving the context as full as it was.
		if (summary && this.options.landing) {
			await this.options.landing.land({
				compactionId: input.compactionId,
				attempt: input.attempt,
				signal: input.signal,
				...summary,
				...landedSpan(context, summary),
			})
			if (input.signal.aborted) throw input.signal.reason
		}
		const envelope: CompactionResultEnvelope = { kind: "compaction_result", result }
		return { resultRef: await this.options.payloads.put(encodeTaskPayload(envelope)) }
	}

	/**
	 * Generate the summary this run lands, asking the user first when they
	 * requested it.
	 *
	 * Regeneration stays inside the run so the conversation is never condensed
	 * by a summary the user rejected, and so a stop during review cancels the
	 * whole run instead of leaving a half-accepted one behind.
	 */
	private async produce(
		input: CompactionExecutionInput,
		context: CompactionContextEnvelope,
	): Promise<{ readonly result: unknown; readonly summary?: CompactionSummary }> {
		if (context.mode === "force_truncate") {
			// The provider just failed to summarize this span, so nothing is asked
			// of it; the user already confirmed the loss, so nothing is reviewed.
			const summary = { summary: formatResponse.contextTruncationNotice() }
			return { result: summary, summary }
		}
		const review = context.trigger === "manual" ? this.options.review : undefined
		let requestContext = context.context
		for (let regenerations = 0; ; regenerations++) {
			const result = await this.options.service.run({
				...input,
				context: requestContext,
				...(context.trigger === undefined ? {} : { trigger: context.trigger }),
			})
			if (input.signal.aborted) throw input.signal.reason
			const summary = readCompactionSummary(result)
			if (!review || !summary) return { result, summary }
			const decision = await review.review({
				compactionId: input.compactionId,
				attempt: input.attempt,
				summary: summary.summary,
				signal: input.signal,
			})
			if (input.signal.aborted) throw input.signal.reason
			if (decision.action === "accept") return { result, summary }
			if (regenerations >= MAX_REGENERATIONS) throw new Error("CompactionRegenerationLimit")
			requestContext = regenerationContext(context.context, decision.feedback)
		}
	}
}

/**
 * The context of a fresh summary request after the user rejected one.
 *
 * What the user typed alongside Regenerate is their latest word on the summary,
 * so it replaces the `/compact` guidance instead of adding to it; an empty
 * Regenerate asks for a plain summary. Carrying the old guidance forward would
 * keep steering every retry toward the summary the user just rejected.
 */
function regenerationContext(context: unknown, feedback: string): unknown {
	if (!context || typeof context !== "object") return context
	const { guidance: _rejected, feedback: _previous, ...rest } = context as Record<string, unknown>
	return feedback.trim() ? { ...rest, feedback } : rest
}

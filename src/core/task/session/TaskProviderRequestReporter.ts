import type { ApiHandler } from "@core/api"
import {
	computeSummarizeBudget,
	getContextWindowInfo,
	resolveCompactTriggerPolicy,
} from "@core/context/context-management/context-window-utils"
import type { ClineApiReqCancelReason, ClineApiReqInfo } from "@/shared/ExtensionMessage"
import type {
	ProviderRequestOutcome,
	ProviderRequestRecord,
	ProviderRequestReportPort,
	ProviderRetryNotice,
} from "../executors/provider/service/ProviderRequestReport"
import type { MessageStateHandler } from "../message-state"
import type { PromptCacheHealthTracker } from "../prompt-cache/PromptCacheHealthTracker"
import { updateApiReqMsg } from "../utils"
import type { PresentationIdSequence } from "./PresentationIdSequence"

export interface TaskProviderRequestReporterOptions {
	readonly messages: MessageStateHandler
	readonly nextPresentationId: PresentationIdSequence
	/** The handler that will serve the request, for pricing and context window facts. */
	readonly api: () => ApiHandler
	readonly promptCache: PromptCacheHealthTracker
	/** Auto-condense settings that move the compaction trigger; read per request. */
	readonly compactTriggerOptions?: () => CompactTriggerSettings
	/** Told what the settled request cost the context window; absent when nothing acts on it. */
	readonly pressure?: ContextPressureObserverPort
	/** Told the context occupancy a settled request reported; absent when nothing displays it. */
	readonly usage?: ContextUsageObserverPort
	/** Told the tokens a settled request consumed, for the Profile's daily totals; absent when nothing counts them. */
	readonly profileTokens?: ProfileTokenUsagePort
}

/**
 * Counts what each request consumed against the Profile that served it.
 *
 * Subscription endpoints report quota percentages only, so the daily token
 * figures the usage surfaces show come from Dline's own requests. A request is
 * settled exactly once however often it was retried, so counting at settlement
 * never counts a turn twice.
 */
export interface ProfileTokenUsagePort {
	/**
	 * The Profile a request that is about to start is sent under.
	 *
	 * Read when the request opens: a switch while it runs replaces the handler
	 * for the next request, but this one was served by the Profile it started on.
	 */
	activeProfileId(): string | undefined
	record(profileId: string, increment: { readonly inputTokens: number; readonly outputTokens: number }): void
}

/**
 * Receives the lifecycle of each provider request and the occupancy it reported.
 *
 * Showing how full the window is belongs to whoever renders the task, not to
 * the reporter; a headless assembly that renders nothing leaves the port out.
 */
export interface ContextUsageObserverPort {
	started(request: { readonly turnId: string; readonly contextWindow: number }): Promise<void>
	record(usage: { readonly turnId: string; readonly contextTokens: number; readonly contextWindow: number }): Promise<void>
	/** The request ended without a usable figure: cancelled, failed, or reported nothing. */
	unmeasured(request: { readonly turnId: string }): Promise<void>
}

/**
 * Receives what a settled request left in the context window.
 *
 * The usage a request reports is the only moment the task learns its real
 * context pressure, but deciding what to do about it is not the reporter's
 * concern. Keeping that decision behind a port lets compaction own it, and lets
 * an assembly that never compacts leave the port out.
 */
export interface ContextPressureObserverPort {
	observe(pressure: { readonly contextTokens: number; readonly compactTriggerTokens: number }): void
}

/** The auto-condense knobs that change where compaction starts. */
export interface CompactTriggerSettings {
	readonly triggerPercent?: number
	readonly maxContextTokens?: number
	readonly minReserveTokens?: number
	readonly maxReserveTokens?: number
}

/**
 * Publishes one `api_req_started` row per provider request and settles it.
 *
 * This row is the task's only durable record of what a turn consumed. Context
 * pressure, prompt cache health, subagent budgets and the chat's request row
 * all derive from it, so the row must exist for every request rather than only
 * for the ones that finished: a cancelled or failed request that left no row
 * would make the task look like it had used nothing.
 *
 * The row opens before the stream so a running request is visible, and settles
 * once the stream ends, which also feeds the prompt cache sample.
 */
export class TaskProviderRequestReporter implements ProviderRequestReportPort {
	constructor(private readonly options: TaskProviderRequestReporterOptions) {}

	async begin(input: { readonly turnId: string }): Promise<ProviderRequestRecord> {
		const ts = this.options.nextPresentationId()
		await this.options.messages.addToClineMessages({
			ts,
			type: "say",
			say: "api_req_started",
			text: JSON.stringify({ request: input.turnId } satisfies ClineApiReqInfo),
		})
		await this.options.usage?.started({
			turnId: input.turnId,
			contextWindow: getContextWindowInfo(this.options.api()).contextWindow,
		})
		const retryCard = new RetryCard(this.options.messages, this.options.nextPresentationId)
		const profileId = this.options.profileTokens?.activeProfileId()
		return {
			retrying: (notice) => retryCard.show(notice),
			recovered: () => retryCard.withdraw(),
			settle: async (settlement) => {
				// A request that failed after retrying keeps its card as the record of
				// the attempts; any other ending makes the countdown obsolete.
				if (settlement.outcome === "failed") await retryCard.markFailed()
				else await retryCard.withdraw()
				await this.settle(ts, input.turnId, settlement, profileId)
			},
		}
	}

	private async settle(
		ts: number,
		turnId: string,
		settlement: { readonly usage?: Readonly<Record<string, number>>; readonly outcome: ProviderRequestOutcome },
		profileId: string | undefined,
	): Promise<void> {
		const index = this.options.messages.clineMessages.findIndex((message) => message.ts === ts)
		if (index < 0) return
		const api = this.options.api()
		const tokens = readUsageTokens(settlement.usage)
		const contextTokens = tokens.inputTokens + tokens.cacheWriteTokens + tokens.cacheReadTokens + tokens.outputTokens
		await updateApiReqMsg({
			messageStateHandler: this.options.messages,
			lastApiReqIndex: index,
			inputTokens: tokens.inputTokens,
			outputTokens: tokens.outputTokens,
			cacheWriteTokens: tokens.cacheWriteTokens,
			cacheReadTokens: tokens.cacheReadTokens,
			contextTokens,
			totalCost: tokens.totalCost,
			api,
			cancelReason: cancelReasonFor(settlement.outcome),
		})
		// Flushed here because the request row is what a restarted task reads to
		// rebuild context usage; leaving it buffered would lose the turn's cost.
		await this.options.messages.flushMessageUpdate(index)
		this.recordProfileTokens(profileId, tokens)
		const { contextWindow } = getContextWindowInfo(api)
		const compactTriggerTokens = this.recordCacheSample(api, settlement, tokens, contextTokens, contextWindow)
		// Only a completed request describes the conversation that the next one
		// will carry; a cancelled or failed turn never entered the history.
		if (settlement.outcome !== "completed") {
			await this.options.usage?.unmeasured({ turnId })
			return
		}
		this.options.pressure?.observe({ contextTokens, compactTriggerTokens })
		// A request that reported no usage says nothing about occupancy; showing
		// zero would read as an emptied window rather than an unknown one.
		if (contextTokens > 0) await this.options.usage?.record({ turnId, contextTokens, contextWindow })
		else await this.options.usage?.unmeasured({ turnId })
	}

	/**
	 * Tokens are consumed whatever the outcome, so a cancelled or failed request
	 * counts too. Input matches the task header: fresh input plus cache reads and writes.
	 */
	private recordProfileTokens(profileId: string | undefined, tokens: UsageTokens): void {
		if (!profileId) return
		const increment = {
			inputTokens: tokens.inputTokens + tokens.cacheWriteTokens + tokens.cacheReadTokens,
			outputTokens: tokens.outputTokens,
		}
		if (increment.inputTokens <= 0 && increment.outputTokens <= 0) return
		try {
			this.options.profileTokens?.record(profileId, increment)
		} catch {
			// A usage surface must not change how the request settles.
		}
	}

	/** Records the cache sample and reports the trigger it resolved for this request. */
	private recordCacheSample(
		api: ApiHandler,
		settlement: { readonly usage?: Readonly<Record<string, number>>; readonly outcome: ProviderRequestOutcome },
		tokens: UsageTokens,
		contextTokens: number,
		contextWindow: number,
	): number {
		const compactTriggerTokens = resolveCompactTriggerTokens(contextWindow, this.options.compactTriggerOptions?.())
		this.options.promptCache.recordRequest({
			supportsPromptCache: api.getModel().info.capabilities?.supportsPromptCache === true,
			cacheUsageReported: settlement.usage !== undefined,
			inputTokens: tokens.inputTokens,
			cacheWriteTokens: tokens.cacheWriteTokens,
			cacheReadTokens: tokens.cacheReadTokens,
			contextTokens,
			contextWindow,
			compactTriggerTokens,
			completed: settlement.outcome === "completed",
			// Compaction requests run through their own domain and never reach the
			// provider executor, so a reported request is always an ordinary turn.
			isCompactionRequest: false,
		})
		return compactTriggerTokens
	}
}

/**
 * The one live countdown card of a request's automatic retries.
 *
 * Every attempt replaces the previous card, so the chat shows one countdown
 * rather than a stack of identical failures. The card is re-created at the end
 * of the transcript instead of edited in place, because the chat hides a card
 * that sits behind a later request row.
 */
class RetryCard {
	private ts?: number
	private notice?: ProviderRetryNotice

	constructor(
		private readonly messages: MessageStateHandler,
		private readonly nextPresentationId: PresentationIdSequence,
	) {}

	async show(notice: ProviderRetryNotice): Promise<void> {
		await this.withdraw()
		const ts = this.nextPresentationId()
		await this.messages.addToClineMessages({ ts, type: "say", say: "error_retry", text: cardText(notice) })
		this.ts = ts
		this.notice = notice
	}

	async withdraw(): Promise<void> {
		const ts = this.ts
		this.ts = undefined
		this.notice = undefined
		if (ts !== undefined) await this.messages.removeMessagesByTs([ts])
	}

	/** The retries did not recover the request; the card stops counting down and says so. */
	async markFailed(): Promise<void> {
		const index = this.ts === undefined ? -1 : this.messages.clineMessages.findIndex((message) => message.ts === this.ts)
		if (index < 0 || !this.notice) return
		await this.messages.updateClineMessage(index, { text: cardText(this.notice, true) })
		await this.messages.flushMessageUpdate(index)
	}
}

/** The card payload the chat's retry box renders. */
function cardText(notice: ProviderRetryNotice, failed = false): string {
	return JSON.stringify({
		attempt: notice.attempt,
		maxAttempts: notice.maxAttempts,
		delaySeconds: failed ? 0 : notice.delayMs / 1000,
		errorMessage: notice.errorMessage,
		...(failed ? { failed: true } : {}),
	})
}

/**
 * The occupancy at which the conversation should be compacted.
 *
 * Shared with every place that judges context pressure outside a live
 * request, so a pressure recovered from a stored request row is measured
 * against the same trigger the request itself would have reported.
 */
export function resolveCompactTriggerTokens(contextWindow: number, settings: CompactTriggerSettings = {}): number {
	return resolveCompactTriggerPolicy(contextWindow, computeSummarizeBudget(), settings).compactTriggerTokens
}

interface UsageTokens {
	readonly inputTokens: number
	readonly outputTokens: number
	readonly cacheWriteTokens: number
	readonly cacheReadTokens: number
	readonly totalCost?: number
}

/**
 * A request the user stopped or that never produced a turn is recorded with the
 * reason it ended, which is also what stops the chat row reading as still running.
 */
function cancelReasonFor(outcome: ProviderRequestOutcome): ClineApiReqCancelReason | undefined {
	if (outcome === "cancelled") return "user_cancelled"
	return outcome === "failed" ? "streaming_failed" : undefined
}

function readUsageTokens(usage: Readonly<Record<string, number>> | undefined): UsageTokens {
	return {
		inputTokens: nonNegative(usage?.inputTokens),
		outputTokens: nonNegative(usage?.outputTokens),
		cacheWriteTokens: nonNegative(usage?.cacheWriteTokens),
		cacheReadTokens: nonNegative(usage?.cacheReadTokens),
		// An absent cost lets the finalizer price the request from model metadata,
		// which a reported zero would suppress.
		totalCost: typeof usage?.totalCost === "number" && usage.totalCost > 0 ? usage.totalCost : undefined,
	}
}

function nonNegative(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0
}

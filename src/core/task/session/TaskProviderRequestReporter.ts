import type { ApiHandler } from "@core/api"
import * as ContextWindowManagement from "@core/context/context-management/context-window-utils"
import { Logger } from "@shared/services/Logger"
import type { UiApiReqCancelReason, UiApiReqInfo, UiMessage } from "@/shared/ExtensionMessage"
import type { ContextWindowRequestOpening } from "../ContextWindowIndicatorProjection"
import type * as ProviderRequestReport from "../executors/provider/service/ProviderRequestReport"
import type { MessageStateHandler } from "../message-state"
import { type ProviderUsageTelemetryPort, providerUsageTelemetry } from "../observability/provider-usage-telemetry"
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
	/** Overrides the default local OTel projection, for tests or a future remote usage coordinator. */
	readonly usageTelemetry?: ProviderUsageTelemetryPort
	/**
	 * Delivers retry-card changes to the chat; absent in an assembly that renders nothing.
	 *
	 * A retry happens before the stream produces anything, so no transient
	 * projection or committed state would carry the new card; without this the
	 * chat keeps the first attempt's countdown until the request settles.
	 */
	readonly retryView?: RetryCardView
	/**
	 * What the request about to start was admitted on; absent leaves its row
	 * without an anchor and its sending state without an estimate.
	 */
	readonly admittedRequest?: () => ContextWindowRequestOpening | undefined
}

/**
 * How a changed retry card reaches the chat.
 *
 * Replacing a card keeps the message count unchanged, and the chat only fetches
 * rows when that count moves, so a state publication alone never shows the next
 * attempt. A card that was added or rewritten is therefore delivered as a row the
 * chat merges by timestamp, and only a removal relies on the count.
 */
export interface RetryCardView {
	/** Delivers a card row that was added or rewritten. */
	showRow(row: UiMessage): Promise<void>
	/**
	 * Publishes the task state. A new card publishes it before its row, because the
	 * chat drops a row of a task it has not been shown yet, and the card is
	 * replaced before a dropped first attempt could be fetched again.
	 */
	publishState(): Promise<void>
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
	/** `opening` is what the request was admitted on, which its sending state shows until the provider reports. */
	started(request: {
		readonly turnId: string
		readonly contextWindow: number
		readonly opening?: ContextWindowRequestOpening
	}): Promise<void>
	/**
	 * `contextTokens` is everything the request left in the window; `outputTokens`
	 * is the part the response itself produced, which shows as received until
	 * the round settles.
	 */
	record(usage: {
		readonly turnId: string
		readonly contextTokens: number
		readonly outputTokens: number
		readonly contextWindow: number
	}): Promise<void>
	/**
	 * The response grew while it streams, before `record` settles it.
	 *
	 * `authoritativeContextTokens` is zero until the provider reports usage;
	 * `receivingTokens` is a local estimate until it reports output.
	 */
	receiving?(estimate: {
		readonly turnId: string
		readonly receivingTokens: number
		readonly authoritativeContextTokens: number
		readonly contextWindow: number
	}): void
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
export class TaskProviderRequestReporter implements ProviderRequestReport.ProviderRequestReportPort {
	/** The card a request that ran out of retries left behind, until a newer request supersedes it. */
	private failedCard?: RetryCard

	constructor(private readonly options: TaskProviderRequestReporterOptions) {}

	async begin(input: { readonly turnId: string }): Promise<ProviderRequestReport.ProviderRequestRecord> {
		// The card of an exhausted request reports a failure the user has now
		// acted on; keeping it beside the new request would stack two cards
		// for one unresolved failure.
		const superseded = this.failedCard
		this.failedCard = undefined
		await superseded?.withdraw()
		const ts = this.options.nextPresentationId()
		// The estimate the request was admitted on anchors its reported usage, so
		// the next round's growth is measured estimate-to-estimate.
		const opening = this.options.admittedRequest?.()
		const estimate = opening?.estimatedTokens
		await this.options.messages.addToClineMessages({
			ts,
			type: "say",
			say: "api_req_started",
			text: JSON.stringify({
				request: input.turnId,
				...(estimate === undefined ? {} : { estimatedContextTokens: estimate, contextTokensSource: "estimate" as const }),
			} satisfies UiApiReqInfo),
		})
		const { contextWindow } = ContextWindowManagement.getContextWindowInfo(this.options.api())
		await this.options.usage?.started({ turnId: input.turnId, contextWindow, ...(opening ? { opening } : {}) })
		const retryCard = new RetryCard(this.options.messages, this.options.nextPresentationId, this.options.retryView)
		const profileId = this.options.profileTokens?.activeProfileId()
		return {
			retrying: (notice) => retryCard.show(notice),
			recovered: () => retryCard.withdraw(),
			receiving: async (estimate) => {
				this.options.usage?.receiving?.({ turnId: input.turnId, contextWindow, ...estimate })
			},
			settle: async (settlement) => {
				// A request that failed after retrying keeps its card as the record of
				// the attempts; any other ending makes the countdown obsolete.
				if (settlement.outcome === "failed") {
					await retryCard.markFailed()
					this.failedCard = retryCard
				} else await retryCard.withdraw()
				await this.settle(ts, input.turnId, settlement, profileId)
			},
		}
	}

	private async settle(
		ts: number,
		turnId: string,
		settlement: {
			readonly usage?: Readonly<Record<string, number>>
			readonly outcome: ProviderRequestReport.ProviderRequestOutcome
		},
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
		this.recordUsageTelemetry(api, settlement, tokens)
		this.recordProfileTokens(profileId, tokens)
		const { contextWindow } = ContextWindowManagement.getContextWindowInfo(api)
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
		if (contextTokens > 0)
			await this.options.usage?.record({ turnId, contextTokens, outputTokens: tokens.outputTokens, contextWindow })
		else await this.options.usage?.unmeasured({ turnId })
	}

	/** Emits one usage event for the completed logical request, never once per retry or chunk. */
	private recordUsageTelemetry(
		api: ApiHandler,
		settlement: {
			readonly usage?: Readonly<Record<string, number>>
			readonly outcome: ProviderRequestReport.ProviderRequestOutcome
		},
		tokens: UsageTokens,
	): void {
		const usage = settlement.usage
		if (settlement.outcome !== "completed" || !usage) return
		try {
			const model = api.getModel()
			const thoughtsTokens = optionalNonNegative(usage.thoughtsTokenCount)
			const apiFormat = api.getSelectedApiFormat?.()
			const telemetry = this.options.usageTelemetry ?? providerUsageTelemetry
			telemetry.record({
				taskUlid: this.options.messages.taskUlid,
				inputTokens: tokens.inputTokens,
				outputTokens: tokens.outputTokens,
				cacheWriteTokens: tokens.cacheWriteTokens,
				cacheReadTokens: tokens.cacheReadTokens,
				cacheUsageReported: cacheUsageWasReported(usage),
				...(thoughtsTokens === undefined ? {} : { thoughtsTokens }),
				...(tokens.totalCost === undefined ? {} : { totalCost: tokens.totalCost }),
				provider: api.getProviderId?.() ?? "unknown",
				model: model.id,
				...(apiFormat === undefined ? {} : { apiFormat }),
			})
		} catch (error) {
			Logger.debug(`[provider] usage telemetry could not be recorded: ${String(error)}`)
		}
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
		settlement: {
			readonly usage?: Readonly<Record<string, number>>
			readonly outcome: ProviderRequestReport.ProviderRequestOutcome
		},
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
	private notice?: ProviderRequestReport.ProviderRetryNotice

	constructor(
		private readonly messages: MessageStateHandler,
		private readonly nextPresentationId: PresentationIdSequence,
		private readonly view?: RetryCardView,
	) {}

	async show(notice: ProviderRequestReport.ProviderRetryNotice): Promise<void> {
		// The replaced card needs no publication of its own: the chat hides a
		// card followed by a newer one, and the count it keeps reconciles the rest.
		await this.remove()
		const ts = this.nextPresentationId()
		const row: UiMessage = { ts, type: "say", say: "error_retry", text: cardText(notice) }
		await this.messages.addToClineMessages(row)
		this.ts = ts
		this.notice = notice
		await this.present(() => this.view?.publishState())
		await this.present(() => this.view?.showRow(this.storedRow(ts) ?? row))
	}

	async withdraw(): Promise<void> {
		if (await this.remove()) await this.present(() => this.view?.publishState())
	}

	/** The retries did not recover the request; the card stops counting down and says so. */
	async markFailed(): Promise<void> {
		const ts = this.ts
		const index = ts === undefined ? -1 : this.messages.clineMessages.findIndex((message) => message.ts === ts)
		if (ts === undefined || index < 0 || !this.notice) return
		await this.messages.updateClineMessage(index, { text: cardText(this.notice, true) })
		await this.messages.flushMessageUpdate(index)
		const row = this.storedRow(ts)
		if (row) await this.present(() => this.view?.showRow(row))
	}

	private async remove(): Promise<boolean> {
		const ts = this.ts
		this.ts = undefined
		this.notice = undefined
		if (ts === undefined) return false
		await this.messages.removeMessagesByTs([ts])
		return true
	}

	private storedRow(ts: number): UiMessage | undefined {
		return this.messages.clineMessages.find((message) => message.ts === ts)
	}

	/** A card the chat could not receive costs visibility only, never the request's settlement. */
	private async present(deliver: () => Promise<void> | undefined): Promise<void> {
		try {
			await deliver()
		} catch (error) {
			Logger.debug(`[provider] retry card could not reach the chat: ${String(error)}`)
		}
	}
}

/** The card payload the chat's retry box renders. */
function cardText(notice: ProviderRequestReport.ProviderRetryNotice, failed = false): string {
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
	return ContextWindowManagement.resolveCompactTriggerPolicy(
		contextWindow,
		ContextWindowManagement.computeSummarizeBudget(),
		settings,
	).compactTriggerTokens
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
function cancelReasonFor(outcome: ProviderRequestReport.ProviderRequestOutcome): UiApiReqCancelReason | undefined {
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

function optionalNonNegative(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined
}

function cacheUsageWasReported(usage: Readonly<Record<string, number>>): boolean {
	const marker = usage.cacheUsageReported
	if (typeof marker === "number" && Number.isFinite(marker)) return marker > 0
	return Object.hasOwn(usage, "cacheWriteTokens") || Object.hasOwn(usage, "cacheReadTokens")
}

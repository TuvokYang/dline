import { randomUUID } from "node:crypto"
import { providerFailureClassOf } from "@core/api/observability/provider-failure"
import { Logger } from "@shared/services/Logger"
import type {
    ProviderRequestRecord,
    ProviderRequestReportPort,
    ProviderRequestSettlement,
    ProviderRetryNotice,
} from "../executors/provider/service/ProviderRequestReport"
import { nonNegative, readSettledUsageTokens, usageWasReported } from "../executors/provider/service/ProviderUsageTokens"
import type { ChecklistChange } from "./ChecklistDiff"
import type { UsagePurpose, UsageServedModel, UsageSettlement, UsageSettlementPort } from "./UsageSettlement"
import type { UsageToolCall } from "./UsageToolCalls"

export interface UsageSettlementRequestReporterOptions {
    readonly settlement: UsageSettlementPort
    readonly purpose: UsagePurpose
    /** The provider and model of the handler about to serve the request, read when the request opens. */
    readonly servedBy?: () => UsageServedModel | undefined
    /**
     * The tool calls the turn settled, read when the request settles.
     *
     * Read late because tools run after the stream already ended: the request is
     * charged for what it consumed, and the calls belong to the same turn.
     */
    readonly toolCalls?: (turnId: string) => Promise<readonly UsageToolCall[] | undefined>
    /**
     * The checklist changes this settlement owns, taken once.
     *
     * Read alongside the settlement so a change cannot be counted twice, and
     * consumed even when no usage is recorded for the request it lands on.
     */
    readonly checklistChanges?: () => readonly ChecklistChange[] | undefined
    readonly clock?: () => number
    readonly newObservationId?: () => string
}

/** Add usage settlement to a request report when the assembly reports usage at all. */
export function settleUsageAround(
    report: ProviderRequestReportPort,
    options: UsageSettlementRequestReporterOptions | undefined,
): ProviderRequestReportPort {
    return options ? new UsageSettlementRequestReporter(report, options) : report
}

/**
 * Settles each provider request's usage into the usage port around any request report.
 *
 * The observation identity and serving model are fixed when the request opens,
 * so a profile switch during the stream cannot reattribute it. Settlement covers
 * every outcome, because cancelled and failed requests are charged too, and
 * counts every attempt a retried request consumed. Its timing covers only the
 * attempt that produced the result; earlier attempts are counted as retries.
 */
export class UsageSettlementRequestReporter implements ProviderRequestReportPort {
    private readonly clock: () => number
    private readonly newObservationId: () => string

    constructor(
        private readonly report: ProviderRequestReportPort,
        private readonly options: UsageSettlementRequestReporterOptions,
    ) {
        this.clock = options.clock ?? Date.now
        this.newObservationId = options.newObservationId ?? randomUUID
    }

    async begin(input: { readonly turnId: string }): Promise<ProviderRequestRecord> {
        const observed = new ObservedRequest(this.newObservationId(), this.options.purpose, this.options.servedBy?.(), this.clock)
        const settleUsage = async (settlement: ProviderRequestSettlement): Promise<void> => {
            const usage = observed.settle(settlement)
            if (!usage) return
            const toolCalls = await this.toolCallsOf(input.turnId)
            const checklistChanges = this.checklistChangesOf()
            this.record({
                ...usage,
                ...(toolCalls === undefined ? {} : { toolCalls }),
                ...(checklistChanges === undefined ? {} : { checklistChanges }),
            })
        }
        let record: ProviderRequestRecord
        try {
            record = await this.report.begin(input)
        } catch (error) {
            // The visible row could not open, but the request still runs and is still charged.
            Logger.debug(`[usage] request record unavailable, settling usage only: ${String(error)}`)
            return {
                retrying: async (notice) => observed.retrying(notice),
                settle: async (settlement) => await settleUsage(settlement),
            }
        }
        return {
            ...record,
            retrying: async (notice) => {
                observed.retrying(notice)
                await record.retrying?.(notice)
            },
            settle: async (settlement) => {
                await settleUsage(settlement)
                await record.settle(settlement)
            },
        }
    }

    /** Checklist changes belong to the request that settles next; reading them consumes them. */
    private checklistChangesOf(): readonly ChecklistChange[] | undefined {
        if (!this.options.checklistChanges) return undefined
        try {
            const changes = this.options.checklistChanges()
            return changes === undefined || changes.length === 0 ? undefined : changes
        } catch (error) {
            Logger.debug(`[usage] checklist changes could not be read: ${String(error)}`)
            return undefined
        }
    }

    /** Tool calls never fail the settlement they decorate; an unreadable read reports none. */
    private async toolCallsOf(turnId: string): Promise<readonly UsageToolCall[] | undefined> {
        if (!this.options.toolCalls) return undefined
        try {
            return await this.options.toolCalls(turnId)
        } catch (error) {
            Logger.debug(`[usage] tool calls could not be read: ${String(error)}`)
            return undefined
        }
    }

    private record(usage: UsageSettlement): void {
        try {
            this.options.settlement.record(usage)
        } catch (error) {
            Logger.debug(`[usage] request usage could not be settled: ${String(error)}`)
        }
    }
}

/** One open request as usage sees it: its identity, its serving model and the retries it waited through. */
class ObservedRequest {
    private readonly waitsMs: number[] = []
    /** When the attempt now running was sent, as far as the retry notices tell. */
    private attemptStartedAt: number
    private settled = false

    constructor(
        private readonly observationId: string,
        private readonly purpose: UsagePurpose,
        private readonly servedBy: UsageServedModel | undefined,
        private readonly clock: () => number,
    ) {
        this.attemptStartedAt = clock()
    }

    retrying(notice: ProviderRetryNotice): void {
        const waitMs = Math.max(0, Number.isFinite(notice.delayMs) ? notice.delayMs : 0)
        this.waitsMs.push(waitMs)
        this.attemptStartedAt = this.clock() + waitMs
    }

    /** The request's usage, the first time it settles; a repeated settlement is the same request. */
    settle(settlement: ProviderRequestSettlement): UsageSettlement | undefined {
        if (this.settled) return undefined
        this.settled = true
        const tokens = readSettledUsageTokens(settlement.usage)
        const reasoningTokens = usageWasReported(settlement.usage, "thoughtsUsageReported", "thoughtsTokenCount")
            ? nonNegative(settlement.usage?.thoughtsTokenCount)
            : undefined
        const timing = settlement.attemptTiming
        // Without the provider's own clock, the attempt is timed from when its retry was due.
        const durationMs = timing ? timing.durationMs : Math.max(0, this.clock() - this.attemptStartedAt)
        return {
            observationId: this.observationId,
            purpose: this.purpose,
            outcome: settlement.outcome,
            inputTokens: tokens.inputTokens,
            outputTokens: tokens.outputTokens,
            cacheReadTokens: tokens.cacheReadTokens,
            cacheWriteTokens: tokens.cacheWriteTokens,
            ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
            durationMs,
            ...(timing?.ttftMs !== undefined && timing.generationMs !== undefined
                ? { streamTiming: { ttftMs: timing.ttftMs, generationMs: timing.generationMs } }
                : {}),
            ...(this.waitsMs.length > 0 ? { retries: { waitsMs: [...this.waitsMs] } } : {}),
            ...(settlement.outcome === "failed" ? { failureClass: providerFailureClassOf(settlement.failure) } : {}),
            ...(this.servedBy ? { servedBy: this.servedBy } : {}),
        }
    }
}

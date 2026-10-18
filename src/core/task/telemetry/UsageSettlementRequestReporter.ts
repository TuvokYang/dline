import { randomUUID } from "node:crypto"
import type { ModelInfo } from "@shared/api"
import { Logger } from "@shared/services/Logger"
import type {
    ProviderRequestRecord,
    ProviderRequestReportPort,
    ProviderRequestSettlement,
} from "../executors/provider/service/ProviderRequestReport"
import { readSettledUsageTokens, settledCostMicroUsd } from "../executors/provider/service/ProviderUsageTokens"
import type { UsagePurpose, UsageSettlementPort } from "./UsageSettlement"

export interface UsageSettlementRequestReporterOptions {
    readonly settlement: UsageSettlementPort
    readonly purpose: UsagePurpose
    /** Pricing of the handler about to serve the request, read when the request opens. */
    readonly modelInfo: () => ModelInfo
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
 * The observation identity and pricing are fixed when the request opens, so a
 * profile switch during the stream cannot reprice it. Settlement covers every
 * outcome, because cancelled and failed requests are charged too, and counts
 * every attempt a retried request consumed.
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
        const observationId = this.newObservationId()
        const startedAt = this.clock()
        const modelInfo = this.options.modelInfo()
        let settled = false
        const settleUsage = (settlement: ProviderRequestSettlement): void => {
            if (settled) return
            settled = true
            this.recordUsage(observationId, startedAt, modelInfo, settlement)
        }
        let record: ProviderRequestRecord
        try {
            record = await this.report.begin(input)
        } catch (error) {
            // The visible row could not open, but the request still runs and is still charged.
            Logger.debug(`[usage] request record unavailable, settling usage only: ${String(error)}`)
            return { settle: async (settlement) => settleUsage(settlement) }
        }
        return {
            ...record,
            settle: async (settlement) => {
                settleUsage(settlement)
                await record.settle(settlement)
            },
        }
    }

    private recordUsage(
        observationId: string,
        startedAt: number,
        modelInfo: ModelInfo,
        settlement: ProviderRequestSettlement,
    ): void {
        try {
            const tokens = readSettledUsageTokens(settlement.usage)
            const costMicroUsd = settlement.usage ? settledCostMicroUsd(tokens, modelInfo) : undefined
            this.options.settlement.record({
                observationId,
                purpose: this.options.purpose,
                outcome: settlement.outcome,
                inputTokens: tokens.inputTokens,
                outputTokens: tokens.outputTokens,
                cacheReadTokens: tokens.cacheReadTokens,
                cacheWriteTokens: tokens.cacheWriteTokens,
                ...(costMicroUsd === undefined ? {} : { costMicroUsd }),
                durationMs: Math.max(0, this.clock() - startedAt),
            })
        } catch (error) {
            Logger.debug(`[usage] request usage could not be settled: ${String(error)}`)
        }
    }
}

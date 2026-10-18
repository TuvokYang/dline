import { randomUUID } from "node:crypto"
import type { CompactionAttemptDiagnostics } from "@core/context/context-management/compaction-attempt-diagnostics"
import type { ModelInfo } from "@shared/api"
import { Logger } from "@shared/services/Logger"
import { settledCostMicroUsd } from "../executors/provider/service/ProviderUsageTokens"
import type { ApiRequestRoundUsage } from "../performance/api-request-round-types"
import type { ProviderRequestRoundAdmission, ProviderRequestRoundPort } from "../performance/provider-request-round-port"
import type { UsageOutcome, UsageSettlement, UsageSettlementPort } from "./UsageSettlement"

const MICRO_UNITS_PER_DOLLAR = 1_000_000

/**
 * The usage one compaction Provider attempt consumed.
 *
 * Compaction reports per attempt, priced here from the handler that served the
 * Pass because its stream reports no cost. The authorization attempt identifies
 * the observation, so a diagnostic delivered twice settles once.
 */
export function compactionAttemptSettlement(
    diagnostics: CompactionAttemptDiagnostics,
    modelInfo: ModelInfo,
    newObservationId: () => string = randomUUID,
): UsageSettlement {
    const usage = diagnostics.usage
    const tokens = {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
        cacheReadTokens: usage?.cacheReadTokens ?? 0,
    }
    const costMicroUsd = usage ? settledCostMicroUsd(tokens, modelInfo) : undefined
    return {
        observationId: diagnostics.authorizationAttemptId || newObservationId(),
        purpose: "compaction",
        outcome: diagnostics.outcome === "accepted" ? "completed" : "failed",
        ...tokens,
        ...(costMicroUsd === undefined ? {} : { costMicroUsd }),
        durationMs: Math.max(0, Math.round(diagnostics.providerTtfbMs + diagnostics.streamMs)),
    }
}

/** Record without letting a telemetry fault reach the request it describes. */
export function recordUsageSafely(port: UsageSettlementPort | undefined, settlement: () => UsageSettlement): void {
    if (!port) return
    try {
        port.record(settlement())
    } catch (error) {
        Logger.debug(`[usage] nested request usage could not be settled: ${String(error)}`)
    }
}

export interface SubagentUsageOptions {
    readonly clock?: () => number
    readonly newObservationId?: () => string
}

/**
 * Settle the usage of every subagent Provider round through the usage port.
 *
 * Subagents admit each round through the task's round port and attach the
 * round's exact, already priced usage there, so wrapping the port is the one
 * seam that sees every subagent request without the runner knowing about
 * telemetry. Other sources pass through untouched: ordinary requests settle
 * through the request report, and compaction through its attempt diagnostics.
 */
export function settleSubagentRoundUsage(
    rounds: ProviderRequestRoundPort | undefined,
    port: UsageSettlementPort | undefined,
    options: SubagentUsageOptions = {},
): ProviderRequestRoundPort | undefined {
    if (!rounds || !port) return rounds
    return {
        admit: (input) =>
            input.source === "subagent" ? new SubagentRoundUsage(rounds.admit(input), port, options) : rounds.admit(input),
    }
}

class SubagentRoundUsage implements ProviderRequestRoundAdmission {
    private readonly clock: () => number
    private readonly newObservationId: () => string
    private attemptStartedAt: number
    private attemptOutcome: UsageOutcome = "completed"

    constructor(
        private readonly inner: ProviderRequestRoundAdmission,
        private readonly port: UsageSettlementPort,
        options: SubagentUsageOptions,
    ) {
        this.clock = options.clock ?? Date.now
        this.newObservationId = options.newObservationId ?? randomUUID
        this.attemptStartedAt = this.clock()
    }

    bindAttempt<T>(stream: AsyncIterable<T>, taskAttempt: number): AsyncIterable<T> {
        this.attemptStartedAt = this.clock()
        this.attemptOutcome = "completed"
        return observeOutcome(this.inner.bindAttempt(stream, taskAttempt), (outcome) => {
            this.attemptOutcome = outcome
        })
    }

    attachExactUsage(usage: ApiRequestRoundUsage): void {
        this.inner.attachExactUsage(usage)
        recordUsageSafely(this.port, () => {
            const costMicroUsd = dollarCost(usage)
            return {
                observationId: this.newObservationId(),
                purpose: "subagent",
                outcome: this.attemptOutcome,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheReadTokens: usage.cacheReadTokens ?? 0,
                cacheWriteTokens: usage.cacheWriteTokens ?? 0,
                ...(costMicroUsd === undefined ? {} : { costMicroUsd }),
                durationMs: Math.max(0, this.clock() - this.attemptStartedAt),
            }
        })
    }

    completeProviderOnly(): void {
        this.inner.completeProviderOnly()
    }

    completeTools(...args: Parameters<ProviderRequestRoundAdmission["completeTools"]>): void {
        this.inner.completeTools(...args)
    }

    completeTurnEndAwaitingUser(...args: Parameters<ProviderRequestRoundAdmission["completeTurnEndAwaitingUser"]>): void {
        this.inner.completeTurnEndAwaitingUser(...args)
    }
}

/** A subagent round is priced before it is attached; only a dollar price can be counted. */
function dollarCost(usage: ApiRequestRoundUsage): number | undefined {
    if (usage.totalCost === undefined || !Number.isFinite(usage.totalCost) || usage.totalCost < 0) return undefined
    if (usage.currency && usage.currency.toUpperCase() !== "USD") return undefined
    return Math.round(usage.totalCost * MICRO_UNITS_PER_DOLLAR)
}

/** Forward a stream unchanged while noting whether it ended, failed or was aborted. */
function observeOutcome<T>(stream: AsyncIterable<T>, settle: (outcome: UsageOutcome) => void): AsyncIterable<T> {
    return {
        [Symbol.asyncIterator]: () => {
            const iterator = stream[Symbol.asyncIterator]()
            const fail = (error: unknown): never => {
                settle(isAbort(error) ? "cancelled" : "failed")
                throw error
            }
            return {
                next: async (...args: [] | [unknown]) => {
                    try {
                        return await iterator.next(...args)
                    } catch (error) {
                        return fail(error)
                    }
                },
                return: async (value?: unknown) =>
                    iterator.return ? iterator.return(value) : ({ done: true, value } as IteratorReturnResult<T>),
                throw: async (error?: unknown) => {
                    if (!iterator.throw) return fail(error)
                    try {
                        return await iterator.throw(error)
                    } catch (thrown) {
                        return fail(thrown)
                    }
                },
            }
        },
    }
}

function isAbort(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError"
}

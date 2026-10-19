import { randomUUID } from "node:crypto"
import { providerFailureClassOf } from "@core/api/observability/provider-failure"
import type { CompactionAttemptDiagnostics } from "@core/context/context-management/compaction-attempt-diagnostics"
import { Logger } from "@shared/services/Logger"
import type { ApiRequestRoundUsage } from "../performance/api-request-round-types"
import type { ProviderRequestRoundAdmission, ProviderRequestRoundPort } from "../performance/provider-request-round-port"
import type { UsageOutcome, UsageServedModel, UsageSettlement, UsageSettlementPort } from "./UsageSettlement"

/**
 * The usage one compaction Provider attempt consumed.
 *
 * Compaction reports per attempt, attributed to the handler that served the
 * Pass. The authorization attempt identifies the observation, so a diagnostic
 * delivered twice settles once.
 */
export function compactionAttemptSettlement(
    diagnostics: CompactionAttemptDiagnostics,
    servedBy: UsageServedModel | undefined,
    newObservationId: () => string = randomUUID,
): UsageSettlement {
    const usage = diagnostics.usage
    const accepted = diagnostics.outcome === "accepted"
    const ttftMs = Math.max(0, Math.round(diagnostics.providerTtfbMs))
    const generationMs = Math.max(0, Math.round(diagnostics.streamMs))
    return {
        observationId: diagnostics.authorizationAttemptId || newObservationId(),
        purpose: "compaction",
        outcome: accepted ? "completed" : "failed",
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
        cacheReadTokens: usage?.cacheReadTokens ?? 0,
        durationMs: ttftMs + generationMs,
        // Only a stream that ran to its end has a generation time worth comparing.
        ...(accepted ? { streamTiming: { ttftMs, generationMs } } : { failureClass: "other" as const }),
        ...(servedBy ? { servedBy } : {}),
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
            input.source === "subagent"
                ? new SubagentRoundUsage(rounds.admit(input), port, options, input.servedBy)
                : rounds.admit(input),
    }
}

/**
 * One subagent round as usage sees it.
 *
 * The round is one request: an attempt that failed and was sent again counts as
 * a retry of it, waiting from the failure to the resend, and its timing covers
 * only the attempt whose usage settles it.
 */
class SubagentRoundUsage implements ProviderRequestRoundAdmission {
    private readonly clock: () => number
    private readonly newObservationId: () => string
    private attemptStartedAt: number
    private firstChunkAt: number | undefined
    private endedAt: number | undefined
    private attemptOutcome: UsageOutcome = "completed"
    private attemptFailure: unknown
    /** When the last attempt failed, until the next one is sent or the round settles. */
    private failedAt: number | undefined
    private waitsMs: number[] = []

    constructor(
        private readonly inner: ProviderRequestRoundAdmission,
        private readonly port: UsageSettlementPort,
        options: SubagentUsageOptions,
        private readonly servedBy: UsageServedModel | undefined,
    ) {
        this.clock = options.clock ?? Date.now
        this.newObservationId = options.newObservationId ?? randomUUID
        this.attemptStartedAt = this.clock()
    }

    bindAttempt<T>(stream: AsyncIterable<T>, taskAttempt: number): AsyncIterable<T> {
        const now = this.clock()
        if (this.failedAt !== undefined) this.waitsMs.push(Math.max(0, now - this.failedAt))
        this.failedAt = undefined
        this.attemptStartedAt = now
        this.firstChunkAt = undefined
        this.endedAt = undefined
        this.attemptOutcome = "completed"
        this.attemptFailure = undefined
        return observeAttempt(this.inner.bindAttempt(stream, taskAttempt), {
            chunk: () => {
                this.firstChunkAt ??= this.clock()
            },
            end: () => {
                this.endedAt = this.clock()
            },
            fail: (outcome, error) => {
                this.attemptOutcome = outcome
                this.attemptFailure = error
                this.failedAt = this.clock()
            },
        })
    }

    attachExactUsage(usage: ApiRequestRoundUsage): void {
        this.inner.attachExactUsage(usage)
        recordUsageSafely(this.port, () => this.settlementOf(usage))
        this.waitsMs = []
        this.failedAt = undefined
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

    private settlementOf(usage: ApiRequestRoundUsage): UsageSettlement {
        const endedAt = this.endedAt ?? this.clock()
        const firstChunkAt = this.firstChunkAt
        const streamed = this.attemptOutcome === "completed" && firstChunkAt !== undefined && this.endedAt !== undefined
        return {
            observationId: this.newObservationId(),
            purpose: "subagent",
            outcome: this.attemptOutcome,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens ?? 0,
            cacheWriteTokens: usage.cacheWriteTokens ?? 0,
            ...(usage.thoughtsTokens === undefined ? {} : { reasoningTokens: usage.thoughtsTokens }),
            durationMs: Math.max(0, endedAt - this.attemptStartedAt),
            ...(streamed
                ? {
                      streamTiming: {
                          ttftMs: Math.max(0, firstChunkAt - this.attemptStartedAt),
                          generationMs: Math.max(0, endedAt - firstChunkAt),
                      },
                  }
                : {}),
            ...(this.waitsMs.length > 0 ? { retries: { waitsMs: [...this.waitsMs] } } : {}),
            ...(this.attemptOutcome === "failed" ? { failureClass: providerFailureClassOf(this.attemptFailure) } : {}),
            ...(this.servedBy ? { servedBy: this.servedBy } : {}),
        }
    }
}

interface AttemptObserver {
    /** A chunk arrived. */
    chunk(): void
    /** The stream ended on its own. */
    end(): void
    /** The stream failed or was aborted. */
    fail(outcome: Exclude<UsageOutcome, "completed">, error: unknown): void
}

/** Forward a stream unchanged while noting when it first answered and how it ended. */
function observeAttempt<T>(stream: AsyncIterable<T>, observer: AttemptObserver): AsyncIterable<T> {
    return {
        [Symbol.asyncIterator]: () => {
            const iterator = stream[Symbol.asyncIterator]()
            const fail = (error: unknown): never => {
                observer.fail(isAbort(error) ? "cancelled" : "failed", error)
                throw error
            }
            const seen = (result: IteratorResult<T>): IteratorResult<T> => {
                if (result.done) observer.end()
                else observer.chunk()
                return result
            }
            return {
                next: async (...args: [] | [unknown]) => {
                    try {
                        return seen(await iterator.next(...args))
                    } catch (error) {
                        return fail(error)
                    }
                },
                return: async (value?: unknown) =>
                    iterator.return ? iterator.return(value) : ({ done: true, value } as IteratorReturnResult<T>),
                throw: async (error?: unknown) => {
                    if (!iterator.throw) return fail(error)
                    try {
                        return seen(await iterator.throw(error))
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

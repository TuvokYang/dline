import type { CompactionPassIdentity } from "./target-window-fitting"

export type CompactionRetryDecision =
    | { action: "retry"; retryAttempt: number; maxRetryAttempts: number }
    | { action: "exhausted"; retryAttempt: number; maxRetryAttempts: number }

/** Owns retry accounting for exactly one immutable fitting Pass at a time. */
export class CompactionRetryPolicy {
    private passKey?: string
    private retryAttempts = 0

    constructor(private readonly maxRetryAttempts: number) {
        if (!Number.isInteger(maxRetryAttempts) || maxRetryAttempts < 0) {
            throw new Error("Compaction max retry attempts must be a non-negative integer")
        }
    }

    registerFailure(passIdentity: CompactionPassIdentity): CompactionRetryDecision {
        const passKey = serializePassIdentity(passIdentity)
        if (this.passKey !== passKey) {
            this.passKey = passKey
            this.retryAttempts = 0
        }
        if (this.retryAttempts >= this.maxRetryAttempts) {
            return {
                action: "exhausted",
                retryAttempt: this.retryAttempts,
                maxRetryAttempts: this.maxRetryAttempts,
            }
        }
        this.retryAttempts++
        return {
            action: "retry",
            retryAttempt: this.retryAttempts,
            maxRetryAttempts: this.maxRetryAttempts,
        }
    }

    reset(): void {
        this.passKey = undefined
        this.retryAttempts = 0
    }
}

function serializePassIdentity(identity: CompactionPassIdentity): string {
    return JSON.stringify([
        identity.operationId,
        identity.passIndex,
        identity.passStartTurnIndex,
        identity.passEndTurnIndex,
        identity.coveredTurnCount,
        identity.summaryBaselineHash,
        identity.sourceHistoryHash,
        identity.passStartMessageIndex,
        identity.passEndMessageIndex,
        identity.rangeHash,
        identity.passHistoryHash,
    ])
}

import { describe, expect, it } from "vitest"
import { CompactionRetryPolicy } from "../compaction-retry-policy"

const firstPass = {
    operationId: "operation-rolling",
    passIndex: 0,
    passStartTurnIndex: 0,
    passEndTurnIndex: 0,
    coveredTurnCount: 0,
    summaryBaselineHash: "sha256:empty",
}

const secondPass = {
    ...firstPass,
    passIndex: 1,
    passStartTurnIndex: 1,
    passEndTurnIndex: 1,
    coveredTurnCount: 1,
    summaryBaselineHash: "sha256:summary-one",
}

describe("CompactionRetryPolicy", () => {
    it("owns retry accounting per immutable Pass without sharing Task auto-retry state", () => {
        const policy = new CompactionRetryPolicy(3)

        expect(policy.registerFailure(firstPass)).toEqual({ action: "retry", retryAttempt: 1, maxRetryAttempts: 3 })
        expect(policy.registerFailure(firstPass)).toEqual({ action: "retry", retryAttempt: 2, maxRetryAttempts: 3 })
        expect(policy.registerFailure(firstPass)).toEqual({ action: "retry", retryAttempt: 3, maxRetryAttempts: 3 })
        expect(policy.registerFailure(firstPass)).toEqual({ action: "exhausted", retryAttempt: 3, maxRetryAttempts: 3 })

        expect(policy.registerFailure(secondPass)).toEqual({ action: "retry", retryAttempt: 1, maxRetryAttempts: 3 })
    })
})

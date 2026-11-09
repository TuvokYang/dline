import type { ProviderAttemptObserver } from "@shared/provider-attempt-observer"
import { describe, expect, it } from "vitest"
import type { ApiRequestRoundHandle } from "./api-request-round-tracker"
import type { ServingMetricsIdentity } from "./TaskPerformanceOwner"
import { TaskProviderRequestRoundOwner, type TaskProviderRequestRoundOwnerOptions } from "./TaskProviderRequestRoundOwner"

/**
 * A lifecycle that hands out distinguishable terminals and records nothing.
 *
 * Each attempt gets a unique round id so a test can tell which admission a lookup
 * resolved, which is exactly what a shared api index would get wrong.
 */
function stubLifecycle(): {
    lifecycle: TaskProviderRequestRoundOwnerOptions["lifecycle"]
    issued: ApiRequestRoundHandle[]
} {
    const issued: ApiRequestRoundHandle[] = []
    let counter = 0
    const lifecycle = {
        createObserver: (input: { logicalRequestId: string }) => {
            const handle = { roundId: `${input.logicalRequestId}:${++counter}` } as ApiRequestRoundHandle
            issued.push(handle)
            const observer: ProviderAttemptObserver<ApiRequestRoundHandle> = {
                beginAttempt: () => handle,
                finishAttempt: async () => undefined,
            }
            return observer
        },
        attachExactUsage: () => undefined,
        finalizeTokens: () => undefined,
        expectTools: () => undefined,
        completeProviderOnly: () => undefined,
        completeTools: () => undefined,
        completeTurnEndAwaitingUser: () => undefined,
    } as unknown as TaskProviderRequestRoundOwnerOptions["lifecycle"]
    return { lifecycle, issued }
}

function ownerOptions(readServingIdentity: () => ServingMetricsIdentity | undefined) {
    const { lifecycle, issued } = stubLifecycle()
    return {
        issued,
        options: {
            lifecycle,
            readExecutionBlocks: () => [],
            isExecutionCancelling: () => false,
            resolveExecutionToolCalls: async () => [],
            readServingIdentity,
        },
    }
}

describe("TaskProviderRequestRoundOwner identity", () => {
    // Ordinary rounds and auxiliary sends allocate their api indexes from separate
    // counters that both start at zero, so an index is not a globally unique key.
    it("keeps an ordinary send and an auxiliary send apart even though both use index zero", async () => {
        let serving: ServingMetricsIdentity = { profileId: "ordinary-profile" }
        const { options, issued } = ownerOptions(() => serving)
        const owner = new TaskProviderRequestRoundOwner(options)

        const ordinary = owner.admitOrdinary(0, 0)
        const ordinaryAttempt = ordinary.createAttemptObserver(0)
        ordinaryAttempt.beginAttempt(undefined as never)
        await ordinaryAttempt.finishAttempt(issued[0], "completed", undefined)

        serving = { profileId: "auxiliary-profile" }
        const auxiliary = owner.admit({ source: "subagent" })
        const auxiliaryAttempt = auxiliary.createAttemptObserver(0)
        auxiliaryAttempt.beginAttempt(undefined as never)
        await auxiliaryAttempt.finishAttempt(issued[1], "completed", undefined)

        // The later admission must not have replaced the earlier send's facts.
        expect(owner.servingIdentityOf(0)?.profileId).toBe("ordinary-profile")
        expect(owner.servingIdentityOfAdmission(auxiliary)?.profileId).toBe("auxiliary-profile")
        expect(owner.settledRound(0)).toBe(issued[0])
        expect(owner.settledAuxiliaryRound(auxiliary)).toBe(issued[1])
    })

    // The execution settles at the tool or turn boundary, after the provider stream,
    // so the frozen identity must still be readable when that fact is emitted.
    it("keeps the serving identity readable by execution after the round is emitted", async () => {
        const { options, issued } = ownerOptions(() => ({ profileId: "serving-profile" }))
        const owner = new TaskProviderRequestRoundOwner(options)
        const attempt = owner.admitOrdinary(0, 0).createAttemptObserver(0)
        attempt.beginAttempt(undefined as never)
        await attempt.finishAttempt(issued[0], "completed", undefined)

        expect(owner.servingIdentityOfExecution({ roundId: issued[0].roundId })?.profileId).toBe("serving-profile")
        expect(owner.servingIdentityOf(0)?.profileId).toBe("serving-profile")
    })

    it("forgets a round's identity so a long task does not retain every send", () => {
        const { options } = ownerOptions(() => ({ profileId: "serving-profile" }))
        const owner = new TaskProviderRequestRoundOwner(options)
        owner.admitOrdinary(3, 0)

        owner.forgetServingIdentity(3)
        expect(owner.servingIdentityOf(3)).toBeUndefined()
    })
})

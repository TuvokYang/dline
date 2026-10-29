import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ApiHandler } from "@/core/api/ApiHandler"
import { instrumentApiHandler } from "@/core/api/observability/instrument-api-handler"
import type { ApiProviderStreamChunk, ApiStream } from "@/core/api/transform/stream"
import type {
    PendingUsageAttemptObservation,
    PendingUsageLogicalClaim,
} from "@/core/storage/telemetry-remote/UsageObservationSpool"
import { AttemptFinalizer } from "@/services/telemetry/remote/usage/AttemptFinalizer"
import { ModelInfo } from "@/shared/proto/dline/models"
import { ApiProfile } from "@/shared/proto/dline/profile"
import { installTaskUsageAccountingSink } from "../observability/task-usage-accounting"
import { createUntaskedMessage } from "./UntaskedProviderRequest"

const POLICY_GENERATION = 3

const USAGE: ApiProviderStreamChunk = { type: "usage", inputTokens: 40, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 }

/** The real finalizer behind the process sink, with an in-memory spool and a manually fired deadline clock. */
function usageHarness() {
    const observations: PendingUsageAttemptObservation[] = []
    const claims: PendingUsageLogicalClaim[] = []
    const deadlines = new Map<string, () => void>()
    const finalizer = new AttemptFinalizer({
        store: {
            save: async () => undefined,
            readOverdue: async () => [],
            removeRecovered: async () => undefined,
            purge: async () => undefined,
        },
        sink: {
            appendObservation: async (observation) => {
                observations.push(observation)
            },
            appendLogicalClaim: async (claim) => {
                claims.push(claim)
            },
        },
        localSessionId: "untasked-session",
        clock: {
            schedule: (observationId, _deadline, finalize) => deadlines.set(observationId, finalize),
            cancel: (observationId) => deadlines.delete(observationId),
        },
        persistDelayMs: 60_000,
    })
    const fireDeadlines = () => {
        for (const finalize of [...deadlines.values()]) finalize()
    }
    return { observations, claims, finalizer, fireDeadlines }
}

describe("UntaskedProviderRequest", () => {
    let usage: ReturnType<typeof usageHarness>
    let releaseAccounting: () => void

    beforeEach(() => {
        usage = usageHarness()
        releaseAccounting = installTaskUsageAccountingSink({
            currentPolicyGeneration: () => POLICY_GENERATION,
            recordAttemptEvent: (event) => usage.finalizer.record(event),
        })
    })

    afterEach(async () => {
        releaseAccounting()
        await usage.finalizer.purge()
    })

    it("reports a completed send that belongs to no Task as one final `other` observation and claims its execution", async () => {
        const api = instrumentedApi([{ type: "text", text: "feat: add x" }, USAGE], { customModel: true })

        const text: string[] = []
        for await (const chunk of createUntaskedMessage(api, "system", [{ role: "user", content: "diff" }])) {
            if (chunk.type === "text") text.push(chunk.text)
        }

        expect(text).toEqual(["feat: add x"])
        // Final at stream close, without waiting for any deadline.
        expect(usage.observations).toHaveLength(1)
        const [observation] = usage.observations
        expect(observation?.observation).toMatchObject({
            identity: { role: "other", provider: "openai", modelId: "custom:team-tuned_model", thinking: "state:default" },
            policyGeneration: POLICY_GENERATION,
            outcome: "completed",
            tokens: { input: 40, output: 8 },
            tokenUsageReported: true,
        })
        expect(observation?.observation.logicalExecution).toBeUndefined()
        // The logical execution settled after the Provider fact was final, so it arrives as its own claim.
        expect(usage.claims).toEqual([
            expect.objectContaining({
                logicalRequestId: observation?.observation.logicalRequestId,
                attemptObservationId: observation?.id,
                execution: expect.objectContaining({ logicalRequests: { completed: 1, failed: 0, cancelled: 0, aborted: 0 } }),
            }),
        ])
    })

    it("finalizes a send the consumer stopped early at its deadline, with tokens unreported", async () => {
        const api = instrumentedApi([{ type: "text", text: "partial" }, { type: "text", text: "never read" }, USAGE], {
            customModel: false,
        })

        for await (const chunk of createUntaskedMessage(api, "system", [{ role: "user", content: "diff" }])) {
            if (chunk.type === "text") break
        }
        expect(usage.observations).toHaveLength(0)

        usage.fireDeadlines()

        expect(usage.observations).toHaveLength(1)
        expect(usage.observations[0]?.observation).toMatchObject({
            identity: { role: "other", modelId: "catalog:team-tuned_model" },
            outcome: "cancelled",
            tokenUsageReported: false,
        })
    })

    it("keeps separate untasked requests apart instead of merging their attempts", async () => {
        const api = instrumentedApi([USAGE], { customModel: false })

        for (let request = 0; request < 2; request++) {
            for await (const _chunk of createUntaskedMessage(api, "system", [{ role: "user", content: "diff" }])) {
                // Drain the response.
            }
        }

        expect(usage.observations).toHaveLength(2)
        expect(new Set(usage.observations.map((pending) => pending.observation.logicalRequestId)).size).toBe(2)
    })
})

function instrumentedApi(chunks: readonly ApiProviderStreamChunk[], selection: { readonly customModel: boolean }): ApiHandler {
    const raw = {
        createMessage: async function* (): ApiStream {
            const providerStream = await ApiHandler.observeProviderStream(
                { provider: "openai", modelId: "Team-Tuned Model", thinking: "state:default" },
                async () =>
                    (async function* () {
                        yield* chunks
                    })(),
            )
            yield* providerStream
        },
        getModel: () => ({ id: "Team-Tuned Model", info: ModelInfo.create({ id: "Team-Tuned Model" }) }),
        getProviderId: () => "openai",
        isCustomModel: () => selection.customModel,
    } as ApiHandler
    return instrumentApiHandler(raw, {
        profile: ApiProfile.create({ provider: "openai" }),
        mode: "act",
        ulid: "untasked-test-handler",
        requestTimeoutMs: 5_000,
    })
}

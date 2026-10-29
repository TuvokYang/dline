import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { ApiHandler, type ApiRequestOptions } from "@/core/api/ApiHandler"
import { instrumentApiHandler } from "@/core/api/observability/instrument-api-handler"
import type { ApiStream } from "@/core/api/transform/stream"
import type { PendingUsageAttemptObservation } from "@/core/storage/telemetry-remote/UsageObservationSpool"
import { createRunningTaskState } from "@/core/task/kernel/__fixtures__/task-state"
import { TaskTurnTelemetry } from "@/core/task/observability/task-turn-telemetry"
import { installTaskUsageAccountingSink } from "@/core/task/observability/task-usage-accounting"
import { TaskPerformanceOwner } from "@/core/task/performance/TaskPerformanceOwner"
import { ModelInfo } from "@/shared/proto/dline/models"
import { ApiProfile } from "@/shared/proto/dline/profile"
import { buildUsageBody } from "../contracts/usageBody"
import { USAGE_HARD_LIMITS, validateUsageBodySchema } from "../contracts/usageBodySchema"
import { AttemptFinalizer } from "../usage/AttemptFinalizer"
import {
    type AttemptBucketState,
    appendAttemptToBuckets,
    emptyAttemptBucketState,
    sealOpenAttemptBucket,
} from "../usage/attemptBucket"

const TASK_ID = "usage-role-task"
const POLICY_GENERATION = 7

describe("schema 4 runtime role pipeline", () => {
    it("preserves subagent and compaction roles from instrumented Provider sends to the request body", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-usage-role-"))
        const finalized: PendingUsageAttemptObservation[] = []
        const finalizer = new AttemptFinalizer({
            store: {
                save: async () => undefined,
                readOverdue: async () => [],
                removeRecovered: async () => undefined,
                purge: async () => undefined,
            },
            sink: {
                appendObservation: async (observation) => {
                    finalized.push(observation)
                },
                appendLogicalClaim: async () => undefined,
            },
            localSessionId: "role-pipeline-session",
            persistDelayMs: 60_000,
        })
        const releaseAccounting = installTaskUsageAccountingSink({
            currentPolicyGeneration: () => POLICY_GENERATION,
            recordAttemptEvent: (event) => finalizer.record(event),
        })
        const state = createRunningTaskState({ taskId: TASK_ID, turnId: "turn-a", revision: 1 })
        let performance: TaskPerformanceOwner | undefined
        const telemetry = new TaskTurnTelemetry(
            TASK_ID,
            () => state,
            () => performance?.getSnapshot() ?? { cacheUsageAvailable: false },
            (input) => performance?.providerAttemptObserver(input),
            (committed) => performance?.committed(committed),
            (input) => performance?.providerAttemptUsage(input),
            (input) => performance?.providerRequestCompleted(input),
        )

        try {
            performance = await TaskPerformanceOwner.open({
                taskId: TASK_ID,
                readState: () => state,
                legacyMessages: () => [],
                attemptUsage: telemetry,
                readUsagePolicyGeneration: () => telemetry.usagePolicyGeneration(),
                location: path.join(root, "metrics.db"),
            })
            const api = instrumentedProviderApi()

            await drain(api.createMessage("", [], undefined, roleOptions("subagent", "subagent:request-1")))
            await drain(api.createMessage("", [], undefined, roleOptions("compaction", "compaction:request-1")))
            const rateLimited = Object.assign(new Error("upstream refused"), { status: 429 })
            await expect(
                drain(
                    instrumentedProviderApi(rateLimited).createMessage(
                        "",
                        [],
                        undefined,
                        roleOptions("subagent", "subagent:request-2"),
                    ),
                ),
            ).rejects.toThrow("upstream refused")
            // A failed send carries no usage; closing the window finalizes it like a host shutdown would.
            await finalizer.dispose()

            let buckets: AttemptBucketState = emptyAttemptBucketState()
            for (const pending of finalized) {
                buckets = appendAttemptToBuckets(buckets, pending.observation, {
                    newBucketId: () => "role-bucket",
                    sealedAt: () => Date.now(),
                })
            }
            const sealed = sealOpenAttemptBucket(buckets, Date.now())
            const client = { version: "0.11.1" }
            const body = buildUsageBody(sealed.sealed, client)

            expect(validateUsageBodySchema(body, { limits: USAGE_HARD_LIMITS, clientVersion: client.version })).toEqual([])
            const facts = body.buckets.flatMap((bucket) => bucket.facts)
            expect(facts.map((fact) => fact.role)).toEqual(["compaction", "subagent"])
            const subagent = facts.find((fact) => fact.role === "subagent")
            expect(subagent?.requests).toEqual({ completed: 1, failed: 1, cancelled: 0, aborted: 0 })
            // The HTTP status of the thrown error reaches the wire only as its failure class.
            expect(subagent?.errors).toEqual({ rate_limited: 1 })
        } finally {
            await performance?.release()
            telemetry.dispose()
            releaseAccounting()
            await finalizer.purge()
            await fs.rm(root, { recursive: true, force: true })
        }
    })
})

function roleOptions(role: "subagent" | "compaction", requestId: string): ApiRequestOptions {
    return {
        taskNamespace: TASK_ID,
        retryOwner: role,
        telemetryRole: role,
        telemetryRequestId: requestId,
        telemetryAttempt: 0,
    }
}

function instrumentedProviderApi(failure?: Error): ApiHandler {
    const raw = {
        createMessage: async function* (): ApiStream {
            const providerStream = await ApiHandler.observeProviderStream(
                { provider: "openai", modelId: "test-model", thinking: "state:off" },
                async () =>
                    (async function* () {
                        if (failure) throw failure
                        yield {
                            type: "usage" as const,
                            inputTokens: 10,
                            outputTokens: 2,
                            cacheReadTokens: 0,
                            cacheWriteTokens: 0,
                        }
                    })(),
            )
            for await (const chunk of providerStream) yield chunk
        },
        getModel: () => ({ id: "test-model", info: ModelInfo.create({ id: "test-model" }) }),
        getProviderId: () => "openai",
    } as ApiHandler
    return instrumentApiHandler(raw, {
        profile: ApiProfile.create({ provider: "openai" }),
        mode: "act",
        ulid: TASK_ID,
        requestTimeoutMs: 5_000,
    })
}

async function drain(stream: ApiStream): Promise<void> {
    for await (const _chunk of stream) {
        // Consume the full instrumented stream so the Provider and logical request terminals both run.
    }
}

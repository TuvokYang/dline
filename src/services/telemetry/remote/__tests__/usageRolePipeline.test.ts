import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { ApiHandler, type ApiRequestOptions } from "@/core/api/ApiHandler"
import { instrumentApiHandler } from "@/core/api/observability/instrument-api-handler"
import type { ApiStream } from "@/core/api/transform/stream"
import { createRunningTaskState } from "@/core/task/kernel/__fixtures__/task-state"
import { TaskTurnTelemetry } from "@/core/task/observability/task-turn-telemetry"
import { installTaskUsageAccountingSink } from "@/core/task/observability/task-usage-accounting"
import type { FinalizedProviderAttempt } from "@/core/task/performance/provider-request-round-port"
import { TaskPerformanceOwner } from "@/core/task/performance/TaskPerformanceOwner"
import { ModelInfo } from "@/shared/proto/dline/models"
import { ApiProfile } from "@/shared/proto/dline/profile"
import { buildUsageAttemptBody } from "../contracts/usageBody"
import {
    type AttemptBucketState,
    appendAttemptToBuckets,
    emptyAttemptBucketState,
    sealOpenAttemptBucket,
} from "../usage/attemptBucket"
import { projectFinalizedAttempt } from "../usage/attemptProjection"

const TASK_ID = "usage-role-task"
const POLICY_GENERATION = 7

describe("schema 4 runtime role pipeline", () => {
    it("preserves subagent and compaction roles from instrumented Provider sends to the request body", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-usage-role-"))
        const finalized: FinalizedProviderAttempt[] = []
        const releaseAccounting = installTaskUsageAccountingSink({
            currentPolicyGeneration: () => POLICY_GENERATION,
            projectModelId: () => "catalog:test-model",
            recordFinalizedAttempt: (attempt) => finalized.push(attempt),
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
                finalizedAttempts: telemetry,
                readUsagePolicyGeneration: () => telemetry.usagePolicyGeneration(),
                projectUsageModelId: (provider, wireModelId) => telemetry.projectUsageModelId(provider, wireModelId),
                location: path.join(root, "metrics.db"),
            })
            const api = instrumentedProviderApi()

            await drain(api.createMessage("", [], undefined, roleOptions("subagent", "subagent:request-1")))
            await drain(api.createMessage("", [], undefined, roleOptions("compaction", "compaction:request-1")))

            let buckets: AttemptBucketState = emptyAttemptBucketState()
            for (const attempt of finalized) {
                buckets = appendAttemptToBuckets(
                    buckets,
                    projectFinalizedAttempt(attempt.handle, attempt.record, attempt.logicalExecution, attempt.logicalToolCalls),
                    {
                        newBucketId: () => "role-bucket",
                        sealedAt: () => Date.now(),
                    },
                )
            }
            const sealed = sealOpenAttemptBucket(buckets, Date.now())
            const body = buildUsageAttemptBody(sealed.sealed, { version: "0.11.1" })

            expect(body.buckets.flatMap((bucket) => bucket.facts.map((fact) => fact.role)).sort()).toEqual([
                "compaction",
                "subagent",
            ])
        } finally {
            await performance?.release()
            telemetry.dispose()
            releaseAccounting()
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

function instrumentedProviderApi(): ApiHandler {
    const raw = {
        createMessage: async function* (): ApiStream {
            const providerStream = await ApiHandler.observeProviderStream(
                { provider: "openai", modelId: "test-model", thinking: "state:disabled" },
                async () =>
                    (async function* () {
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

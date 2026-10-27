import { ulid } from "ulid"
import type { ApiHandler, ApiRequestOptions } from "@/core/api/ApiHandler"
import type { ApiStream } from "@/core/api/transform/stream"
import {
    type ProviderAttemptScopeInput,
    type ProviderAttemptUsageInput,
    registerTaskTraceSource,
    type TaskTraceSource,
} from "@/services/telemetry/service/task-trace-context"
import { taskUsageAccounting } from "../observability/task-usage-accounting"
import { ApiRequestRoundLifecycle } from "./api-request-round-lifecycle"
import { ApiRequestRoundTracker } from "./api-request-round-tracker"
import type { ApiRequestRoundCumulativeUsage, ApiRequestRoundRecord, ApiRequestRoundRepository } from "./api-request-round-types"
import { ApiResponseExecutionLifecycle } from "./api-response-execution-lifecycle"
import type { ApiResponseExecutionRecord, ApiResponseExecutionRepository } from "./api-response-execution-types"
import type { ProviderRequestRoundAdmission } from "./provider-request-round-port"
import { TaskProviderRequestRoundOwner } from "./TaskProviderRequestRoundOwner"

const EMPTY_CUMULATIVE_USAGE: ApiRequestRoundCumulativeUsage = { degraded: false, cacheNumerator: 0, cacheDenominator: 0 }

/** No Task view reads an untasked request back, so its rounds keep no local history. */
const TRANSIENT_ROUNDS: ApiRequestRoundRepository = {
    append: async () => undefined,
    readRecent: async () => [] as ApiRequestRoundRecord[],
    readRange: async () => [] as ApiRequestRoundRecord[],
    readRangeSnapshot: async () => [] as ApiRequestRoundRecord[],
    readRecentHistory: async () => [] as ApiRequestRoundRecord[],
    readRangeHistorySnapshot: async () => [] as ApiRequestRoundRecord[],
    readCumulativeUsage: async () => EMPTY_CUMULATIVE_USAGE,
    isDegraded: () => false,
    waitForWrites: async () => undefined,
    close: async () => undefined,
}

const TRANSIENT_EXECUTIONS: ApiResponseExecutionRepository = {
    append: async () => undefined,
    readRecent: async () => [] as ApiResponseExecutionRecord[],
    readRange: async () => [] as ApiResponseExecutionRecord[],
    readRangeSnapshot: async () => [] as ApiResponseExecutionRecord[],
    waitForWrites: async () => undefined,
    close: async () => undefined,
}

/**
 * Stream one model response that belongs to no Task.
 *
 * The request is observed from its first send and released when the consumer
 * finishes, fails or stops early, so callers only replace `createMessage`.
 */
export async function* createUntaskedMessage(
    api: Pick<ApiHandler, "createMessage">,
    systemPrompt: string,
    messages: Parameters<ApiHandler["createMessage"]>[1],
): ApiStream {
    const request = new UntaskedProviderRequest()
    try {
        yield* api.createMessage(systemPrompt, messages, undefined, request.requestOptions())
    } finally {
        await request.release()
    }
}

/**
 * Usage owner of one Provider request that belongs to no Task, such as commit
 * message generation or a change explanation.
 *
 * Every real send of the request is admitted with role `other` and reaches the
 * process Usage sink through the same round, execution and identity-freezing
 * path a Task uses; only the local history is omitted. The request must be
 * sent with {@link requestOptions} and released when its stream has closed,
 * which finalizes an attempt the stream left open.
 */
export class UntaskedProviderRequest {
    private readonly namespace = `untasked:${ulid()}`
    private readonly lifecycle: ApiRequestRoundLifecycle
    private readonly rounds: TaskProviderRequestRoundOwner
    private readonly unregister: () => void
    private admission: ProviderRequestRoundAdmission | undefined
    private released = false

    constructor() {
        this.lifecycle = new ApiRequestRoundLifecycle(
            new ApiRequestRoundTracker({ taskId: this.namespace, repository: TRANSIENT_ROUNDS }),
            new ApiResponseExecutionLifecycle({ taskId: this.namespace, repository: TRANSIENT_EXECUTIONS }),
            taskUsageAccounting,
        )
        this.rounds = new TaskProviderRequestRoundOwner({
            lifecycle: this.lifecycle,
            readExecutionBlocks: () => [],
            isExecutionCancelling: () => false,
            readPolicyGeneration: () => taskUsageAccounting.currentPolicyGeneration(),
        })
        this.unregister = registerTaskTraceSource(this.namespace, this.traceSource())
    }

    /** Options that route the request's sends to this owner. */
    requestOptions(): ApiRequestOptions {
        return { taskNamespace: this.namespace, telemetryRole: "other" }
    }

    /** Finalize every attempt the request left open and stop observing it; repeated calls are ignored. */
    async release(): Promise<void> {
        if (this.released) return
        this.released = true
        this.unregister()
        await this.lifecycle.close()
    }

    private traceSource(): TaskTraceSource {
        return {
            currentSpan: () => undefined,
            attributes: () => ({}),
            event: () => undefined,
            failure: () => undefined,
            providerAttemptObserver: (input: ProviderAttemptScopeInput) => {
                // Attempt zero starts the semantic request; a positive retry index reuses it.
                if (!this.admission || input.taskAttempt === 0) this.admission = this.rounds.admit({ source: "other" })
                return this.admission.createAttemptObserver(input.taskAttempt, input.adapter)
            },
            providerAttemptUsage: (input: ProviderAttemptUsageInput) => this.admission?.attachExactUsage(input.usage),
            providerRequestCompleted: () => {
                this.admission?.completeProviderOnly()
                this.admission = undefined
            },
        }
    }
}

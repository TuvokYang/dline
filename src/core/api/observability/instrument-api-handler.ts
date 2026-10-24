import { isSignalRecordingEnabled } from "@/services/telemetry/service/pipeline-port"
import {
    type ProviderAttemptScopeInput,
    type TaskTraceSource,
    taskTraceSource,
} from "@/services/telemetry/service/task-trace-context"
import { Logger } from "@/shared/services/Logger"
import { ApiHandler, type ApiHandlerContext, type ProviderTelemetryRole } from "../ApiHandler"
import type { ApiProviderStreamChunk, ApiStream } from "../transform/stream"
import { ApiUsageAccumulator } from "../transform/usage-accumulator"
import { ApiRequestObservation } from "./api-request-observation"
import { requestMetadata } from "./api-request-snapshot"

/** Preserve handler identity and optional methods; only wrap the owned generation/abort boundary. */
export function instrumentApiHandler(handler: ApiHandler, context: ApiHandlerContext): ApiHandler {
    const send = handler.createMessage.bind(handler)
    const abort = handler.abort?.bind(handler)
    const active = new Set<ApiRequestObservation>()

    handler.createMessage = (...args: Parameters<ApiHandler["createMessage"]>): ApiStream => {
        let stream: ApiStream | undefined
        const start = (): ApiStream => {
            const [, messages, tools, options] = args
            const taskId = options?.taskNamespace ?? context.ulid
            const task = taskTraceSource(taskId)
            const provider = handler.getProviderId?.() ?? context.profile.provider
            const attemptScope: ProviderAttemptScopeInput = {
                role: providerTelemetryRole(options),
                logicalRequestId: options?.telemetryRequestId,
                taskAttempt: options?.telemetryAttempt ?? 0,
                ...(provider ? { adapter: { provider } } : {}),
            }
            const attemptObserver = task?.providerAttemptObserver?.(attemptScope)
            const bindAttempts = (stream: ApiStream): ApiStream => {
                const bound = attemptObserver
                    ? (ApiHandler.bindProviderAttemptScope(
                          stream,
                          attemptObserver,
                          provider ? { provider } : undefined,
                      ) as ApiStream)
                    : stream
                return observeExactUsage(bound, task, attemptScope)
            }
            if (!isSignalRecordingEnabled()) return bindAttempts(send(...args))
            try {
                const metadata = requestMetadata(handler, context, messages.length, tools?.length ?? 0, options)
                const observation = new ApiRequestObservation(metadata, taskId, () => active.delete(observation))
                active.add(observation)
                return bindAttempts(observation.wrap(() => send(...args)))
            } catch {
                Logger.debug("[ApiRequestObservation] Request metadata unavailable")
                return bindAttempts(send(...args))
            }
        }
        let closedBeforeStart = false
        return {
            next: (...values: [] | [unknown]) => {
                if (closedBeforeStart) return Promise.resolve({ done: true, value: undefined })
                stream ??= start()
                return stream.next(...values)
            },
            return: (value: unknown) => {
                if (stream) return stream.return(value)
                closedBeforeStart = true
                return Promise.resolve({ done: true, value })
            },
            throw: (error: unknown) => {
                if (stream) return stream.throw(error)
                closedBeforeStart = true
                return Promise.reject(error)
            },
            async [Symbol.asyncDispose]() {
                if (stream) await stream.return(undefined)
                closedBeforeStart = true
            },
            [Symbol.asyncIterator]() {
                return this
            },
        }
    }
    if (abort) {
        handler.abort = () => {
            for (const observation of active) observation.cancel("handler_abort")
            abort()
        }
    }
    return handler
}

function observeExactUsage(stream: ApiStream, task: TaskTraceSource | undefined, scope: ProviderAttemptScopeInput): ApiStream {
    return (async function* () {
        const accumulator = new ApiUsageAccumulator()
        let usageObserved = false
        let cacheUsageReported = false
        let thoughtsTokens = 0
        let totalCost: number | undefined
        let completed = false
        try {
            for await (const chunk of stream) {
                if (chunk.type === "usage") {
                    usageObserved = true
                    accumulator.apply(chunk)
                    cacheUsageReported ||= chunk.cacheWriteTokens !== undefined || chunk.cacheReadTokens !== undefined
                    const thoughts = finiteCount(chunk.thoughtsTokenCount)
                    thoughtsTokens = chunk.usageMode === "delta" ? thoughtsTokens + thoughts : Math.max(thoughtsTokens, thoughts)
                    if (Number.isFinite(chunk.totalCost)) totalCost = chunk.totalCost
                }
                yield chunk as ApiProviderStreamChunk
            }
            completed = true
        } finally {
            if (usageObserved) {
                const usage = accumulator.getUsage()
                task?.providerAttemptUsage?.({
                    ...scope,
                    usage: {
                        ...usage,
                        ...(thoughtsTokens > 0 ? { thoughtsTokens } : {}),
                        cacheUsageReported,
                        ...(totalCost === undefined ? {} : { totalCost }),
                    },
                })
            }
            if (completed) task?.providerRequestCompleted?.(scope)
        }
    })()
}

function finiteCount(value: number | undefined): number {
    return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : 0
}

function providerTelemetryRole(options: Parameters<ApiHandler["createMessage"]>[3]): ProviderTelemetryRole {
    if (options?.telemetryRole) return options.telemetryRole
    if (options?.generation?.purpose === "compaction" || options?.retryOwner === "compaction") return "compaction"
    if (options?.retryOwner === "subagent") return "subagent"
    return "task"
}

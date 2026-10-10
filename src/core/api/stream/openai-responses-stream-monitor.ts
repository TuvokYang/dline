import type OpenAI from "openai"

export class StreamIdleTimeoutError extends Error {
    readonly code = "stream_idle_timeout"

    constructor(readonly timeoutMs: number) {
        super(`OpenAI Responses stream received no event for ${Math.ceil(timeoutMs / 1_000)} seconds`)
        this.name = "StreamIdleTimeoutError"
    }
}

export interface OpenAIResponsesStreamMonitorOptions {
    idleTimeoutMs: number
    abort: () => void
    log: (message: string) => void
    requestLabel: string
    rateIntervalMs?: number
    now?: () => number
    onEstimatedTokens?: (tokens: number) => void
}

interface CompletedUsage {
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
    reasoningTokens: number
}

const DEFAULT_RATE_INTERVAL_MS = 1_000

function readEventType(event: OpenAI.Responses.ResponseStreamEvent): string {
    return typeof event.type === "string" ? event.type : "unknown"
}

function readDelta(event: OpenAI.Responses.ResponseStreamEvent): string | undefined {
    const value = (event as unknown as { delta?: unknown }).delta
    return typeof value === "string" ? value : undefined
}

function classifyDelta(type: string): "reasoning" | "text" | "tool" | undefined {
    if (type === "response.output_text.delta") return "text"
    if (type === "response.function_call_arguments.delta") return "tool"
    if (type.includes("reasoning") && type.endsWith(".delta")) return "reasoning"
    return undefined
}

function readCompletedUsage(event: OpenAI.Responses.ResponseStreamEvent): CompletedUsage | undefined {
    if (event.type !== "response.completed") return undefined
    const response = (event as unknown as { response?: unknown }).response
    if (typeof response !== "object" || response === null) return undefined
    const usage = (response as { usage?: unknown }).usage
    if (typeof usage !== "object" || usage === null) return undefined
    const values = usage as {
        input_tokens?: unknown
        input_tokens_details?: { cached_tokens?: unknown } | null
        output_tokens?: unknown
        output_tokens_details?: { reasoning_tokens?: unknown } | null
    }
    return {
        inputTokens: typeof values.input_tokens === "number" ? values.input_tokens : 0,
        outputTokens: typeof values.output_tokens === "number" ? values.output_tokens : 0,
        cachedInputTokens:
            typeof values.input_tokens_details?.cached_tokens === "number" ? values.input_tokens_details.cached_tokens : 0,
        reasoningTokens:
            typeof values.output_tokens_details?.reasoning_tokens === "number"
                ? values.output_tokens_details.reasoning_tokens
                : 0,
    }
}

function estimateTokens(bytes: number): number {
    return Math.ceil(bytes / 4)
}

function formatRate(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

/**
 * Observes raw OpenAI Responses events without changing their payload or order.
 * The watchdog measures event-level idleness so lifecycle events also keep a
 * legitimate long-running reasoning request alive.
 */
export class OpenAIResponsesStreamMonitor {
    private readonly now: () => number
    private readonly rateIntervalMs: number

    constructor(private readonly options: OpenAIResponsesStreamMonitorOptions) {
        this.now = options.now ?? Date.now
        this.rateIntervalMs = options.rateIntervalMs ?? DEFAULT_RATE_INTERVAL_MS
    }

    async *observe(
        stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
    ): AsyncGenerator<OpenAI.Responses.ResponseStreamEvent> {
        const iterator = stream[Symbol.asyncIterator]()
        const startedAtMs = this.now()
        let lastEventAtMs = startedAtMs
        let maxEventGapMs = 0
        let totalEvents = 0
        let totalContentBytes = 0
        let completedLogged = false
        let timedOut = false
        let windowContentBytes = 0

        const reportEstimatedTokens = () => {
            const estimatedTokensInWindow = estimateTokens(windowContentBytes)
            if (estimatedTokensInWindow > 0) this.options.onEstimatedTokens?.(estimatedTokensInWindow)
            windowContentBytes = 0
        }
        const rateTimer = setInterval(reportEstimatedTokens, this.rateIntervalMs)

        try {
            while (true) {
                const result = await this.nextWithIdleTimeout(iterator, () => {
                    timedOut = true
                })
                if (result.done) break

                const event = result.value
                const eventAtMs = this.now()
                const eventGapMs = Math.max(0, eventAtMs - lastEventAtMs)
                maxEventGapMs = Math.max(maxEventGapMs, eventGapMs)
                lastEventAtMs = eventAtMs
                totalEvents += 1

                const type = readEventType(event)
                const delta = readDelta(event)
                const deltaType = classifyDelta(type)
                if (delta !== undefined && deltaType !== undefined) {
                    const bytes = Buffer.byteLength(delta, "utf8")
                    totalContentBytes += bytes
                    windowContentBytes += bytes
                }

                const usage = readCompletedUsage(event)
                if (usage) {
                    completedLogged = true
                    const durationMs = Math.max(0, eventAtMs - startedAtMs)
                    const exactOutputTokensPerSecond =
                        durationMs > 0 ? (usage.outputTokens * 1_000) / durationMs : usage.outputTokens
                    this.options.log(
                        `[${this.options.requestLabel}] OpenAI Responses stream completed: durationMs=${durationMs}, events=${totalEvents}, inputTokens=${usage.inputTokens}, outputTokens=${usage.outputTokens}, cachedInputTokens=${usage.cachedInputTokens}, reasoningTokens=${usage.reasoningTokens}, exactOutputTokensPerSecond=${formatRate(exactOutputTokensPerSecond)}, estimatedTokensTotal=${estimateTokens(totalContentBytes)}, maxEventGapMs=${maxEventGapMs}`,
                    )
                }

                yield event
            }
        } finally {
            clearInterval(rateTimer)
            reportEstimatedTokens()
            if (!completedLogged && !timedOut) {
                const durationMs = Math.max(0, this.now() - startedAtMs)
                this.options.log(
                    `[${this.options.requestLabel}] OpenAI Responses stream ended without completed usage: durationMs=${durationMs}, events=${totalEvents}, estimatedTokensTotal=${estimateTokens(totalContentBytes)}, maxEventGapMs=${maxEventGapMs}`,
                )
            }
        }
    }

    private async nextWithIdleTimeout(
        iterator: AsyncIterator<OpenAI.Responses.ResponseStreamEvent>,
        onTimeout: () => void,
    ): Promise<IteratorResult<OpenAI.Responses.ResponseStreamEvent>> {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_resolve, reject) => {
            timeoutHandle = setTimeout(() => {
                onTimeout()
                this.options.abort()
                reject(new StreamIdleTimeoutError(this.options.idleTimeoutMs))
            }, this.options.idleTimeoutMs)
        })
        try {
            return await Promise.race([iterator.next(), timeout])
        } finally {
            if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
        }
    }
}

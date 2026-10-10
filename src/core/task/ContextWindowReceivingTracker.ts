import type { ApiProviderStreamChunk } from "@core/api/transform/stream"
import { ApiUsageAccumulator, type NormalizedApiUsage } from "@core/api/transform/usage-accumulator"

export interface ContextWindowReceivingSnapshot {
    localEstimatedOutputTokens: number
    providerOutputTokens: number
    receivingTokens: number
    authoritativeContextTokens: number
    providerUsage?: NormalizedApiUsage
}

/** Track one response's model-generated payload separately from Provider-hosted lifecycle data. */
export class ContextWindowReceivingTracker {
    private readonly usage = new ApiUsageAccumulator()
    private readonly toolArgumentsByKey = new Map<string, string>()
    private generatedTextBytes = 0
    private hasProviderOutputUsage = false
    private hasProviderUsage = false

    apply(candidate: unknown): ContextWindowReceivingSnapshot {
        if (!isApiProviderStreamChunk(candidate)) return this.getSnapshot()
        const chunk = candidate
        switch (chunk.type) {
            case "text":
                this.generatedTextBytes += getUtf8Bytes(chunk.text)
                break
            case "reasoning":
                this.generatedTextBytes += getUtf8Bytes(chunk.reasoning)
                break
            case "tool_calls":
                this.applyToolArguments(chunk)
                break
            case "usage": {
                this.hasProviderUsage = true
                const applied = this.usage.apply(chunk)
                if (applied.usage.outputTokens > 0) {
                    this.hasProviderOutputUsage = true
                }
                break
            }
            case "server_tool":
                break
        }
        return this.getSnapshot()
    }

    getSnapshot(): ContextWindowReceivingSnapshot {
        const localEstimatedOutputTokens = estimateTokens(this.getGeneratedBytes())
        const providerUsage = this.usage.getUsage()
        const providerOutputTokens = providerUsage.outputTokens
        return {
            localEstimatedOutputTokens,
            providerOutputTokens,
            receivingTokens: this.hasProviderOutputUsage ? providerOutputTokens : localEstimatedOutputTokens,
            authoritativeContextTokens: this.hasProviderUsage ? getUsageTotal(providerUsage) : 0,
            ...(this.hasProviderUsage ? { providerUsage } : {}),
        }
    }

    private applyToolArguments(chunk: Extract<ApiProviderStreamChunk, { type: "tool_calls" }>): void {
        const argumentsText = normalizeArguments(chunk.tool_call.function.arguments)
        if (!argumentsText) return
        const key = getToolArgumentsKey(chunk)
        if (chunk.argumentsMode === "snapshot") {
            this.toolArgumentsByKey.set(key, argumentsText)
            return
        }
        this.toolArgumentsByKey.set(key, `${this.toolArgumentsByKey.get(key) ?? ""}${argumentsText}`)
    }

    private getGeneratedBytes(): number {
        let bytes = this.generatedTextBytes
        for (const argumentsText of this.toolArgumentsByKey.values()) {
            bytes += getUtf8Bytes(argumentsText)
        }
        return bytes
    }
}

function isApiProviderStreamChunk(candidate: unknown): candidate is ApiProviderStreamChunk {
    if (typeof candidate !== "object" || candidate === null) return false
    const type = (candidate as { type?: unknown }).type
    return type === "text" || type === "reasoning" || type === "tool_calls" || type === "server_tool" || type === "usage"
}

function getToolArgumentsKey(chunk: Extract<ApiProviderStreamChunk, { type: "tool_calls" }>): string {
    if (chunk.tool_index !== undefined) return `index:${chunk.tool_index}`
    return `function:${chunk.function_id}`
}

function normalizeArguments(value: unknown): string {
    if (typeof value === "string") return value
    if (value === undefined || value === null) return ""
    return JSON.stringify(value)
}

function getUtf8Bytes(value: string): number {
    return value ? Buffer.byteLength(value, "utf8") : 0
}

function estimateTokens(bytes: number): number {
    return bytes > 0 ? Math.max(1, Math.ceil(bytes / 4)) : 0
}

function getUsageTotal(usage: NormalizedApiUsage): number {
    return usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens + usage.cacheReadTokens
}

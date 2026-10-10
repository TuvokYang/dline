import { combineApiRequests } from "@shared/combineApiRequests"
import { combineCommandSequences } from "@shared/combineCommandSequences"
import type { UiMessage } from "@shared/ExtensionMessage"
import { type ApiMetrics, getApiMetrics } from "@shared/getApiMetrics"

const USAGE_FIELDS = ["tokensIn", "tokensOut", "cacheWrites", "cacheReads", "cost", "currency"] as const

interface CachedProjection {
    text: UiMessage["text"]
    type: UiMessage["type"]
    say: UiMessage["say"]
    ask: UiMessage["ask"]
    ts: number
    commandTs: UiMessage["commandTs"]
    message: UiMessage
}

/** Legacy compatibility inside the metrics owner; never retains a parsed request body. */
export class MessageUsageProjection {
    private readonly cache = new WeakMap<UiMessage, CachedProjection>()

    read(messages: UiMessage[]): ApiMetrics {
        const projected = messages.map((message) => this.project(message))
        return getApiMetrics(combineApiRequests(combineCommandSequences(projected)))
    }

    private project(message: UiMessage): UiMessage {
        if (
            message.type !== "say" ||
            !message.text ||
            (message.say !== "api_req_started" &&
                message.say !== "api_req_finished" &&
                message.say !== "deleted_api_reqs" &&
                message.say !== "subagent_usage")
        ) {
            return message
        }
        const cached = this.cache.get(message)
        if (
            cached &&
            cached.text === message.text &&
            cached.type === message.type &&
            cached.say === message.say &&
            cached.ask === message.ask &&
            cached.ts === message.ts &&
            cached.commandTs === message.commandTs
        ) {
            return cached.message
        }
        const projected = projectUsage(message)
        this.cache.set(message, {
            text: message.text,
            type: message.type,
            say: message.say,
            ask: message.ask,
            ts: message.ts,
            commandTs: message.commandTs,
            message: projected,
        })
        return projected
    }
}

function projectUsage(message: UiMessage): UiMessage {
    // Mixed command/usage rows retain text until the canonical command transform.
    if (message.ask === "command" || message.ask === "command_output") return message
    try {
        const parsed: unknown = JSON.parse(message.text!)
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return message
        const data = parsed as Record<string, unknown>
        const usage: Record<string, number | string | null> = {}
        for (const field of USAGE_FIELDS) {
            if (!Object.hasOwn(data, field)) continue
            const value = data[field]
            // Paired Infinity is normalized by JSON; unpaired usage keeps it.
            if (typeof value === "number" && !Number.isFinite(value)) return message
            // Invalid finished values still override valid started values.
            usage[field] = (field === "currency" ? typeof value === "string" : typeof value === "number")
                ? (value as number | string)
                : null
        }
        return { ...message, text: JSON.stringify(usage) }
    } catch {
        // Preserve canonical paired errors and unpaired malformed-row handling.
        return message
    }
}

import type OpenAI from "openai"

type EventRecord = Record<string, unknown>

function asRecord(value: unknown): EventRecord | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as EventRecord) : undefined
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
    return values.find((value): value is string => typeof value === "string" && value.length > 0)
}

function canonicalEventType(type: unknown): string | undefined {
    switch (type) {
        case "response.text.delta":
        case "response.refusal.delta":
            return "response.output_text.delta"
        case "response.reasoning.delta":
            return "response.reasoning_text.delta"
        case "response.reasoning_summary.delta":
            return "response.reasoning_summary_text.delta"
        case "response.tool_call_arguments.delta":
            return "response.function_call_arguments.delta"
        case "response.tool_call_arguments.done":
            return "response.function_call_arguments.done"
        case "response.done":
            return "response.completed"
        default:
            return typeof type === "string" ? type : undefined
    }
}

function canonicalFunctionItem(item: EventRecord): EventRecord {
    if (item.type !== "tool_call") return item
    const nestedFunction = asRecord(item.function)
    return {
        ...item,
        type: "function_call",
        call_id: firstNonEmptyString(item.call_id, item.tool_call_id),
        name: firstNonEmptyString(item.name, nestedFunction?.name, item.function_name),
        arguments: firstNonEmptyString(item.arguments, nestedFunction?.arguments, item.function_arguments) ?? "",
    }
}

function canonicalReasoningItem(item: EventRecord): EventRecord {
    if (item.type !== "reasoning" || Array.isArray(item.summary) || typeof item.text !== "string" || item.text.length === 0) {
        return item
    }
    return {
        ...item,
        summary: [{ type: "summary_text", text: item.text }],
    }
}

function canonicalOutputItem(value: unknown): EventRecord | undefined {
    const item = asRecord(value)
    if (!item) return undefined
    return canonicalReasoningItem(canonicalFunctionItem(item))
}

function syntheticFunctionItem(event: EventRecord): EventRecord | undefined {
    const itemId = firstNonEmptyString(event.item_id)
    const callId = firstNonEmptyString(event.call_id, event.tool_call_id)
    const name = firstNonEmptyString(event.name, event.function_name)
    if (!itemId || !callId || !name) return undefined
    return {
        type: "function_call",
        id: itemId,
        call_id: callId,
        name,
        arguments: "",
    }
}

function outputItemText(item: EventRecord): string | undefined {
    if (item.type === "text") return firstNonEmptyString(item.text)
    if (item.type !== "message" || !Array.isArray(item.content)) return undefined
    const text = item.content
        .map((content) => asRecord(content))
        .filter((content): content is EventRecord => content !== undefined)
        .filter((content) => content.type === "text" || content.type === "output_text")
        .map((content) => (typeof content.text === "string" ? content.text : ""))
        .join("")
    return text.length > 0 ? text : undefined
}

function canonicalCompletionResponse(event: EventRecord): EventRecord | undefined {
    const response = asRecord(event.response)
    if (response) {
        return response.usage === undefined && event.usage !== undefined ? { ...response, usage: event.usage } : response
    }
    const responseId = firstNonEmptyString(event.response_id, event.id)
    if (!responseId && event.usage === undefined) return undefined
    return {
        id: responseId ?? "",
        status: "completed",
        output: [],
        ...(event.usage === undefined ? {} : { usage: event.usage }),
    }
}

/**
 * Normalize ChatGPT Codex compatibility aliases into standard Responses events.
 *
 * This adapter intentionally does not aggregate content or deduplicate snapshots.
 * The shared OpenAI Responses stream processor owns those stateful policies.
 */
export async function* canonicalizeOpenAiCodexResponseEvents(
    events: AsyncIterable<unknown>,
): AsyncGenerator<OpenAI.Responses.ResponseStreamEvent> {
    const registeredFunctionItems = new Set<string>()
    const streamedTextItemIds = new Set<string>()
    let streamedAnonymousText = false
    let activeMessageItemId: string | undefined
    let activeReasoningItemId: string | undefined

    for await (const rawEvent of events) {
        const raw = asRecord(rawEvent)
        if (!raw) {
            yield rawEvent as OpenAI.Responses.ResponseStreamEvent
            continue
        }

        let type = canonicalEventType(raw.type)
        const firstChoice = Array.isArray(raw.choices) ? asRecord(raw.choices[0]) : undefined
        const legacyDelta = asRecord(firstChoice?.delta)
        const legacyText = firstNonEmptyString(legacyDelta?.content)
        if ((!type || type === "usage") && legacyText) type = "response.output_text.delta"
        if ((!type || type === "usage") && !legacyText && raw.usage !== undefined) type = "response.completed"

        const event: EventRecord = { ...raw, ...(type ? { type } : {}) }
        if (legacyText) event.delta = legacyText
        if (raw.type === "response.refusal.delta" && typeof raw.delta === "string") {
            event.delta = `[Refusal] ${raw.delta}`
        }

        let completedOutputItem: EventRecord | undefined
        if (type === "response.output_item.added" || type === "response.output_item.done") {
            const item = canonicalOutputItem(raw.item)
            if (item) {
                event.item = item
                const itemId = firstNonEmptyString(item.id)
                if (item.type === "function_call" && itemId) registeredFunctionItems.add(itemId)
                if (type === "response.output_item.added" && itemId) {
                    if (item.type === "message") activeMessageItemId = itemId
                    if (item.type === "reasoning") activeReasoningItemId = itemId
                }
                if (type === "response.output_item.done") completedOutputItem = item
            }
        }

        if (type === "response.output_text.delta" && !firstNonEmptyString(event.item_id) && activeMessageItemId) {
            event.item_id = activeMessageItemId
        }
        if (type === "response.output_text.delta") {
            const itemId = firstNonEmptyString(event.item_id)
            if (itemId) streamedTextItemIds.add(itemId)
            else streamedAnonymousText = true
        }
        if (
            (type === "response.reasoning_text.delta" || type === "response.reasoning_summary_text.delta") &&
            !firstNonEmptyString(event.item_id) &&
            activeReasoningItemId
        ) {
            event.item_id = activeReasoningItemId
        }

        if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
            const itemId = firstNonEmptyString(event.item_id)
            if (itemId && !registeredFunctionItems.has(itemId)) {
                const item = syntheticFunctionItem(event)
                if (item) {
                    registeredFunctionItems.add(itemId)
                    yield {
                        type: "response.output_item.added",
                        output_index: typeof event.output_index === "number" ? event.output_index : 0,
                        sequence_number: typeof event.sequence_number === "number" ? event.sequence_number : 0,
                        item,
                    } as unknown as OpenAI.Responses.ResponseStreamEvent
                }
            }
        }

        if (type === "response.completed") {
            const response = canonicalCompletionResponse(event)
            if (response) event.response = response
        }

        const completedText = completedOutputItem ? outputItemText(completedOutputItem) : undefined
        const completedItemId = firstNonEmptyString(completedOutputItem?.id)
        const alreadyStreamed = completedItemId ? streamedTextItemIds.has(completedItemId) : streamedAnonymousText
        if (completedText && !alreadyStreamed) {
            yield {
                type: "response.output_text.delta",
                delta: completedText,
                item_id: completedItemId ?? activeMessageItemId ?? "",
                output_index: typeof event.output_index === "number" ? event.output_index : 0,
                content_index: 0,
                sequence_number: typeof event.sequence_number === "number" ? event.sequence_number : 0,
                logprobs: [],
            } as OpenAI.Responses.ResponseStreamEvent
        }

        yield event as unknown as OpenAI.Responses.ResponseStreamEvent

        if (type === "response.output_item.done") {
            const itemId = firstNonEmptyString(completedOutputItem?.id)
            if (itemId === activeMessageItemId) activeMessageItemId = undefined
            if (itemId === activeReasoningItemId) activeReasoningItemId = undefined
            if (completedOutputItem?.type === "message" || completedOutputItem?.type === "text") streamedAnonymousText = false
        }
    }
}

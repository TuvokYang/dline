import type {
    ClineAssistantToolUseBlock,
    ClineContent,
    ClineProviderMetadata,
    ClineStorageMessage,
    ClineUserToolResultContentBlock,
} from "./content"

type LegacyBlock = Record<string, any>

function nonEmptyString(...values: unknown[]): string | undefined {
    return values.find((value): value is string => typeof value === "string" && value.length > 0)
}

function providerMetadata(block: LegacyBlock): ClineProviderMetadata | undefined {
    const existing = block.provider_metadata as ClineProviderMetadata | undefined
    const responseId = nonEmptyString(existing?.response_id, block.call_id)
    const rawItemId = nonEmptyString(existing?.item_id, block.item_id)
    // Only provider-native Responses item IDs belong in transport metadata.
    const itemId = rawItemId?.startsWith("fc_") ? rawItemId : undefined
    return responseId || itemId ? { response_id: responseId, item_id: itemId } : undefined
}

function hasOwn(value: LegacyBlock, key: string): boolean {
    return Object.hasOwn(value, key)
}

/** Return true only when persisted messages still contain legacy identity shapes. */
export function requiresLegacyConversationMigration(input: readonly unknown[]): boolean {
    return input.some((rawMessage) => {
        const message = rawMessage as LegacyBlock | undefined
        if (!message || typeof message !== "object") return false
        if (["id", "call_id", "tool_use_id", "item_id"].some((key) => hasOwn(message, key))) return true
        if (!Array.isArray(message.content)) return false
        return message.content.some((rawBlock: unknown) => {
            const block = rawBlock as LegacyBlock | undefined
            if (!block || typeof block !== "object") return false
            if (["call_id", "tool_use_id", "item_id"].some((key) => hasOwn(block, key))) return true
            if (block.type === "tool_use" || block.type === "tool_result") {
                return (
                    hasOwn(block, "id") ||
                    typeof block.function_id !== "string" ||
                    block.function_id.length === 0 ||
                    typeof block.dline_tid !== "string" ||
                    block.dline_tid.length === 0
                )
            }
            return ["id", "function_id", "dline_tid"].some((key) => hasOwn(block, key))
        })
    })
}

/**
 * Normalize persisted legacy identities at the storage ingress boundary.
 * The returned conversation never exposes call_id, tool_use_id, item_id, or tool-use id.
 */
export function normalizeLegacyConversation(input: readonly unknown[]): ClineStorageMessage[] {
    const functionToDlineTid = new Map<string, string>()

    for (const [messageIndex, rawMessage] of input.entries()) {
        const content = (rawMessage as LegacyBlock | undefined)?.content
        if (!Array.isArray(content)) continue
        for (const [blockIndex, rawBlock] of content.entries()) {
            const block = rawBlock as LegacyBlock
            if (block.type !== "tool_use") continue
            const functionId =
                nonEmptyString(block.function_id, block.id, block.call_id) ?? `legacy_function_${messageIndex}_${blockIndex}`
            const dlineTid = nonEmptyString(block.dline_tid) ?? `legacy_tid_${functionId}`
            functionToDlineTid.set(functionId, dlineTid)
        }
    }

    return input.map((rawMessage, messageIndex) => {
        const message = rawMessage as LegacyBlock
        const rawContent = message.content
        const messageResponseId = nonEmptyString(message.provider_metadata?.response_id, message.id)
        const messageProviderMetadata =
            messageResponseId || message.provider_metadata
                ? {
                      ...(message.provider_metadata as ClineProviderMetadata | undefined),
                      response_id: messageResponseId,
                  }
                : undefined
        const content = Array.isArray(rawContent)
            ? rawContent.map((rawBlock, blockIndex): ClineContent => {
                  const block = rawBlock as LegacyBlock
                  if (block.type === "tool_use") {
                      const functionId =
                          nonEmptyString(block.function_id, block.id, block.call_id) ??
                          `legacy_function_${messageIndex}_${blockIndex}`
                      return {
                          type: "tool_use",
                          function_id: functionId,
                          dline_tid: functionToDlineTid.get(functionId) ?? `legacy_tid_${functionId}`,
                          name: typeof block.name === "string" ? block.name : "unknown",
                          input: block.input ?? {},
                          reasoning_details: block.reasoning_details,
                          signature: block.signature,
                          provider_metadata: providerMetadata(block),
                      } satisfies ClineAssistantToolUseBlock
                  }
                  if (block.type === "tool_result") {
                      const functionId =
                          nonEmptyString(block.function_id, block.tool_use_id, block.call_id) ??
                          `legacy_function_${messageIndex}_${blockIndex}`
                      return {
                          type: "tool_result",
                          function_id: functionId,
                          dline_tid:
                              nonEmptyString(block.dline_tid, functionToDlineTid.get(functionId)) ?? `legacy_tid_${functionId}`,
                          content: block.content ?? "",
                          is_error: block.is_error,
                          provider_metadata: providerMetadata(block),
                      } satisfies ClineUserToolResultContentBlock
                  }

                  const {
                      call_id: _callId,
                      item_id: _itemId,
                      function_id: _functionId,
                      dline_tid: _dlineTid,
                      tool_use_id: _toolUseId,
                      id: _contentId,
                      provider_metadata: _providerMetadata,
                      ...canonical
                  } = block
                  return {
                      ...canonical,
                      provider_metadata: providerMetadata(block),
                  } as ClineContent
              })
            : typeof rawContent === "string"
              ? rawContent
              : ""

        return {
            role: message.role === "assistant" ? "assistant" : "user",
            content,
            provider_metadata: messageProviderMetadata,
            modelInfo: message.modelInfo,
            metrics: message.metrics,
            ts: typeof message.ts === "number" ? message.ts : undefined,
        } satisfies ClineStorageMessage
    })
}

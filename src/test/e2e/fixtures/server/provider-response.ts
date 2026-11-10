import type { ServerResponse } from "node:http"
import type { MockApiProtocol, MockTokenUsage, MockToolCall, OpenAiMockResponse } from "./index"

interface ProviderResponseOptions {
    readonly res: ServerResponse
    readonly sendJson: (data: unknown) => void
    readonly scriptedResponse: Exclude<OpenAiMockResponse, { type: "error" }>
    readonly usage: MockTokenUsage
    readonly generationId: string
    readonly model: unknown
    readonly protocol: MockApiProtocol
    readonly stream: unknown
}

type HostedContentBlock =
    | {
          type: "server_tool_use"
          id: string
          name: "web_search"
          input: { query: string }
          caller: { type: "direct" }
      }
    | {
          type: "web_search_tool_result"
          tool_use_id: string
          content: {
              type: "web_search_result"
              url: string
              title: string
              snippet?: string
              page_age: null
              encrypted_content: string
          }[]
          caller: { type: "direct" }
      }

export function getResponseToolCalls(response: Exclude<OpenAiMockResponse, { type: "error" }>): readonly MockToolCall[] {
    if (response.type === "tool" || response.type === "tool-with-completion-snapshots" || response.type === "truncated-tool") {
        return [response]
    }
    if (response.type === "tools") return response.tools
    if (
        response.type === "hosted-web-search" ||
        response.type === "hosted-image-generation" ||
        response.type === "anthropic-orphan-web-search-result"
    ) {
        return response.followupTools ?? []
    }
    if (response.type === "anthropic-deferred-web-search") return response.followupTools
    return []
}

/** Explicit-instruction calls are assistant XML, never provider-native tools. */
const EXPLICIT_INSTRUCTION_TOOL_NAMES: ReadonlySet<string> = new Set(["report_bug", "summarize_task"])

function isExplicitInstructionCall(tool: MockToolCall): boolean {
    return EXPLICIT_INSTRUCTION_TOOL_NAMES.has(tool.name)
}

/** Keep scripted parameter order when rendering the XML invocation. */
function renderExplicitInstructionCall(tool: MockToolCall): string {
    const parameters = Object.entries(tool.arguments).map(
        ([name, value]) => `<${name}>\n${typeof value === "string" ? value : JSON.stringify(value)}\n</${name}>\n`,
    )
    return `<${tool.name}>\n${parameters.join("")}</${tool.name}>`
}

function splitStreamText(text: string, chunkSize?: number): string[] {
    if (!chunkSize || chunkSize <= 0 || text.length <= chunkSize) return [text]
    const chunks: string[] = []
    for (let offset = 0; offset < text.length; offset += chunkSize) {
        chunks.push(text.slice(offset, offset + chunkSize))
    }
    return chunks
}

function toOpenAiUsage(usage: MockTokenUsage) {
    const cacheReadTokens = usage.cacheReadTokens ?? 0
    const cacheWriteTokens = usage.cacheWriteTokens ?? 0
    const promptTokens = usage.inputTokens + cacheReadTokens + cacheWriteTokens
    return {
        prompt_tokens: promptTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: promptTokens + usage.outputTokens,
        prompt_tokens_details: {
            cached_tokens: cacheReadTokens,
            cache_miss_tokens: cacheWriteTokens,
        },
        completion_tokens_details: {
            reasoning_tokens: usage.reasoningTokens ?? 0,
        },
    }
}

/** Encode an admitted script on its provider wire; queue selection and request accounting stay with the server. */
export async function writeProviderResponse({
    res,
    sendJson,
    scriptedResponse,
    usage,
    generationId,
    model,
    protocol,
    stream,
}: ProviderResponseOptions): Promise<void> {
    if (scriptedResponse.type === "usage-then-error" && protocol !== "anthropic-messages") {
        throw new Error(`usage-then-error is only supported for anthropic-messages, received ${protocol}`)
    }
    if (scriptedResponse.type === "anthropic-deferred-web-search" && protocol !== "anthropic-messages") {
        throw new Error(`anthropic-deferred-web-search is only supported for anthropic-messages, received ${protocol}`)
    }
    if (scriptedResponse.type === "responses-stream-error" && protocol !== "openai-responses") {
        throw new Error(`responses-stream-error is only supported for openai-responses, received ${protocol}`)
    }
    const openAiUsage = toOpenAiUsage(usage)
    const chatUsage =
        protocol === "deepseek-chat"
            ? {
                  ...openAiUsage,
                  prompt_cache_hit_tokens: usage.cacheReadTokens ?? 0,
                  prompt_cache_miss_tokens: usage.cacheWriteTokens ?? 0,
              }
            : openAiUsage
    const scriptedToolCalls = getResponseToolCalls(scriptedResponse)
    const responseToolCalls = scriptedToolCalls.filter((tool) => !isExplicitInstructionCall(tool))
    const explicitInstructionCalls = scriptedToolCalls.filter(isExplicitInstructionCall)
    if (explicitInstructionCalls.length > 0 && responseToolCalls.length > 0) {
        throw new Error("A scripted response cannot mix explicit-instruction calls with native tool calls")
    }
    const explicitInstructionText = explicitInstructionCalls.map(renderExplicitInstructionCall).join("\n")
    // Explicit-instruction text uses the same chunking and truncation options as native arguments.
    const explicitInstructionDeltas = explicitInstructionText
        ? splitStreamText(
              scriptedResponse.type === "truncated-tool"
                  ? explicitInstructionText.slice(0, scriptedResponse.truncateAfter)
                  : explicitInstructionText,
              scriptedResponse.toolArgumentChunkSize,
          )
        : undefined
    const explicitInstructionTruncated = explicitInstructionDeltas !== undefined && scriptedResponse.type === "truncated-tool"
    const messageText =
        scriptedResponse.type === "message" || scriptedResponse.type === "truncated-message"
            ? scriptedResponse.text
            : explicitInstructionText
    const anthropicStopReason =
        scriptedResponse.anthropicStopReason ??
        (responseToolCalls.length > 0 ? "tool_use" : explicitInstructionTruncated ? "max_tokens" : "end_turn")
    const writeSse = (data: unknown, event?: string) => {
        if (res.destroyed || res.writableEnded) return
        res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`)
    }
    const waitForOpenConnection = async (delayMs?: number): Promise<boolean> => {
        if (!delayMs) return !(res.destroyed || res.writableEnded)
        await new Promise<void>((resolve) => {
            const onClose = () => {
                clearTimeout(timer)
                resolve()
            }
            const timer = setTimeout(() => {
                res.off("close", onClose)
                resolve()
            }, delayMs)
            res.once("close", onClose)
        })
        return !(res.destroyed || res.writableEnded)
    }
    const waitAfterReasoning = (): Promise<boolean> => waitForOpenConnection(scriptedResponse.afterReasoningDelayMs)

    if (protocol === "openai-chat" || protocol === "deepseek-chat") {
        const toolCalls = responseToolCalls.map((tool, index) => ({
            index,
            id: tool.id ?? `call_${generationId}_${index}`,
            type: "function",
            function: {
                name: tool.name,
                arguments: JSON.stringify(tool.arguments),
            },
        }))
        const reasoningContent = protocol === "deepseek-chat" ? scriptedResponse.reasoning : undefined
        const streamedMessageText =
            scriptedResponse.type === "truncated-message"
                ? messageText.slice(0, scriptedResponse.truncateAfter ?? messageText.length)
                : (explicitInstructionDeltas?.join("") ?? messageText)
        const responseDelta = {
            role: "assistant",
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : { content: streamedMessageText }),
        }
        if (stream !== false) {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            })
            const writeChunk = (choices: unknown, chunkUsage?: unknown) =>
                writeSse({
                    id: generationId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices,
                    ...(chunkUsage ? { usage: chunkUsage } : {}),
                })
            if (reasoningContent && scriptedResponse.afterReasoningDelayMs) {
                writeChunk([
                    {
                        index: 0,
                        delta: { role: "assistant", reasoning_content: reasoningContent },
                        finish_reason: null,
                    },
                ])
                if (!(await waitAfterReasoning())) return
                writeChunk([{ index: 0, delta: responseDelta, finish_reason: null }])
            } else if (toolCalls.length > 0 && scriptedResponse.toolArgumentChunkSize) {
                for (const [toolIndex, toolCall] of toolCalls.entries()) {
                    const argumentChunks = splitStreamText(toolCall.function.arguments, scriptedResponse.toolArgumentChunkSize)
                    for (const [chunkIndex, argumentChunk] of argumentChunks.entries()) {
                        writeChunk([
                            {
                                index: toolIndex,
                                delta: {
                                    ...(chunkIndex === 0
                                        ? {
                                              role: "assistant",
                                              tool_calls: [
                                                  {
                                                      index: toolIndex,
                                                      id: toolCall.id,
                                                      type: "function",
                                                      function: {
                                                          name: toolCall.function.name,
                                                          arguments: argumentChunk,
                                                      },
                                                  },
                                              ],
                                          }
                                        : {
                                              tool_calls: [
                                                  {
                                                      index: toolIndex,
                                                      function: { arguments: argumentChunk },
                                                  },
                                              ],
                                          }),
                                },
                                finish_reason: null,
                            },
                        ])
                        if (!(await waitForOpenConnection(scriptedResponse.toolArgumentChunkDelayMs))) return
                    }
                }
            } else if (explicitInstructionDeltas && explicitInstructionDeltas.length > 1) {
                for (const [chunkIndex, textChunk] of explicitInstructionDeltas.entries()) {
                    writeChunk([
                        {
                            index: 0,
                            delta: {
                                ...(chunkIndex === 0
                                    ? {
                                          role: "assistant",
                                          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
                                      }
                                    : {}),
                                content: textChunk,
                            },
                            finish_reason: null,
                        },
                    ])
                    if (!(await waitForOpenConnection(scriptedResponse.toolArgumentChunkDelayMs))) return
                }
            } else {
                writeChunk([
                    {
                        index: 0,
                        delta: {
                            ...responseDelta,
                            ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
                        },
                        finish_reason: null,
                    },
                ])
            }
            if (!(await waitForOpenConnection(scriptedResponse.afterChatContentDelayMs))) return
            if (scriptedResponse.type === "truncated-message") {
                res.destroy()
                return
            }
            writeChunk(
                [
                    {
                        index: 0,
                        delta: {},
                        finish_reason: toolCalls.length > 0 ? "tool_calls" : explicitInstructionTruncated ? "length" : "stop",
                    },
                ],
                chatUsage,
            )
            res.end("data: [DONE]\n\n")
            return
        }

        return sendJson({
            id: generationId,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: toolCalls.length > 0 ? null : messageText,
                        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
                        ...(toolCalls.length > 0 ? { tool_calls: toolCalls.map(({ index: _, ...tool }) => tool) } : {}),
                    },
                    finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
                },
            ],
            usage: chatUsage,
        })
    }

    if (protocol === "openai-responses") {
        const reasoningItemId = `reasoning_${generationId}`
        const reasoningItem = scriptedResponse.reasoning
            ? {
                  id: reasoningItemId,
                  type: "reasoning",
                  status: "completed",
                  summary: [{ type: "summary_text", text: scriptedResponse.reasoning }],
              }
            : undefined
        const outputOffset = reasoningItem ? 1 : 0
        const toolOutputItems = responseToolCalls.map((tool, index) => ({
            id: `item_${generationId}_${index}`,
            type: "function_call",
            status: "completed",
            call_id: tool.id ?? `call_${generationId}_${index}`,
            name: tool.name,
            arguments: JSON.stringify(tool.arguments),
        }))
        const messageOutputItem = {
            id: `item_${generationId}`,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: messageText, annotations: [] }],
        }
        const hostedSearchOutputItems =
            scriptedResponse.type === "hosted-web-search"
                ? (
                      scriptedResponse.actions ?? [
                          {
                              id: scriptedResponse.id,
                              action: { type: "search" as const, query: scriptedResponse.query },
                              results: scriptedResponse.results,
                          },
                      ]
                  ).map((call, index) => ({
                      id: call.id ?? `ws_${generationId}_${index}`,
                      type: "web_search_call",
                      status: "completed",
                      action: call.action,
                      ...(call.results
                          ? {
                                results: call.results.map(({ title, url, snippet }) => ({
                                    title,
                                    url,
                                    ...(snippet ? { snippet } : {}),
                                })),
                            }
                          : {}),
                  }))
                : []
        const hostedImageOutputItems =
            scriptedResponse.type === "hosted-image-generation"
                ? [
                      {
                          id: scriptedResponse.id ?? `ig_${generationId}`,
                          type: "image_generation_call",
                          status: "completed",
                          result: scriptedResponse.b64Json,
                          ...(scriptedResponse.revisedPrompt ? { revised_prompt: scriptedResponse.revisedPrompt } : {}),
                      },
                  ]
                : []
        const ordinaryOutputItems = toolOutputItems.length > 0 ? toolOutputItems : [messageOutputItem]
        const outputItems = [...hostedSearchOutputItems, ...hostedImageOutputItems, ...ordinaryOutputItems]
        const response = {
            id: generationId,
            object: "response",
            created_at: Math.floor(Date.now() / 1000),
            status: "completed",
            model,
            output: reasoningItem ? [reasoningItem, ...outputItems] : outputItems,
            output_text: scriptedResponse.type === "message" ? scriptedResponse.text : explicitInstructionText,
            usage: {
                input_tokens: openAiUsage.prompt_tokens,
                input_tokens_details: openAiUsage.prompt_tokens_details,
                output_tokens: usage.outputTokens,
                output_tokens_details: openAiUsage.completion_tokens_details,
                total_tokens: openAiUsage.total_tokens,
            },
        }
        if (stream === false) return sendJson(response)

        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        })
        if (scriptedResponse.type === "responses-stream-error") {
            let sequenceNumber = 0
            if (scriptedResponse.prefixText) {
                const partialItemId = `item_${generationId}_partial`
                writeSse(
                    {
                        type: "response.output_item.added",
                        sequence_number: sequenceNumber++,
                        output_index: 0,
                        item: {
                            id: partialItemId,
                            type: "message",
                            status: "in_progress",
                            role: "assistant",
                            content: [],
                        },
                    },
                    "response.output_item.added",
                )
                writeSse(
                    {
                        type: "response.output_text.delta",
                        sequence_number: sequenceNumber++,
                        item_id: partialItemId,
                        output_index: 0,
                        content_index: 0,
                        delta: scriptedResponse.prefixText,
                    },
                    "response.output_text.delta",
                )
            }
            if (scriptedResponse.prefixTool) {
                const toolItemId = `item_${generationId}_partial_tool`
                const toolCallId = scriptedResponse.prefixTool.id ?? `call_${generationId}_partial_tool`
                const toolArguments = JSON.stringify(scriptedResponse.prefixTool.arguments)
                writeSse(
                    {
                        type: "response.output_item.added",
                        sequence_number: sequenceNumber++,
                        output_index: 0,
                        item: {
                            id: toolItemId,
                            type: "function_call",
                            status: "in_progress",
                            call_id: toolCallId,
                            name: scriptedResponse.prefixTool.name,
                            arguments: "",
                        },
                    },
                    "response.output_item.added",
                )
                for (const argumentChunk of splitStreamText(toolArguments, scriptedResponse.toolArgumentChunkSize)) {
                    writeSse(
                        {
                            type: "response.function_call_arguments.delta",
                            sequence_number: sequenceNumber++,
                            item_id: toolItemId,
                            output_index: 0,
                            delta: argumentChunk,
                        },
                        "response.function_call_arguments.delta",
                    )
                }
            }
            writeSse({
                type: "error",
                sequence_number: sequenceNumber++,
                error: {
                    code: scriptedResponse.code,
                    message: scriptedResponse.message,
                    type: "upstream_error",
                    status: scriptedResponse.status,
                },
                ...(scriptedResponse.requestId ? { request_id: scriptedResponse.requestId } : {}),
            })
            writeSse(
                {
                    type: "response.failed",
                    sequence_number: sequenceNumber,
                    response: {
                        id: generationId,
                        object: "response",
                        created_at: Math.floor(Date.now() / 1000),
                        status: "failed",
                        model,
                        output: [],
                        error: {
                            code: scriptedResponse.failureCode ?? "upstream_error",
                            message: scriptedResponse.failureMessage ?? "Upstream request failed",
                        },
                    },
                },
                "response.failed",
            )
            res.end()
            return
        }
        if (reasoningItem) {
            writeSse(
                {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: { ...reasoningItem, status: "in_progress", summary: [] },
                },
                "response.output_item.added",
            )
            writeSse(
                {
                    type: "response.reasoning_summary_part.added",
                    item_id: reasoningItemId,
                    output_index: 0,
                    summary_index: 0,
                    part: { type: "summary_text", text: "" },
                },
                "response.reasoning_summary_part.added",
            )
            writeSse(
                {
                    type: "response.reasoning_summary_text.delta",
                    item_id: reasoningItemId,
                    output_index: 0,
                    summary_index: 0,
                    delta: scriptedResponse.reasoning,
                },
                "response.reasoning_summary_text.delta",
            )
            writeSse(
                {
                    type: "response.reasoning_summary_part.done",
                    item_id: reasoningItemId,
                    output_index: 0,
                    summary_index: 0,
                    part: reasoningItem.summary[0],
                },
                "response.reasoning_summary_part.done",
            )
            writeSse({ type: "response.output_item.done", output_index: 0, item: reasoningItem }, "response.output_item.done")
            if (!(await waitAfterReasoning())) return
        }
        // High-effort turns may stream many snapshots of each encrypted reasoning item.
        if (scriptedResponse.encryptedReasoningItemCount) {
            const encryptedPayload = "E".repeat(scriptedResponse.encryptedReasoningChunkSize ?? 1_292)
            const snapshotsPerItem = Math.max(1, scriptedResponse.encryptedReasoningSnapshotsPerItem ?? 1)
            for (let index = 0; index < scriptedResponse.encryptedReasoningItemCount; index++) {
                const encryptedItemId = `rs_${generationId}_${index}`
                for (let snapshot = 1; snapshot <= snapshotsPerItem; snapshot++) {
                    writeSse(
                        {
                            type: "response.output_item.added",
                            output_index: 0,
                            item: {
                                id: encryptedItemId,
                                type: "reasoning",
                                status: "in_progress",
                                summary: [],
                                encrypted_content: encryptedPayload.slice(
                                    0,
                                    Math.max(1, Math.floor((encryptedPayload.length * snapshot) / snapshotsPerItem)),
                                ),
                            },
                        },
                        "response.output_item.added",
                    )
                    if (res.destroyed || res.writableEnded) return
                }
                writeSse(
                    {
                        type: "response.output_item.done",
                        output_index: 0,
                        item: {
                            id: encryptedItemId,
                            type: "reasoning",
                            status: "completed",
                            summary: [],
                            encrypted_content: encryptedPayload,
                        },
                    },
                    "response.output_item.done",
                )
                if (res.destroyed || res.writableEnded) return
            }
            if (!(await waitForOpenConnection(scriptedResponse.afterEncryptedReasoningHoldMs))) return
        }
        for (const [index, hostedSearchOutputItem] of hostedSearchOutputItems.entries()) {
            const outputIndex = outputOffset + index
            const startedItem = { ...hostedSearchOutputItem, status: "in_progress" }
            writeSse(
                { type: "response.output_item.added", output_index: outputIndex, item: startedItem },
                "response.output_item.added",
            )
            for (const type of [
                "response.web_search_call.in_progress",
                "response.web_search_call.searching",
                "response.web_search_call.completed",
            ]) {
                writeSse({ type, item_id: hostedSearchOutputItem.id, output_index: outputIndex }, type)
            }
            writeSse(
                { type: "response.output_item.done", output_index: outputIndex, item: hostedSearchOutputItem },
                "response.output_item.done",
            )
        }
        for (const [index, hostedImageOutputItem] of hostedImageOutputItems.entries()) {
            const outputIndex = outputOffset + hostedSearchOutputItems.length + index
            writeSse(
                {
                    type: "response.output_item.added",
                    output_index: outputIndex,
                    item: { ...hostedImageOutputItem, status: "in_progress", result: null },
                },
                "response.output_item.added",
            )
            for (const type of ["response.image_generation_call.in_progress", "response.image_generation_call.generating"]) {
                writeSse({ type, item_id: hostedImageOutputItem.id, output_index: outputIndex }, type)
            }
            if (scriptedResponse.type === "hosted-image-generation") {
                for (const [partialImageIndex, partialImageB64] of (scriptedResponse.partialImages ?? []).entries()) {
                    const type = "response.image_generation_call.partial_image"
                    writeSse(
                        {
                            type,
                            item_id: hostedImageOutputItem.id,
                            output_index: outputIndex,
                            partial_image_b64: partialImageB64,
                            partial_image_index: partialImageIndex,
                        },
                        type,
                    )
                    if (!(await waitForOpenConnection(scriptedResponse.afterPartialImageDelayMs))) return
                }
            }
            const completedType = "response.image_generation_call.completed"
            writeSse({ type: completedType, item_id: hostedImageOutputItem.id, output_index: outputIndex }, completedType)
            writeSse(
                { type: "response.output_item.done", output_index: outputIndex, item: hostedImageOutputItem },
                "response.output_item.done",
            )
        }
        if (toolOutputItems.length > 0) {
            for (const [index, outputItem] of toolOutputItems.entries()) {
                const outputIndex = outputOffset + hostedSearchOutputItems.length + hostedImageOutputItems.length + index
                writeSse(
                    {
                        type: "response.output_item.added",
                        output_index: outputIndex,
                        item: { ...outputItem, arguments: "" },
                    },
                    "response.output_item.added",
                )
                const deltaArguments =
                    scriptedResponse.type === "truncated-tool"
                        ? outputItem.arguments.slice(0, scriptedResponse.truncateAfter)
                        : outputItem.arguments
                const argumentChunks = splitStreamText(deltaArguments, scriptedResponse.toolArgumentChunkSize)
                for (const argumentChunk of argumentChunks) {
                    writeSse(
                        {
                            type: "response.function_call_arguments.delta",
                            item_id: outputItem.id,
                            output_index: outputIndex,
                            delta: argumentChunk,
                        },
                        "response.function_call_arguments.delta",
                    )
                    if (!(await waitForOpenConnection(scriptedResponse.toolArgumentChunkDelayMs))) return
                }
                if (scriptedResponse.type === "tool-with-completion-snapshots") {
                    writeSse(
                        {
                            type: "response.function_call_arguments.done",
                            item_id: outputItem.id,
                            output_index: outputIndex,
                            name: outputItem.name,
                            arguments: outputItem.arguments,
                        },
                        "response.function_call_arguments.done",
                    )
                    writeSse(
                        { type: "response.output_item.done", output_index: outputIndex, item: outputItem },
                        "response.output_item.done",
                    )
                }
            }
            if (scriptedResponse.afterToolCompletionReasoning) {
                if (!(await waitForOpenConnection(scriptedResponse.afterToolCompletionDelayMs))) return
                const reasoningOutputIndex =
                    outputOffset + hostedSearchOutputItems.length + hostedImageOutputItems.length + toolOutputItems.length
                const postToolReasoningItem = {
                    id: `reasoning_after_tool_${generationId}`,
                    type: "reasoning",
                    status: "completed",
                    summary: [{ type: "summary_text", text: scriptedResponse.afterToolCompletionReasoning }],
                }
                writeSse(
                    {
                        type: "response.output_item.added",
                        output_index: reasoningOutputIndex,
                        item: { ...postToolReasoningItem, status: "in_progress", summary: [] },
                    },
                    "response.output_item.added",
                )
                writeSse(
                    {
                        type: "response.reasoning_summary_part.added",
                        item_id: postToolReasoningItem.id,
                        output_index: reasoningOutputIndex,
                        summary_index: 0,
                        part: { type: "summary_text", text: "" },
                    },
                    "response.reasoning_summary_part.added",
                )
                writeSse(
                    {
                        type: "response.reasoning_summary_text.delta",
                        item_id: postToolReasoningItem.id,
                        output_index: reasoningOutputIndex,
                        summary_index: 0,
                        delta: scriptedResponse.afterToolCompletionReasoning,
                    },
                    "response.reasoning_summary_text.delta",
                )
                writeSse(
                    {
                        type: "response.reasoning_summary_part.done",
                        item_id: postToolReasoningItem.id,
                        output_index: reasoningOutputIndex,
                        summary_index: 0,
                        part: postToolReasoningItem.summary[0],
                    },
                    "response.reasoning_summary_part.done",
                )
                writeSse(
                    {
                        type: "response.output_item.done",
                        output_index: reasoningOutputIndex,
                        item: postToolReasoningItem,
                    },
                    "response.output_item.done",
                )
                if (!(await waitForOpenConnection(scriptedResponse.afterToolCompletionHoldMs))) return
            }
        } else {
            const outputIndex = outputOffset + hostedSearchOutputItems.length + hostedImageOutputItems.length
            writeSse(
                { type: "response.output_item.added", output_index: outputIndex, item: messageOutputItem },
                "response.output_item.added",
            )
            for (const textDelta of explicitInstructionDeltas ?? [messageText]) {
                writeSse(
                    {
                        type: "response.output_text.delta",
                        item_id: messageOutputItem.id,
                        output_index: outputIndex,
                        content_index: 0,
                        delta: textDelta,
                    },
                    "response.output_text.delta",
                )
                if (explicitInstructionDeltas && !(await waitForOpenConnection(scriptedResponse.toolArgumentChunkDelayMs))) {
                    return
                }
            }
        }
        if (scriptedResponse.type === "truncated-tool") {
            writeSse(
                {
                    type: "response.incomplete",
                    response: { ...response, status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
                },
                "response.incomplete",
            )
            res.end()
            return
        }
        if (!(await waitForOpenConnection(scriptedResponse.beforeUsageDelayMs))) return
        writeSse({ type: "response.completed", response }, "response.completed")
        if (!(await waitForOpenConnection(scriptedResponse.afterUsageHoldMs))) return
        res.end()
        return
    }

    const messageUsage = {
        input_tokens: usage.inputTokens,
        output_tokens: 0,
        cache_creation_input_tokens: usage.cacheWriteTokens ?? 0,
        cache_read_input_tokens: usage.cacheReadTokens ?? 0,
        ...(scriptedResponse.type === "hosted-web-search"
            ? {
                  server_tool_use: { web_search_requests: scriptedResponse.actions?.length ?? 1, web_fetch_requests: 0 },
              }
            : {}),
    }
    const ordinaryContentBlocks =
        responseToolCalls.length > 0
            ? responseToolCalls.map((tool, index) => ({
                  id: tool.id ?? `toolu_${generationId}_${index}`,
                  type: "tool_use",
                  name: tool.name,
                  input: tool.arguments,
              }))
            : [{ type: "text", text: messageText }]
    const hostedSearchId =
        scriptedResponse.type === "hosted-web-search" ||
        scriptedResponse.type === "anthropic-orphan-web-search-result" ||
        scriptedResponse.type === "anthropic-deferred-web-search"
            ? (scriptedResponse.id ?? `srv_web_${generationId}`)
            : undefined
    const hostedResultBlock: Extract<HostedContentBlock, { type: "web_search_tool_result" }> | undefined =
        hostedSearchId &&
        (scriptedResponse.type === "hosted-web-search" || scriptedResponse.type === "anthropic-orphan-web-search-result")
            ? {
                  type: "web_search_tool_result",
                  tool_use_id: hostedSearchId,
                  content: scriptedResponse.results.map((result) => ({
                      type: "web_search_result",
                      url: result.url,
                      title: result.title,
                      ...(result.snippet ? { snippet: result.snippet } : {}),
                      page_age: null,
                      encrypted_content: `e2e:${result.url}`,
                  })),
                  caller: { type: "direct" },
              }
            : undefined
    const hostedContentBlocks: HostedContentBlock[] =
        scriptedResponse.type === "hosted-web-search" && hostedSearchId && hostedResultBlock
            ? [
                  {
                      type: "server_tool_use",
                      id: hostedSearchId,
                      name: "web_search",
                      input: { query: scriptedResponse.query },
                      caller: { type: "direct" },
                  },
                  hostedResultBlock,
              ]
            : scriptedResponse.type === "anthropic-orphan-web-search-result" && hostedResultBlock
              ? [hostedResultBlock]
              : scriptedResponse.type === "anthropic-deferred-web-search" && hostedSearchId
                ? [
                      {
                          type: "server_tool_use",
                          id: hostedSearchId,
                          name: "web_search",
                          input: { query: scriptedResponse.query },
                          caller: { type: "direct" },
                      },
                  ]
                : []
    const contentBlocks = [...hostedContentBlocks, ...ordinaryContentBlocks]
    const thinkingBlock = scriptedResponse.reasoning
        ? { type: "thinking", thinking: scriptedResponse.reasoning, signature: `e2e_signature_${generationId}` }
        : undefined
    if (stream === false) {
        return sendJson({
            id: generationId,
            type: "message",
            role: "assistant",
            model,
            content: thinkingBlock ? [thinkingBlock, ...contentBlocks] : contentBlocks,
            stop_reason: anthropicStopReason,
            stop_sequence: null,
            usage: { ...messageUsage, output_tokens: usage.outputTokens },
        })
    }

    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    })
    writeSse(
        {
            type: "message_start",
            message: {
                id: generationId,
                type: "message",
                role: "assistant",
                model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: messageUsage,
            },
        },
        "message_start",
    )
    if (scriptedResponse.type === "usage-then-error") {
        const code = scriptedResponse.code ?? `http_${scriptedResponse.status}`
        writeSse(
            {
                type: "error",
                error: { type: code, message: scriptedResponse.message, ...scriptedResponse.details },
                ...(scriptedResponse.requestId ? { request_id: scriptedResponse.requestId } : {}),
            },
            "error",
        )
        res.end()
        return
    }
    if (thinkingBlock) {
        writeSse(
            { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
            "content_block_start",
        )
        writeSse(
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: thinkingBlock.thinking } },
            "content_block_delta",
        )
        writeSse(
            { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: thinkingBlock.signature } },
            "content_block_delta",
        )
        writeSse({ type: "content_block_stop", index: 0 }, "content_block_stop")
        if (!(await waitAfterReasoning())) return
    }
    const contentBlockOffset = thinkingBlock ? 1 : 0
    for (const [index, block] of hostedContentBlocks.entries()) {
        const contentBlockIndex = contentBlockOffset + index
        const startBlock = block.type === "server_tool_use" ? { ...block, input: {} } : block
        writeSse({ type: "content_block_start", index: contentBlockIndex, content_block: startBlock }, "content_block_start")
        if (block.type === "server_tool_use") {
            writeSse(
                {
                    type: "content_block_delta",
                    index: contentBlockIndex,
                    delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
                },
                "content_block_delta",
            )
        }
        writeSse({ type: "content_block_stop", index: contentBlockIndex }, "content_block_stop")
    }
    const ordinaryContentBlockOffset = contentBlockOffset + hostedContentBlocks.length
    if (responseToolCalls.length > 0) {
        for (const [index, tool] of responseToolCalls.entries()) {
            const contentBlockIndex = ordinaryContentBlockOffset + index
            writeSse(
                {
                    type: "content_block_start",
                    index: contentBlockIndex,
                    content_block: {
                        id: tool.id ?? `toolu_${generationId}_${index}`,
                        type: "tool_use",
                        name: tool.name,
                        input: {},
                    },
                },
                "content_block_start",
            )
            const argumentChunks = splitStreamText(JSON.stringify(tool.arguments), scriptedResponse.toolArgumentChunkSize)
            for (const argumentChunk of argumentChunks) {
                writeSse(
                    {
                        type: "content_block_delta",
                        index: contentBlockIndex,
                        delta: { type: "input_json_delta", partial_json: argumentChunk },
                    },
                    "content_block_delta",
                )
                if (!(await waitForOpenConnection(scriptedResponse.toolArgumentChunkDelayMs))) return
            }
            writeSse({ type: "content_block_stop", index: contentBlockIndex }, "content_block_stop")
        }
    } else {
        const contentBlockIndex = ordinaryContentBlockOffset
        writeSse(
            { type: "content_block_start", index: contentBlockIndex, content_block: { type: "text", text: "" } },
            "content_block_start",
        )
        for (const textDelta of explicitInstructionDeltas ?? [messageText]) {
            writeSse(
                { type: "content_block_delta", index: contentBlockIndex, delta: { type: "text_delta", text: textDelta } },
                "content_block_delta",
            )
            if (explicitInstructionDeltas && !(await waitForOpenConnection(scriptedResponse.toolArgumentChunkDelayMs))) {
                return
            }
        }
        writeSse({ type: "content_block_stop", index: contentBlockIndex }, "content_block_stop")
    }
    if (!(await waitForOpenConnection(scriptedResponse.beforeUsageDelayMs))) return
    writeSse(
        {
            type: "message_delta",
            delta: { stop_reason: anthropicStopReason, stop_sequence: null },
            usage: { output_tokens: usage.outputTokens },
        },
        "message_delta",
    )
    if (!(await waitForOpenConnection(scriptedResponse.afterUsageHoldMs))) return
    writeSse({ type: "message_stop" }, "message_stop")
    res.end()
    return
}

import { ServerTool } from "@shared/proto/dline/models/metadata"
import type { ApiProviderStreamChunk } from "../transform/stream"

/** Immutable complete provider response assembled from streaming deltas. */
export interface AssembledProviderResponse {
    readonly chunks: readonly ApiProviderStreamChunk[]
}

/** Assemble provider deltas into one semantic response record. */
export class ProviderResponseAssembler {
    private readonly chunks: ApiProviderStreamChunk[] = []

    append(chunk: ApiProviderStreamChunk): void {
        if (chunk.type === "server_tool" && chunk.tool === ServerTool.IMAGE_GENERATION) {
            this.chunks.push({
                ...chunk,
                ...(chunk.result === undefined ? {} : { result: { redacted: "hosted_image_bytes" } }),
            })
            return
        }
        const lastIndex = this.chunks.length - 1
        const last = this.chunks[lastIndex]
        if (chunk.type === "text" && last?.type === "text") {
            this.chunks[lastIndex] = { ...last, ...chunk, text: `${last.text}${chunk.text}` }
            return
        }
        if (chunk.type === "reasoning" && last?.type === "reasoning") {
            this.chunks[lastIndex] = { ...last, ...chunk, reasoning: `${last.reasoning}${chunk.reasoning}` }
            return
        }
        if (chunk.type === "usage") {
            const usageIndex = this.chunks.findIndex((candidate) => candidate.type === "usage")
            if (usageIndex >= 0) {
                this.chunks[usageIndex] = chunk
                return
            }
        }
        if (chunk.type === "tool_calls") {
            const toolIndex = this.chunks.findIndex(
                (candidate) =>
                    candidate.type === "tool_calls" &&
                    candidate.function_id === chunk.function_id &&
                    candidate.tool_index === chunk.tool_index,
            )
            const existing = this.chunks[toolIndex]
            if (toolIndex >= 0 && existing?.type === "tool_calls") {
                this.chunks[toolIndex] = {
                    ...existing,
                    ...chunk,
                    tool_call: {
                        function: {
                            ...existing.tool_call.function,
                            ...chunk.tool_call.function,
                            name: chunk.tool_call.function.name ?? existing.tool_call.function.name,
                            arguments: `${existing.tool_call.function.arguments ?? ""}${chunk.tool_call.function.arguments ?? ""}`,
                        },
                    },
                }
                return
            }
        }
        this.chunks.push(chunk)
    }

    build(): AssembledProviderResponse {
        return { chunks: this.chunks.map((chunk) => structuredClone(chunk)) }
    }
}

import { appendApiConversationEvent } from "@core/storage/disk"
import type { ClineTool } from "@shared/tools"
import type { ClineStorageMessage } from "@/shared/messages/content"
import type { ApiStream } from "../transform/stream"
import { ProviderResponseAssembler } from "./ProviderResponseAssembler"

export interface ApiConversationRoundContext {
    taskId: string
    requestIndex: number
    provider: string
    model: string
    source?: "task" | "subagent"
}

/** Record the exact canonical input handed to a provider adapter. */
export async function recordProviderAdapterInput(
    context: ApiConversationRoundContext,
    input: { systemPrompt: string; messages: ClineStorageMessage[]; tools?: ClineTool[] },
): Promise<void> {
    await appendApiConversationEvent(context.taskId, {
        ts: Date.now(),
        requestIndex: context.requestIndex,
        direction: "request",
        stage: "provider_adapter_input",
        provider: context.provider,
        model: context.model,
        source: context.source ?? "task",
        payload: {
            systemPrompt: input.systemPrompt,
            messages: input.messages.map(({ role, content, provider_metadata, ts }) => ({
                role,
                content,
                provider_metadata,
                ts,
            })),
            tools: input.tools,
        },
    })
}

/** Record one complete provider response without delaying stream delivery. */
export function recordProviderAdapterOutput(context: ApiConversationRoundContext, stream: ApiStream): ApiStream {
    const recorded = (async function* (): ApiStream {
        const assembler = new ProviderResponseAssembler()
        let pendingWrite = Promise.resolve()
        const enqueue = (event: object) => {
            pendingWrite = pendingWrite.then(() => appendApiConversationEvent(context.taskId, event))
        }

        try {
            for await (const chunk of stream) {
                assembler.append(chunk)
                yield chunk
            }
            enqueue({
                ts: Date.now(),
                requestIndex: context.requestIndex,
                direction: "response",
                stage: "provider_adapter_output",
                provider: context.provider,
                model: context.model,
                source: context.source ?? "task",
                payload: assembler.build(),
            })
            enqueue({
                ts: Date.now(),
                requestIndex: context.requestIndex,
                direction: "response_end",
                provider: context.provider,
                model: context.model,
                source: context.source ?? "task",
                status: "completed",
            })
        } catch (error) {
            enqueue({
                ts: Date.now(),
                requestIndex: context.requestIndex,
                direction: "response_end",
                provider: context.provider,
                model: context.model,
                source: context.source ?? "task",
                status: "failed",
                error: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) },
            })
            throw error
        } finally {
            await pendingWrite
        }
    })() as ApiStream
    return recorded
}

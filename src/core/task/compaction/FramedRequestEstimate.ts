import { estimateContextWindowCandidateBreakdown } from "@core/context/context-management/context-window-projection"
import { getContextWindowInfo } from "@core/context/context-management/context-window-utils"
import type { SystemPromptComposition } from "@core/prompts/generators/system-prompt-composition"
import type { ClineStorageMessage } from "@shared/messages/content"
import type { ProviderRequestFramePort } from "../executors/provider/service/ProviderRequest"
import type { CompactionProviderInput } from "./CompactionProviderInput"

/** What one provider request would occupy, and the window it is measured against. */
export interface FramedRequestEstimate {
    readonly tokens: number
    readonly contextWindow: number
    readonly providerId?: string
    readonly modelId: string
    readonly apiFormat?: number
    readonly textBytes: number
    readonly mediaTokens: number
    /** The framed input that was measured, so its parts can be measured apart. */
    readonly input: CompactionProviderInput
    /** How the measured system prompt splits for display; kept beside the input, never estimated with it. */
    readonly systemPromptComposition?: SystemPromptComposition
}

/**
 * Estimate a request as the frame ordinary requests use would send it.
 *
 * The system prompt, tools, and server tools count against the window as much
 * as the messages do, so they are measured together; a figure that left them
 * out could not be compared with what the provider reports for the same request.
 */
export async function estimateFramedRequest(
    frames: ProviderRequestFramePort,
    messages: ClineStorageMessage[],
    signal: AbortSignal,
): Promise<FramedRequestEstimate> {
    const frame = await frames.frame(signal)
    const model = frame.api.getModel()
    const providerId = frame.api.getProviderId?.()
    const input: CompactionProviderInput = {
        systemPrompt: frame.systemPrompt,
        messages,
        tools: frame.tools,
        serverTools: frame.options?.serverTools ?? [],
    }
    const breakdown = estimateContextWindowCandidateBreakdown(input, { providerId, modelId: model.id })
    return {
        tokens: breakdown.totalTokens,
        contextWindow: getContextWindowInfo(frame.api).contextWindow,
        providerId,
        modelId: model.id,
        apiFormat: frame.api.getSelectedApiFormat?.(),
        textBytes: breakdown.textBytes,
        mediaTokens: breakdown.imageTokens,
        input,
        ...(frame.systemPromptComposition ? { systemPromptComposition: frame.systemPromptComposition } : {}),
    }
}

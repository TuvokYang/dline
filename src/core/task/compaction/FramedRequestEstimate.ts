import { estimateContextWindowCandidate } from "@core/context/context-management/context-window-projection"
import { getContextWindowInfo } from "@core/context/context-management/context-window-utils"
import type { ClineStorageMessage } from "@shared/messages/content"
import type { ProviderRequestFramePort } from "../executors/provider/service/ProviderRequest"

/** What one provider request would occupy, and the window it is measured against. */
export interface FramedRequestEstimate {
	readonly tokens: number
	readonly contextWindow: number
	readonly modelId: string
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
	const tokens = estimateContextWindowCandidate(
		{ systemPrompt: frame.systemPrompt, messages, tools: frame.tools, serverTools: frame.options?.serverTools ?? [] },
		{ providerId: frame.api.getProviderId?.(), modelId: model.id },
	)
	return { tokens, contextWindow: getContextWindowInfo(frame.api).contextWindow, modelId: model.id }
}

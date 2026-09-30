/**
 * OpenAI Codex (ChatGPT Plus/Pro subscription) model definitions.
 * GPT-6 entries verified against the official Codex model catalog (2026-09-30 UTC).
 */

import type { ModelInfo } from "@shared/api"
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"

/** Provider baseline used for newly listed Codex models that are not in the bundled catalog yet. */
export const openAiCodexModelInfoSaneDefaults: Omit<ModelInfo, "id"> = {
	apiFormats: [ApiFormat.OPENAI_RESPONSES, ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE],
	capabilities: {
		supportsTools: true,
		tools: [ServerTool.WEB_SEARCH],
		maxTokens: 128_000,
		contextWindow: 372_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoning: true,
		supportsStreaming: true,
	},
	pricing: { inputPrice: 0, outputPrice: 0 },
}

/** Subscription limits and costs remain provider-owned rather than copied from API-key pricing. */
function codexFrontierModel(id: string, details: Pick<ModelInfo, "name" | "description"> = {}): ModelInfo {
	return {
		id,
		...details,
		apiFormats: [...(openAiCodexModelInfoSaneDefaults.apiFormats ?? [])],
		capabilities: {
			...openAiCodexModelInfoSaneDefaults.capabilities,
			tools: [...(openAiCodexModelInfoSaneDefaults.capabilities?.tools ?? [])],
		},
		pricing: { ...openAiCodexModelInfoSaneDefaults.pricing },
	}
}

export const openAiCodexModels: Record<string, ModelInfo> = {
	"gpt-6.1-sol": codexFrontierModel("gpt-6.1-sol", { name: "GPT-6.1 Sol" }),
	"gpt-6-sol": codexFrontierModel("gpt-6-sol", { name: "GPT-6 Sol" }),
	"gpt-6-luna": codexFrontierModel("gpt-6-luna", { name: "GPT-6 Luna" }),
	"gpt-6-astra": codexFrontierModel("gpt-6-astra", {
		name: "GPT-6-Astra",
		description: "Our most capable model for complex, demanding work.",
	}),
	"gpt-5.6-sol": codexFrontierModel("gpt-5.6-sol"),
	"gpt-5.6-terra": codexFrontierModel("gpt-5.6-terra"),
	"gpt-5.6-luna": codexFrontierModel("gpt-5.6-luna"),
	"gpt-5.5": codexFrontierModel("gpt-5.5"),
}

/** Default model ID for OpenAI Codex provider. */
export const openAiCodexDefaultModelId = "gpt-5.6-sol"

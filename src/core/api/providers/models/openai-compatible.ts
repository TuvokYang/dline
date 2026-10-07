/**
 * OpenAI-compatible provider constants.
 */

import type { ModelInfo } from "@shared/api"
import { ApiFormat } from "@shared/proto/dline/models/metadata"

/** Default ModelInfo for OpenAI-compatible provider */
export const openAiModelInfoSaneDefaults: ModelInfo = {
	id: "",
	apiFormats: [ApiFormat.OPENAI_CHAT, ApiFormat.OPENAI_RESPONSES],
	capabilities: {
		supportsImages: true,
		supportsPromptCache: false,
		supportsTools: true,
		maxTokens: -1,
		contextWindow: 128_000,
	},
}

/** Default API version for Azure OpenAI */
export const azureOpenAiDefaultApiVersion = "2024-08-01-preview"

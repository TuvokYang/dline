import {
	ApiConfiguration,
	ApiProvider,
	anthropicDefaultModelId,
	anthropicModels,
	askSageModels,
	basetenModels,
	bedrockModels,
	cerebrasModels,
	claudeCodeModels,
	deepSeekModels,
	doubaoModels,
	fireworksModels,
	geminiModels,
	groqModels,
	huaweiCloudMaasModels,
	huggingFaceModels,
	internationalQwenModels,
	internationalZAiModels,
	ModelInfo,
	minimaxModels,
	mistralModels,
	moonshotModels,
	nebiusModels,
	nousResearchModels,
	openAiCodexModels,
	qwenCodeModels,
	sambanovaModels,
	sapAiCoreModels,
	vertexModels,
	wandbModels,
	xaiModels,
} from "@shared/api"
import { Mode } from "@shared/storage/types"
/**
 * Returns the static model list for a provider.
 * For providers with dynamic models (openrouter, cline, ollama, etc.), returns undefined.
 * Some providers depend on configuration (qwen, zai) for region-specific models.
 */
export function getModelsForProvider(
	provider: ApiProvider,
	_apiConfiguration?: ApiConfiguration,
	dynamicModels: { liteLlmModels?: Record<string, ModelInfo>; basetenModels?: Record<string, ModelInfo> } = {},
): Record<string, ModelInfo> | undefined {
	switch (provider) {
		case "anthropic":
			return anthropicModels
		case "claude-code":
			return claudeCodeModels
		case "bedrock":
			return bedrockModels
		case "vertex":
			return vertexModels
		case "gemini":
			return geminiModels
		case "openai-codex":
			return openAiCodexModels
		case "deepseek":
			return deepSeekModels
		case "qwen":
			return internationalQwenModels
		case "qwen-code":
			return qwenCodeModels
		case "doubao":
			return doubaoModels
		case "mistral":
			return mistralModels
		case "asksage":
			return askSageModels
		case "xai":
			return xaiModels
		case "moonshot":
			return moonshotModels
		case "nebius":
			return nebiusModels
		case "wandb":
			return wandbModels
		case "sambanova":
			return sambanovaModels
		case "cerebras":
			return cerebrasModels
		case "groq":
			return groqModels
		case "baseten":
			return dynamicModels?.basetenModels || basetenModels
		case "sapaicore":
			return sapAiCoreModels
		case "huawei-cloud-maas":
			return huaweiCloudMaasModels
		case "zai":
			return internationalZAiModels
		case "fireworks":
			return fireworksModels
		case "minimax":
			return minimaxModels
		case "huggingface":
			return huggingFaceModels
		case "nousResearch":
			return nousResearchModels
		case "litellm":
			return dynamicModels?.liteLlmModels
		default:
			return undefined
	}
}

/**
 * Interface for normalized API configuration
 */
export interface NormalizedApiConfig {
	selectedProvider: ApiProvider
	selectedModelId: string
	selectedModelInfo: ModelInfo
}

/**
 * Normalizes API configuration to ensure consistent values
 */
/**
 * @deprecated Profile-driven: use useProviderModels + useApiProfiles instead.
 * Returns a default config — all provider-specific logic is now in ApiProfile.
 */
export function normalizeApiConfiguration(
	_apiConfiguration: ApiConfiguration | undefined,
	_currentMode: Mode,
): NormalizedApiConfig {
	return {
		selectedProvider: "anthropic" as ApiProvider,
		selectedModelId: anthropicDefaultModelId,
		selectedModelInfo: anthropicModels[anthropicDefaultModelId],
	}
}

/**
 * @deprecated Profile-driven: use useApiProfiles + useProviderModels instead.
 * Returns empty defaults — all fields sourced from ApiProfile now.
 */
export function getModeSpecificFields(_apiConfiguration: ApiConfiguration | undefined, _mode: Mode): Record<string, any> {
	return {
		apiProvider: undefined,
		apiModelId: undefined,
	}
}

/**
 * @deprecated Profile-driven: plan/act mode sync now operates on ApiProfile.usedFor.
 */
export async function syncModeConfigurations(
	_apiConfiguration: ApiConfiguration | undefined,
	_sourceMode: Mode,
	_handleFieldsChange: (updates: Partial<ApiConfiguration>) => Promise<void>,
): Promise<void> {
	// No-op: profile-driven architecture handles mode sync via ApiProfile.usedFor
}

export { filterOpenRouterModelIds } from "@shared/utils/model-filters"

/**
 * @deprecated Profile-driven: baseUrl and modelId now come from ApiProfile.
 */
export const getProviderInfo = (
	_provider: ApiProvider,
	_apiConfiguration: any,
	_effectiveMode: "plan" | "act",
): { modelId?: string; baseUrl?: string; helpText: string } => {
	return {
		modelId: undefined,
		baseUrl: undefined,
		helpText: "Configure this provider in model settings",
	}
}

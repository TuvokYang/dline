import { LiteLLMModelInfo, ModelInfo, OcaModelInfo } from "@shared/api"
import {
	OpenRouterModelInfo,
	LiteLLMModelInfo as ProtoLiteLLMModelInfo,
	ModelInfo as ProtoModelInfo,
	OcaModelInfo as ProtoOcaModelInfo,
	OpenAiCompatibleModelInfo as ProtoOpenAiCompatibleModelInfo,
} from "@shared/proto/dline/models"
import { ThinkingConfig } from "@shared/proto/dline/models/metadata"

/** Preserve declarations without deriving support or mode from a budget value. */
function convertThinkingConfig(protoConfig: ThinkingConfig | undefined): ThinkingConfig | undefined {
	return protoConfig
		? { ...protoConfig, effortLevels: protoConfig.effortLevels === undefined ? undefined : [...protoConfig.effortLevels] }
		: undefined
}

function toProtobufThinkingConfig(appConfig: ThinkingConfig | undefined): ThinkingConfig | undefined {
	return appConfig ? ThinkingConfig.create(appConfig) : undefined
}

/** Read the complete declaration, falling back to the legacy projection only when absent. */
export function fromProtobufModelInfo(protoInfo: OpenRouterModelInfo): ModelInfo {
	if (protoInfo.modelInfo) return ProtoModelInfo.fromPartial(protoInfo.modelInfo)
	return {
		id: "", // id resolved from map key by caller
		capabilities: {
			supportsImages: protoInfo.supportsImages ?? false,
			supportsPromptCache: protoInfo.supportsPromptCache ?? false,
			supportsReasoning: protoInfo.supportsReasoning ?? undefined,
			supportsGlobalEndpoint: protoInfo.supportsGlobalEndpoint ?? undefined,
			maxTokens: protoInfo.maxTokens ?? undefined,
			contextWindow: protoInfo.contextWindow ?? undefined,
			thinking: convertThinkingConfig(protoInfo.thinkingConfig),
		},
		pricing: {
			inputPrice: protoInfo.inputPrice,
			outputPrice: protoInfo.outputPrice,
			cacheWritesPrice: protoInfo.cacheWritesPrice,
			cacheReadsPrice: protoInfo.cacheReadsPrice,
			tiers: protoInfo.tiers.length > 0 ? protoInfo.tiers : undefined,
		},
		description: protoInfo.description,
		name: protoInfo.name,
		temperature: protoInfo.temperature,
		apiFormats: protoInfo.apiFormat !== undefined ? [protoInfo.apiFormat] : undefined,
	}
}

/**
 * Convert application ModelInfo to protobuf OpenRouterModelInfo
 */
export function toProtobufModelInfo(modelInfo: ModelInfo): OpenRouterModelInfo {
	return OpenRouterModelInfo.create({
		modelInfo: ProtoModelInfo.fromPartial(modelInfo),
		name: modelInfo.name,
		temperature: modelInfo.temperature,
		apiFormat: modelInfo.apiFormats?.[0],
		currency: modelInfo.pricing?.currency,
		maxTokens: modelInfo.capabilities?.maxTokens,
		contextWindow: modelInfo.capabilities?.contextWindow,
		supportsImages: modelInfo.capabilities?.supportsImages,
		supportsPromptCache: modelInfo.capabilities?.supportsPromptCache,
		supportsReasoning: modelInfo.capabilities?.supportsReasoning,
		inputPrice: modelInfo.pricing?.inputPrice,
		outputPrice: modelInfo.pricing?.outputPrice,
		cacheWritesPrice: modelInfo.pricing?.cacheWritesPrice,
		cacheReadsPrice: modelInfo.pricing?.cacheReadsPrice,
		description: modelInfo.description,
		thinkingConfig: toProtobufThinkingConfig(modelInfo.capabilities?.thinking),
		supportsGlobalEndpoint: modelInfo.capabilities?.supportsGlobalEndpoint,
		tiers: modelInfo.pricing?.tiers || [],
	})
}

/**
 * Convert protobuf OpenAiCompatibleModelInfo to application OpenAiCompatibleModelInfo
 */
export function fromProtobufOpenAiCompatibleModelInfo(protoInfo: ProtoOpenAiCompatibleModelInfo): ModelInfo {
	return {
		id: "",
		capabilities: {
			supportsImages: protoInfo.supportsImages ?? false,
			supportsPromptCache: protoInfo.supportsPromptCache ?? false,
			maxTokens: protoInfo.maxTokens ?? undefined,
			contextWindow: protoInfo.contextWindow ?? undefined,
			thinking: convertThinkingConfig(protoInfo.thinkingConfig),
		},
		pricing: {
			inputPrice: protoInfo.inputPrice,
			outputPrice: protoInfo.outputPrice,
			cacheWritesPrice: protoInfo.cacheWritesPrice,
			cacheReadsPrice: protoInfo.cacheReadsPrice,
			tiers: protoInfo.tiers.length > 0 ? protoInfo.tiers : undefined,
		},
		description: protoInfo.description,
		temperature: protoInfo.temperature,
	}
}

export function fromProtobufLiteLLMModelInfo(protoInfo: ProtoLiteLLMModelInfo): LiteLLMModelInfo {
	return {
		id: "",
		capabilities: {
			supportsImages: protoInfo.supportsImages ?? false,
			supportsPromptCache: protoInfo.supportsPromptCache ?? false,
			supportsReasoning: protoInfo.supportsReasoning ?? undefined,
			supportsGlobalEndpoint: protoInfo.supportsGlobalEndpoint ?? undefined,
			maxTokens: protoInfo.maxTokens ?? undefined,
			contextWindow: protoInfo.contextWindow ?? undefined,
			thinking: convertThinkingConfig(protoInfo.thinkingConfig),
		},
		pricing: {
			inputPrice: protoInfo.inputPrice,
			outputPrice: protoInfo.outputPrice,
			cacheWritesPrice: protoInfo.cacheWritesPrice,
			cacheReadsPrice: protoInfo.cacheReadsPrice,
			tiers: protoInfo.tiers.length > 0 ? protoInfo.tiers : undefined,
		},
		description: protoInfo.description,
		temperature: protoInfo.temperature,
	}
}

/**
 * Convert protobuf OcaModelInfo to application OcaModelInfo
 */
export function fromProtobufOcaModelInfo(protoInfo: ProtoOcaModelInfo): OcaModelInfo {
	return {
		id: "",
		capabilities: {
			supportsImages: protoInfo.supportsImages ?? false,
			supportsPromptCache: protoInfo.supportsPromptCache ?? false,
			supportsReasoning: protoInfo.supportsReasoning ?? undefined,
			maxTokens: protoInfo.maxTokens ?? undefined,
			contextWindow: protoInfo.contextWindow ?? undefined,
			thinking: convertThinkingConfig(protoInfo.thinkingConfig),
		},
		pricing: {
			inputPrice: protoInfo.inputPrice,
			outputPrice: protoInfo.outputPrice,
			cacheWritesPrice: protoInfo.cacheWritesPrice,
			cacheReadsPrice: protoInfo.cacheReadsPrice,
		},
		description: protoInfo.description,
		temperature: protoInfo.temperature,
		apiFormats: protoInfo.apiFormat !== undefined ? [protoInfo.apiFormat] : undefined,
		modelName: protoInfo.modelName,
		surveyId: protoInfo.surveyId,
		banner: protoInfo.banner,
		surveyContent: protoInfo.surveyContent,
		reasoningEffortOptions: protoInfo.reasoningEffortOptions,
	}
}

/**
 * Convert a record of protobuf models to application models
 */
export function fromProtobufModels(protoModels: Record<string, OpenRouterModelInfo>): Record<string, ModelInfo> {
	const result: Record<string, ModelInfo> = {}
	for (const [key, value] of Object.entries(protoModels)) {
		result[key] = { ...fromProtobufModelInfo(value), id: key }
	}
	return result
}

/**
 * Convert a record of application models to protobuf models
 */
export function toProtobufModels(models: Record<string, ModelInfo>): Record<string, OpenRouterModelInfo> {
	const result: Record<string, OpenRouterModelInfo> = {}
	for (const [key, value] of Object.entries(models)) {
		result[key] = toProtobufModelInfo(value)
	}
	return result
}

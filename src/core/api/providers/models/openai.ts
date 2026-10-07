/**
 * OpenAI provider model definitions.
 * GPT-6 metadata verified against official OpenAI model pages (2026-09-30 UTC).
 */

import type { ModelInfo } from "@shared/api"
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"

type FrontierPrices = {
	inputPrice: number
	outputPrice: number
	cacheReadsPrice?: number
	cacheWritesPrice?: number
}

type FrontierOptions = Pick<ModelInfo, "name" | "temperature" | "apiFormats"> & {
	contextWindow?: number
	supportsStreaming?: boolean
	effortLevels?: readonly string[]
	defaultEffort?: string
	defaultEnabled?: boolean
	canDisable?: boolean
	usagePricing?: boolean
}

/** The 272K boundary selects a usage price band, not a selectable context window. */
function usagePricing(prices: FrontierPrices): NonNullable<ModelInfo["pricing"]> {
	const longContext: FrontierPrices = {
		...prices,
		inputPrice: prices.inputPrice * 2,
		outputPrice: prices.outputPrice * 1.5,
	}
	if (prices.cacheReadsPrice !== undefined) longContext.cacheReadsPrice = prices.cacheReadsPrice * 2
	if (prices.cacheWritesPrice !== undefined) longContext.cacheWritesPrice = prices.cacheWritesPrice * 2
	return {
		...prices,
		tiers: [
			{ contextWindow: 272_000, ...prices },
			{ contextWindow: 1_050_000, ...longContext },
		],
	}
}

/** Keep model-specific protocol, reasoning and pricing differences explicit at each declaration. */
function frontierModel(id: string, prices: FrontierPrices, options: FrontierOptions = {}): ModelInfo {
	return {
		id,
		...(options.name !== undefined ? { name: options.name } : {}),
		...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
		apiFormats: [...(options.apiFormats ?? [ApiFormat.OPENAI_RESPONSES])],
		capabilities: {
			supportsTools: true,
			tools: [ServerTool.WEB_SEARCH, ServerTool.IMAGE_GENERATION],
			maxTokens: 128_000,
			contextWindow: options.contextWindow ?? 1_050_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			supportsStreaming: options.supportsStreaming ?? true,
			...(options.effortLevels
				? {
						thinking: {
							supported: true,
							mode: "effort",
							effortLevels: [...options.effortLevels],
							...(options.defaultEffort !== undefined ? { defaultEffort: options.defaultEffort } : {}),
							...(options.defaultEnabled !== undefined ? { defaultEnabled: options.defaultEnabled } : {}),
							...(options.canDisable !== undefined ? { canDisable: options.canDisable } : {}),
						},
					}
				: {}),
		},
		pricing: options.usagePricing ? usagePricing(prices) : { ...prices },
	}
}

const legacyOptions: FrontierOptions = {
	apiFormats: [ApiFormat.OPENAI_RESPONSES, ApiFormat.OPENAI_CHAT],
	temperature: 1,
}

// Effort/default declarations verified on the corresponding API model pages (2026-10-01).
const gpt56Thinking: FrontierOptions = {
	effortLevels: ["none", "low", "medium", "high", "xhigh", "max"],
	defaultEffort: "medium",
	defaultEnabled: true,
	canDisable: true,
}
const gpt54Thinking: FrontierOptions = {
	effortLevels: ["none", "low", "medium", "high", "xhigh"],
	defaultEffort: "none",
	defaultEnabled: false,
	canDisable: true,
}

export const openAiModels: Record<string, ModelInfo> = {
	// GPT-6 Responses supports tool calling across the listed efforts. Prices are per million tokens.
	"gpt-6.1-sol": frontierModel(
		"gpt-6.1-sol",
		{ inputPrice: 2, outputPrice: 10, cacheReadsPrice: 0.1, cacheWritesPrice: 2.5 },
		{
			name: "GPT-6.1 Sol",
			effortLevels: ["low", "medium", "high", "xhigh", "max"],
			defaultEffort: "medium",
			defaultEnabled: true,
			canDisable: false,
			usagePricing: true,
		},
	),
	"gpt-6-astra": frontierModel(
		"gpt-6-astra",
		{ inputPrice: 10, outputPrice: 50, cacheReadsPrice: 1, cacheWritesPrice: 12.5 },
		{
			name: "GPT-6 Astra",
			effortLevels: ["low", "medium", "high", "xhigh", "max"],
			defaultEnabled: true,
			canDisable: false,
			usagePricing: true,
		},
	),
	"gpt-6-sol": frontierModel(
		"gpt-6-sol",
		{ inputPrice: 2, outputPrice: 10, cacheReadsPrice: 0.2, cacheWritesPrice: 2.5 },
		{ ...gpt56Thinking, name: "GPT-6 Sol", usagePricing: true },
	),
	"gpt-6-luna": frontierModel(
		"gpt-6-luna",
		{ inputPrice: 0.1, outputPrice: 0.5, cacheReadsPrice: 0.01, cacheWritesPrice: 0.125 },
		{ ...gpt56Thinking, name: "GPT-6 Luna", usagePricing: true },
	),
	"gpt-5.6-sol": frontierModel(
		"gpt-5.6-sol",
		{ inputPrice: 5, outputPrice: 30, cacheWritesPrice: 6.25, cacheReadsPrice: 0.5 },
		{ ...legacyOptions, ...gpt56Thinking, contextWindow: 272_000, usagePricing: true },
	),
	"gpt-5.6-terra": frontierModel(
		"gpt-5.6-terra",
		{ inputPrice: 2.5, outputPrice: 15, cacheWritesPrice: 3.125, cacheReadsPrice: 0.25 },
		{ ...legacyOptions, ...gpt56Thinking, contextWindow: 272_000, usagePricing: true },
	),
	"gpt-5.6-luna": frontierModel(
		"gpt-5.6-luna",
		{ inputPrice: 1, outputPrice: 6, cacheWritesPrice: 1.25, cacheReadsPrice: 0.1 },
		{ ...legacyOptions, ...gpt56Thinking, contextWindow: 272_000, usagePricing: true },
	),
	"gpt-5.5": frontierModel(
		"gpt-5.5",
		{ inputPrice: 5, outputPrice: 30, cacheReadsPrice: 0.5 },
		{
			...legacyOptions,
			effortLevels: ["none", "low", "medium", "high", "xhigh"],
			defaultEffort: "medium",
			defaultEnabled: true,
			canDisable: true,
		},
	),
	"gpt-5.5-pro": frontierModel(
		"gpt-5.5-pro",
		{ inputPrice: 30, outputPrice: 180 },
		{
			...legacyOptions,
			supportsStreaming: false,
			effortLevels: ["medium", "high", "xhigh"],
			defaultEffort: "high",
			defaultEnabled: true,
			canDisable: false,
		},
	),
	"gpt-5.4": frontierModel(
		"gpt-5.4",
		{ inputPrice: 2.5, outputPrice: 15, cacheReadsPrice: 0.25 },
		{
			...legacyOptions,
			...gpt54Thinking,
		},
	),
	"gpt-5.4-pro": frontierModel(
		"gpt-5.4-pro",
		{ inputPrice: 30, outputPrice: 180 },
		{
			...legacyOptions,
			effortLevels: ["medium", "high", "xhigh"],
			defaultEffort: "medium",
			defaultEnabled: true,
			canDisable: false,
		},
	),
	"gpt-5.4-mini": frontierModel(
		"gpt-5.4-mini",
		{ inputPrice: 0.75, outputPrice: 4.5, cacheReadsPrice: 0.075 },
		{ ...legacyOptions, ...gpt54Thinking, contextWindow: 272_000 },
	),
	"gpt-5.4-nano": frontierModel(
		"gpt-5.4-nano",
		{ inputPrice: 0.2, outputPrice: 1.25, cacheReadsPrice: 0.02 },
		{ ...legacyOptions, ...gpt54Thinking, contextWindow: 272_000 },
	),
}

/** Default model ID for the OpenAI API-key provider. */
export const openAiDefaultModelId = "gpt-5.6-sol"

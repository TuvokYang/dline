import { anthropicModels } from "@core/api/providers/models/anthropic"
import { deepSeekModels } from "@core/api/providers/models/deepseek"
import { openAiCodexModels } from "@core/api/providers/models/openai-codex"
import { ApiFormat } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import { AnthropicProviderConfig } from "@shared/proto/dline/provider/anthropic"
import { BaseProviderConfig } from "@shared/proto/dline/provider/common"
import { OpenAiProviderConfig } from "@shared/proto/dline/provider/openai"
import { OpenAiCodexProviderConfig } from "@shared/proto/dline/provider/openai_codex"
import { expect } from "chai"
import { describe, it } from "vitest"
import { resolveProfileModelInfo } from "../profile-model-info"

describe("resolveProfileModelInfo", () => {
	it("does not relabel stale thinking metadata as the newly selected unknown model", () => {
		const profile = ApiProfile.create({
			provider: "openai",
			modelId: "new-unknown",
			modelInfo: {
				id: "old-known",
				capabilities: { thinking: { supported: true, mode: "effort", effortLevels: ["low"] } },
			},
		})
		const result = resolveProfileModelInfo(profile)
		expect(result.id).to.equal("new-unknown")
		expect(result.capabilities?.thinking).to.equal(undefined)
	})

	it("keeps a matching explicit negative/empty declaration intact", () => {
		const profile = ApiProfile.create({
			provider: "openai",
			modelId: "matching-alias",
			modelInfo: {
				id: "matching-alias",
				capabilities: { thinking: { supported: false, mode: "effort", effortLevels: [] } },
			},
		})
		const result = resolveProfileModelInfo(profile)
		expect(result.capabilities?.thinking).to.deep.equal(profile.modelInfo?.capabilities?.thinking)
	})

	it("uses the explicit metadata identity before an unrelated provider default", () => {
		const profile = ApiProfile.create({
			provider: "openai",
			modelInfo: { id: "explicit-alias", capabilities: { thinking: { supported: false } } },
		})
		const result = resolveProfileModelInfo(profile, {
			defaultModelId: "other-default",
			models: { "other-default": { id: "other-default", capabilities: { thinking: { supported: true, mode: "budget" } } } },
		})
		expect(result.id).to.equal("explicit-alias")
		expect(result.capabilities?.thinking?.supported).to.equal(false)
	})
	it("resolves an explicitly selected Bedrock base and preserves the custom ARN and override", () => {
		const profile = ApiProfile.create({
			provider: "bedrock",
			modelId: "arn:aws:bedrock:test:custom-model/example",
			bedrock: {
				awsBedrockCustomSelected: true,
				awsBedrockCustomModelBaseId: "known-base",
				capabilities: { thinking: { defaultEnabled: true } },
			},
		})
		const result = resolveProfileModelInfo(profile, {
			defaultModelId: "other-default",
			models: {
				"known-base": {
					id: "known-base",
					capabilities: { thinking: { supported: true, mode: "effort", effortLevels: ["low"] } },
				},
			},
		})
		expect(result.id).to.equal(profile.modelId)
		expect(result.capabilities?.thinking).to.deep.equal({
			supported: true,
			mode: "effort",
			effortLevels: ["low"],
			defaultEnabled: true,
		})
	})

	it("resolves DeepSeek context window from registry when profile modelInfo is absent", () => {
		const profile = ApiProfile.create({
			provider: "deepseek",
			modelId: "deepseek-v4-pro",
			deepseek: BaseProviderConfig.create(),
		})

		const result = resolveProfileModelInfo(profile, {
			models: deepSeekModels,
			defaultModelId: "deepseek-v4-pro",
		})

		expect(result.id).to.equal("deepseek-v4-pro")
		expect(result.capabilities?.contextWindow).to.equal(1_000_000)
		expect(result.capabilities?.supportsPromptCache).to.equal(true)
	})

	it("uses the enabled prompt-cache product default when custom metadata omits the capability", () => {
		const profile = ApiProfile.create({
			provider: "openai",
			modelId: "custom-model",
			openai: OpenAiProviderConfig.create(),
		})

		const result = resolveProfileModelInfo(profile)

		expect(result.capabilities?.supportsPromptCache).to.equal(true)
	})

	it("does not inherit the provider default model metadata for an explicit custom model id", () => {
		const profile = ApiProfile.create({
			provider: "openai",
			modelId: "custom-model",
			openai: OpenAiProviderConfig.create({
				customModelEnabled: true,
				capabilities: {
					contextWindow: 131_072,
					maxTokens: 8_192,
				},
			}),
		})

		const result = resolveProfileModelInfo(profile, {
			models: {
				"default-model": {
					id: "default-model",
					name: "Provider Default",
					capabilities: {
						contextWindow: 272_000,
						contextWindowTiers: [
							{ id: "standard", contextWindow: 272_000, label: "272K" },
							{ id: "long", contextWindow: 1_050_000, label: "1.05M" },
						],
					},
				},
			},
			defaultModelId: "default-model",
		})

		expect(result.id).to.equal("custom-model")
		expect(result.name).to.equal(undefined)
		expect(result.capabilities?.contextWindow).to.equal(131_072)
	})

	it("preserves an explicit prompt-cache opt-out", () => {
		const profile = ApiProfile.create({
			provider: "openai",
			modelId: "custom-model",
			openai: OpenAiProviderConfig.create({ capabilities: { supportsPromptCache: false } }),
		})

		const result = resolveProfileModelInfo(profile)

		expect(result.capabilities?.supportsPromptCache).to.equal(false)
	})

	it("merges provider capability overrides into registry metadata", () => {
		const profile = ApiProfile.create({
			provider: "deepseek",
			modelId: "deepseek-v4-pro",
			deepseek: BaseProviderConfig.create({
				capabilities: {
					contextWindow: 272_000,
					maxTokens: 128_000,
				},
			}),
		})

		const result = resolveProfileModelInfo(profile, {
			models: deepSeekModels,
			defaultModelId: "deepseek-v4-pro",
		})

		expect(result.id).to.equal("deepseek-v4-pro")
		expect(result.capabilities?.contextWindow).to.equal(272_000)
		expect(result.capabilities?.maxTokens).to.equal(128_000)
		expect(result.capabilities?.supportsReasoning).to.equal(true)
	})

	it("applies Codex capability overrides and prioritizes the selected Responses transport", () => {
		const profile = ApiProfile.create({
			provider: "openai-codex",
			modelId: "gpt-6-astra",
			openaiCodex: OpenAiCodexProviderConfig.create({
				apiFormat: ApiFormat.OPENAI_RESPONSES,
				websocketEnabled: true,
				capabilities: { contextWindow: 400_000, maxTokens: 64_000 },
			}),
		})

		const result = resolveProfileModelInfo(profile, {
			models: openAiCodexModels,
			defaultModelId: "gpt-6-astra",
		})

		expect(result.capabilities?.contextWindow).to.equal(400_000)
		expect(result.capabilities?.maxTokens).to.equal(64_000)
		expect(result.apiFormats).to.deep.equal([ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE, ApiFormat.OPENAI_RESPONSES])
	})

	it("uses the native 1M context for Anthropic profiles without an explicit flag", () => {
		const profile = ApiProfile.create({
			provider: "anthropic",
			modelId: "claude-sonnet-4-6",
			anthropic: AnthropicProviderConfig.create(),
		})

		const result = resolveProfileModelInfo(profile, {
			models: anthropicModels,
			defaultModelId: "claude-sonnet-4-6",
		})

		expect(result.capabilities?.contextWindow).to.equal(1_000_000)
	})

	it("uses the selected tier window instead of a standalone context override for custom models", () => {
		const profile = ApiProfile.create({
			provider: "anthropic",
			modelId: "vendor-tiered",
			anthropic: AnthropicProviderConfig.create({
				enableLongContext: false,
				capabilities: {
					contextWindow: 999_999,
					contextWindowTiers: [
						{ id: "standard", contextWindow: 160_000, label: "160K" },
						{ id: "long", contextWindow: 1_500_000, label: "1.5M", apiModelSuffix: ":1m" },
					],
				},
			}),
		})

		const result = resolveProfileModelInfo(profile)

		expect(result.capabilities?.contextWindow).to.equal(160_000)
	})

	it("allows a custom selected long tier window to exceed one million tokens", () => {
		const profile = ApiProfile.create({
			provider: "anthropic",
			modelId: "vendor-tiered",
			anthropic: AnthropicProviderConfig.create({
				enableLongContext: true,
				capabilities: {
					contextWindowTiers: [
						{ id: "standard", contextWindow: 200_000, label: "200K" },
						{ id: "long", contextWindow: 1_500_000, label: "1.5M", apiModelSuffix: ":1m" },
					],
				},
			}),
		})

		const result = resolveProfileModelInfo(profile)

		expect(result.capabilities?.contextWindow).to.equal(1_500_000)
	})

	it("falls back to a custom standard tier when long context is explicitly disabled", () => {
		const profile = ApiProfile.create({
			provider: "anthropic",
			modelId: "vendor-tiered",
			anthropic: AnthropicProviderConfig.create({
				enableLongContext: false,
				capabilities: {
					contextWindowTiers: [
						{ id: "standard", contextWindow: 200_000, label: "200K" },
						{ id: "long", contextWindow: 1_000_000, label: "1M", apiModelSuffix: ":1m" },
					],
				},
			}),
		})

		const result = resolveProfileModelInfo(profile)

		expect(result.capabilities?.contextWindow).to.equal(200_000)
	})
})

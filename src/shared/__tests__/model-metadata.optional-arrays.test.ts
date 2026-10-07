import { ModelInfo, OpenRouterCompatibleModelInfo } from "@shared/proto/dline/models"
import { ApiFormat, ModelCapabilities, ModelPricing, ServerTool, ThinkingConfig } from "@shared/proto/dline/models/metadata"
import { fromProtobufModels, toProtobufModels } from "@shared/proto-conversions/models/typeConversion"
import { describe, expect, it } from "vitest"

describe("optional repeated model metadata", () => {
	it("preserves complete capability declarations through the dynamic-model binary boundary", () => {
		const id = "opaque/wire-fixture"
		const capabilities = {
			supportsReasoning: false,
			supportsForcedToolUse: false,
			thinking: {
				supported: false,
				mode: "effort",
				maxBudget: 7,
				effortLevels: ["declared-effort"],
				defaultEnabled: false,
				canDisable: false,
				defaultEffort: "declared-effort",
			},
		}
		const wire = toProtobufModels({ [id]: { id, capabilities } })
		const decoded = OpenRouterCompatibleModelInfo.decode(OpenRouterCompatibleModelInfo.encode({ models: wire }).finish())
		const restored = fromProtobufModels(decoded.models)[id]

		expect(restored.id).toBe(id)
		expect(restored.capabilities).toMatchObject(capabilities)
	})

	it.each([0, 128])("preserves a declared minimum budget %s through JSON, binary and dynamic DTO transport", (minimum) => {
		const thinking = ThinkingConfig.fromJSON({
			supported: false,
			mode: "budget",
			minBudget: minimum,
			effortLevels: ["declared-effort"],
		})
		const id = "opaque/minimum-fixture"
		const models = toProtobufModels({ [id]: { id, capabilities: { thinking } } })
		const decoded = OpenRouterCompatibleModelInfo.decode(OpenRouterCompatibleModelInfo.encode({ models }).finish())
		for (const restored of [
			ThinkingConfig.decode(ThinkingConfig.encode(thinking).finish()),
			ThinkingConfig.fromJSON(ThinkingConfig.toJSON(thinking)),
			fromProtobufModels(decoded.models)[id].capabilities?.thinking,
		]) {
			expect(restored).toHaveProperty("minBudget", minimum)
			expect(restored?.supported).toBe(false)
			expect(restored?.effortLevels).toEqual(["declared-effort"])
		}
		const empty = ThinkingConfig.create({ supported: false, minBudget: minimum, effortLevels: [] })
		const objectModels = toProtobufModels({ [id]: { id, capabilities: { thinking: empty } } })
		for (const restored of [
			ThinkingConfig.fromJSON(ThinkingConfig.toJSON(empty)),
			fromProtobufModels(objectModels)[id].capabilities?.thinking,
			fromProtobufModels(
				OpenRouterCompatibleModelInfo.fromJSON(OpenRouterCompatibleModelInfo.toJSON({ models: objectModels })).models,
			)[id].capabilities?.thinking,
		]) {
			expect(restored).toMatchObject({ supported: false, minBudget: minimum, effortLevels: [] })
		}
		const absent = ThinkingConfig.decode(ThinkingConfig.encode(ThinkingConfig.create()).finish())
		expect(absent.minBudget).toBeUndefined()
		expect(ThinkingConfig.toJSON(absent)).not.toHaveProperty("minBudget")
	})

	it.each([false, true])("round-trips explicit thinking defaults and disable policy %s without collapsing absence", (value) => {
		const declared = ThinkingConfig.create({ defaultEnabled: value, canDisable: value, defaultEffort: "declared-effort" })
		const binary = ThinkingConfig.decode(ThinkingConfig.encode(declared).finish())
		const json = ThinkingConfig.fromJSON(ThinkingConfig.toJSON(declared))
		for (const restored of [binary, json]) {
			expect(restored.defaultEnabled).toBe(value)
			expect(restored.canDisable).toBe(value)
			expect(restored.defaultEffort).toBe("declared-effort")
		}
		const absent = ThinkingConfig.decode(ThinkingConfig.encode(ThinkingConfig.create()).finish())
		expect(absent.defaultEnabled).toBeUndefined()
		expect(absent.canDisable).toBeUndefined()
		expect(absent.defaultEffort).toBeUndefined()
	})

	it("preserves absence through constructors, JSON conversion, and binary decode", () => {
		expect(ModelInfo.create().apiFormats).toBeUndefined()
		expect(ModelInfo.fromJSON({}).apiFormats).toBeUndefined()
		expect(ModelInfo.fromPartial({}).apiFormats).toBeUndefined()
		expect(ModelInfo.decode(ModelInfo.encode(ModelInfo.create()).finish()).apiFormats).toBeUndefined()

		expect(ModelCapabilities.create().tools).toBeUndefined()
		expect(ModelCapabilities.fromJSON({}).tools).toBeUndefined()
		expect(ModelCapabilities.fromPartial({}).tools).toBeUndefined()
		expect(ModelCapabilities.decode(ModelCapabilities.encode(ModelCapabilities.create()).finish()).tools).toBeUndefined()
	})

	it("round-trips explicitly configured protocols and server tools", () => {
		const modelInfo = ModelInfo.create({
			id: "deepseek-v4-flash",
			apiFormats: [ApiFormat.OPENAI_CHAT, ApiFormat.OPENAI_RESPONSES],
			capabilities: { tools: [ServerTool.WEB_SEARCH], supportsBrowserAction: true },
		})
		const decoded = ModelInfo.decode(ModelInfo.encode(modelInfo).finish())

		expect(decoded.apiFormats).toEqual([ApiFormat.OPENAI_CHAT, ApiFormat.OPENAI_RESPONSES])
		expect(decoded.capabilities?.tools).toEqual([ServerTool.WEB_SEARCH])
		expect(decoded.capabilities?.supportsBrowserAction).toBe(true)
	})

	// A model that rejects a forced tool choice fails the whole request, so a
	// declared refusal has to survive transport rather than decode as "unset"
	// and fall back to the inference this flag exists to override.
	it("round-trips a declared refusal of forced tool use, and keeps it distinct from absence", () => {
		const declared = ModelCapabilities.create({ supportsForcedToolUse: false })
		const decoded = ModelCapabilities.decode(ModelCapabilities.encode(declared).finish())

		expect(decoded.supportsForcedToolUse).toBe(false)
		expect(ModelCapabilities.fromJSON(ModelCapabilities.toJSON(declared)).supportsForcedToolUse).toBe(false)
		expect(ModelCapabilities.create().supportsForcedToolUse).toBeUndefined()
		expect(
			ModelCapabilities.decode(ModelCapabilities.encode(ModelCapabilities.create()).finish()).supportsForcedToolUse,
		).toBeUndefined()
	})

	it("preserves explicitly empty context and pricing tiers in JSON conversion", () => {
		const capabilities = ModelCapabilities.create({ contextWindowTiers: [] })
		const pricing = ModelPricing.create({ tiers: [] })

		expect(ModelCapabilities.fromJSON(ModelCapabilities.toJSON(capabilities)).contextWindowTiers).toEqual([])
		expect(ModelPricing.fromJSON(ModelPricing.toJSON(pricing)).tiers).toEqual([])
	})
})

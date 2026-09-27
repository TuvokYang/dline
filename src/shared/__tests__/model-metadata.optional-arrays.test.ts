import { ModelInfo } from "@shared/proto/dline/models"
import { ApiFormat, ModelCapabilities, ModelPricing, ServerTool } from "@shared/proto/dline/models/metadata"
import { describe, expect, it } from "vitest"

describe("optional repeated model metadata", () => {
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

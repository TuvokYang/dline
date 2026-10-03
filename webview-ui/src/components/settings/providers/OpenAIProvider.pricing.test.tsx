// @vitest-environment jsdom
import type { ModelInfo } from "@shared/proto/dline/models"
import type { ModelCapabilities, ModelPricing } from "@shared/proto/dline/models/metadata"
import { OpenAiProviderConfig } from "@shared/proto/dline/provider/openai"
import { act, render, screen } from "@testing-library/react"
import { useState } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ModelInfoView } from "../common/ModelInfoView"
import { OpenAIProvider } from "./OpenAIProvider"
import type { ApiProfile } from "./ProviderProfile"

/** Registry metadata whose prices differ from the ones typed in the test. */
/** Approximates how long the extension host takes to echo a saved profile. */
const ECHO_DELAY_MS = 500

const registryModel: ModelInfo = {
	id: "gpt-custom",
	name: "Registry GPT",
	capabilities: { contextWindow: 128_000, maxTokens: 4096 } as ModelCapabilities,
	pricing: { inputPrice: 1, outputPrice: 2, currency: "USD" } as ModelPricing,
}

vi.mock("./useProviderModelOptions", () => ({
	useProviderModelOptions: () => ({
		options: { "gpt-custom": registryModel },
		refreshRemoteModels: vi.fn(),
		models: { "gpt-custom": registryModel },
		defaultModelId: "gpt-custom",
		modelInfoSaneDefaults: registryModel,
		loading: false,
	}),
}))

vi.mock("../common/ApiKeyField", () => ({ ApiKeyField: () => <div /> }))
vi.mock("../common/BaseUrlField", () => ({ BaseUrlField: () => <div /> }))
vi.mock("../common/ModelAutocomplete", () => ({ ModelAutocomplete: () => <div /> }))
vi.mock("../ThinkingControl", () => ({ default: () => <div /> }))
vi.mock("../OpenAIServiceTierSelector", () => ({ default: () => <div /> }))
vi.mock("@/services/grpc-client", () => ({ ModelsServiceClient: { refreshOpenAiModels: vi.fn() } }))

/**
 * Holds the profile the way the settings list does: each update replaces the
 * stored profile and re-renders the provider with the new value.
 */
function ProfileHost() {
	const [profile, setProfile] = useState<ApiProfile>(
		() =>
			({
				id: "profile-1",
				provider: "openai",
				modelId: "gpt-custom",
				openai: OpenAiProviderConfig.create({ customModelEnabled: false }),
			}) as unknown as ApiProfile,
	)

	return (
		<OpenAIProvider
			onUpdate={(updates) => {
				// The real profile round-trips through the extension host, so the
				// prop lags behind the edit that produced it.
				setTimeout(() => {
					setProfile((current) => ({ ...current, ...updates }))
				}, ECHO_DELAY_MS)
			}}
			profile={profile}
			showModelOptions={true}
		/>
	)
}

async function typePrice(label: string, value: string): Promise<void> {
	// jsdom does not upgrade the toolkit element, so it exposes no textbox role.
	const field = document.querySelector<HTMLElement>(`vscode-text-field[aria-label="${label}"]`)
	if (!field) {
		throw new Error(`missing price field: ${label}`)
	}

	await act(async () => {
		// The toolkit field reports edits through `input`, matching real typing.
		;(field as unknown as { value: string }).value = value
		field.dispatchEvent(new Event("input", { bubbles: true }))
	})
	await act(async () => {
		await vi.advanceTimersByTimeAsync(200)
	})
}

describe("OpenAIProvider pricing round trip", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.useFakeTimers()
	})

	it("keeps every price entered in sequence", async () => {
		render(<ProfileHost />)

		// Pricing fields only mount once the disclosure is open, as in the UI.
		await act(async () => {
			screen.getByRole("button", { name: "Model Configuration" }).click()
		})

		await typePrice("Input Price ($/1M tokens)", "1.25")
		await typePrice("Output Price ($/1M tokens)", "2.5")
		await typePrice("Cache Writes ($/M)", "0.75")
		await typePrice("Cache Reads ($/M)", "0.25")

		// Let every pending echo arrive before reading the summary.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(ECHO_DELAY_MS * 4)
		})

		expect(screen.getByText("$1.25/M")).toBeInTheDocument()
		expect(screen.getByText("$2.50/M")).toBeInTheDocument()
	})
})

describe("ModelInfoView thinking output pricing", () => {
	it.each<[string, ModelCapabilities, string]>([
		["maximum without mode", { thinking: { supported: true, maxBudget: 100 } }, "$2/M"],
		["coarse veto", { supportsReasoning: false, thinking: { supported: true, mode: "budget", maxBudget: 100 } }, "$2/M"],
		["nested veto", { thinking: { supported: false, mode: "budget", maxBudget: 100 } }, "$2/M"],
		["missing support", { supportsReasoning: true, thinking: { mode: "budget", maxBudget: 100 } }, "$2/M"],
		["effort mode", { thinking: { supported: true, mode: "effort", maxBudget: 100 } }, "$2/M"],
		["inverted bounds", { thinking: { supported: true, mode: "budget", minBudget: 17, maxBudget: 8 } }, "$2/M"],
		["fractional maximum", { thinking: { supported: true, mode: "budget", maxBudget: 10.5 } }, "$2/M"],
		["zero maximum", { thinking: { supported: true, mode: "budget", maxBudget: 0 } }, "$2/M"],
		["unbounded budget", { thinking: { supported: true, mode: "budget", minBudget: 17 } }, "$7/M"],
		["both mode", { thinking: { supported: true, mode: "both", maxBudget: 100 } }, "$7/M"],
	])("renders the declared output price for %s", (_label, capabilities, expected) => {
		const modelInfo: ModelInfo = { id: "opaque-price", capabilities, pricing: { outputPrice: 2, thinkingOutputPrice: 7 } }
		render(<ModelInfoView modelInfo={modelInfo} selectedModelId={modelInfo.id} />)
		expect(screen.getByText(expected)).toBeInTheDocument()
		expect(screen.queryByText(expected === "$7/M" ? "$2/M" : "$7/M")).not.toBeInTheDocument()
	})

	it("uses the model billing currency and displays output limits and declared capabilities", () => {
		const modelInfo: ModelInfo = {
			id: "deepseek-cny-display",
			capabilities: {
				contextWindow: 1_000_000,
				maxTokens: 384_000,
				supportsTools: true,
				supportsReasoning: true,
				supportsPromptCache: true,
			},
			pricing: {
				inputPrice: 3,
				outputPrice: 6,
				cacheWritesPrice: 3,
				cacheReadsPrice: 0.025,
				currency: "CNY",
			},
		}

		render(<ModelInfoView modelInfo={modelInfo} selectedModelId={modelInfo.id} />)

		expect(screen.getByText("384K")).toBeInTheDocument()
		expect(screen.getAllByText("¥3/M")).toHaveLength(2)
		expect(screen.getByText("¥6/M")).toBeInTheDocument()
		expect(screen.getByText("¥0.03/M")).toBeInTheDocument()
		expect(screen.getByText("Native Tool Calls").parentElement).toHaveTextContent("Yes")
		expect(screen.getByText("Reasoning").parentElement).toHaveTextContent("Yes")
		expect(screen.queryByText("$3/M")).not.toBeInTheDocument()
	})

	it("preserves a declared zero thinking output price", () => {
		const modelInfo: ModelInfo = {
			id: "opaque-free-thinking",
			capabilities: { thinking: { supported: true, mode: "budget" } },
			pricing: { outputPrice: 2, thinkingOutputPrice: 0 },
		}
		render(<ModelInfoView modelInfo={modelInfo} selectedModelId={modelInfo.id} />)
		expect(screen.getByText("Free")).toBeInTheDocument()
		expect(screen.queryByText("$2/M")).not.toBeInTheDocument()
	})
})

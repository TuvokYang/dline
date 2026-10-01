// @vitest-environment jsdom
import type { ModelInfo } from "@shared/proto/dline/models"
import { ApiProfile } from "@shared/proto/dline/profile"
import { fireEvent, render, screen } from "@testing-library/react"
import type { AnchorHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import OpenRouterModelPicker from "./OpenRouterModelPicker"
import { ClineProvider } from "./providers/ClineProvider"

const mocks = vi.hoisted(() => ({
	refreshOpenRouterModels: vi.fn(),
	refreshClineModels: vi.fn(),
	toggleFavoriteModel: vi.fn(),
	models: {
		"anthropic/claude-sonnet-4.5": {
			id: "anthropic/claude-sonnet-4.5",
			name: "OpenRouter Default Model",
			capabilities: { contextWindow: 200_000, maxTokens: 64_000 },
			pricing: { inputPrice: 1, outputPrice: 2 },
		},
		"vendor/default-model": {
			id: "vendor/default-model",
			name: "Default Model",
			capabilities: { contextWindow: 200_000, maxTokens: 32_000 },
			pricing: { inputPrice: 1, outputPrice: 2 },
		},
		"vendor/native-1m-model": {
			id: "vendor/native-1m-model",
			name: "Native 1M Model",
			capabilities: { contextWindow: 1_000_000, maxTokens: 128_000 },
			pricing: { inputPrice: 3, outputPrice: 4 },
		},
	} as Record<string, ModelInfo>,
	clineModels: {
		"cline/own-model": { id: "cline/own-model", name: "Own Cline Model" },
	} as Record<string, ModelInfo>,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
	VSCodeDropdown: (props: SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} />,
	VSCodeOption: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
	VSCodeTextField: ({ children: _children, ...props }: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
	VSCodeCheckbox: ({ checked, disabled, onChange, children }: InputHTMLAttributes<HTMLInputElement>) => (
		<label>
			<input checked={checked} disabled={disabled} onChange={onChange} type="checkbox" />
			{children}
		</label>
	),
}))

vi.mock("@context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		favoritedModelIds: [],
		openRouterModels: mocks.models,
		refreshOpenRouterModels: mocks.refreshOpenRouterModels,
		clineModels: mocks.clineModels,
		refreshClineModels: mocks.refreshClineModels,
		mode: "act",
	}),
}))

vi.mock("@services/grpc-client", () => ({
	StateServiceClient: { toggleFavoriteModel: mocks.toggleFavoriteModel },
}))

vi.mock("./ClineAccountInfoCard", () => ({ ClineAccountInfoCard: () => <div /> }))
vi.mock("./utils/useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({ handleModeFieldsChange: vi.fn(), handleFieldChange: vi.fn() }),
}))
vi.mock("./common/ContextWindowSwitcher", () => ({ ContextWindowSwitcher: () => null }))

beforeAll(() => {
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined })
})

beforeEach(() => {
	vi.clearAllMocks()
})

for (const [provider, configKey] of [
	["openrouter", "openrouter"],
	["cline", "clineProvider"],
] as const) {
	describe(`${provider} Profile thinking`, () => {
		const renderPicker = (profile: ApiProfile, onUpdate = vi.fn()) => {
			return provider === "cline"
				? render(<ClineProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
				: render(<OpenRouterModelPicker onUpdate={onUpdate} profile={profile} />)
		}

		it("uses declared effort defaults and required thinking for an opaque alias", () => {
			const profile = ApiProfile.create({
				provider,
				modelId: "opaque-alias",
				modelInfo: {
					id: "opaque-alias",
					capabilities: {
						thinking: {
							supported: true,
							mode: "effort",
							effortLevels: ["low"],
							defaultEnabled: true,
							defaultEffort: "low",
							canDisable: false,
						},
					},
				},
			})
			renderPicker(profile)
			expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue("opaque-alias")
			expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeChecked()
			expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeDisabled()
			expect(screen.getAllByRole("combobox").filter((item) => item.textContent === "Low")).toHaveLength(1)
			expect(screen.queryByRole("slider")).not.toBeInTheDocument()
		})

		it("persists a declared budget edit through the owning Profile config", () => {
			const onUpdate = vi.fn()
			const profile = ApiProfile.create({
				provider,
				modelId: "budget-alias",
				modelInfo: {
					id: "budget-alias",
					capabilities: { thinking: { supported: true, mode: "budget", maxBudget: 3000 } },
				},
				[configKey]: { reasoning: { enableThinking: true, thinkingBudget: 1500, display: "omitted" } },
			})
			renderPicker(profile, onUpdate)
			const slider = screen.getByRole("slider")
			fireEvent.change(slider, { target: { value: "2400" } })
			fireEvent.mouseUp(slider)
			expect(onUpdate).toHaveBeenCalledWith({
				[configKey]: {
					...profile[configKey],
					reasoning: { enableThinking: true, effort: undefined, thinkingBudget: 2400, display: "omitted" },
				},
			})
		})

		it("does not reuse mismatched metadata for a known-looking unknown ID", () => {
			const profile = ApiProfile.create({
				provider,
				modelId: "anthropic/claude-opus-4.7-unknown",
				modelInfo: { id: "old-alias", capabilities: { thinking: { supported: true, mode: "budget", maxBudget: 3000 } } },
				[configKey]: { reasoning: { enableThinking: true, thinkingBudget: 1500 } },
			})
			renderPicker(profile)
			expect(screen.queryByRole("checkbox", { name: "Enable Thinking" })).not.toBeInTheDocument()
			expect(screen.queryByRole("slider")).not.toBeInTheDocument()
			expect(screen.queryByText("Reasoning Effort")).not.toBeInTheDocument()
		})
	})
}

describe("Cline Profile model selection", () => {
	it("uses the Cline listing and updates the supplied Profile rather than legacy mode fields", () => {
		const onUpdate = vi.fn()
		const profile = ApiProfile.create({ provider: "cline", modelId: "old-selection" })
		render(<ClineProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
		const input = screen.getByRole("combobox", { name: "Model" })
		fireEvent.input(input, { target: { value: "cline/own" } })
		fireEvent.click(screen.getByRole("option"))
		expect(onUpdate).toHaveBeenCalledWith({ modelId: "cline/own-model", modelInfo: mocks.clineModels["cline/own-model"] })
		expect(mocks.refreshClineModels).toHaveBeenCalled()
		expect(mocks.refreshOpenRouterModels).not.toHaveBeenCalled()
	})
})

describe("OpenRouterModelPicker", () => {
	it("persists the searched Profile model and displays that model's native context window", () => {
		const onUpdate = vi.fn()
		const profile = {
			id: "openrouter-profile",
			name: "OpenRouter profile",
			provider: "openrouter",
			modelId: "vendor/default-model",
			usedFor: ["act"],
			enabled: true,
		} as ApiProfile

		const { rerender } = render(<OpenRouterModelPicker onUpdate={onUpdate} profile={profile} />)

		const modelInput = screen.getByRole("combobox", { name: "Model" })
		expect(modelInput).toHaveValue("vendor/default-model")

		fireEvent.input(modelInput, { target: { value: "native-1m" } })
		fireEvent.click(screen.getByRole("option"))

		expect(onUpdate).toHaveBeenCalledWith({
			modelId: "vendor/native-1m-model",
			modelInfo: mocks.models["vendor/native-1m-model"],
		})

		const selectedProfile = {
			...profile,
			modelId: "vendor/native-1m-model",
			modelInfo: mocks.models["vendor/native-1m-model"],
		} as ApiProfile
		rerender(<OpenRouterModelPicker onUpdate={onUpdate} profile={selectedProfile} />)

		expect(screen.getByText("1M", { exact: true })).toBeInTheDocument()
	})

	it("persists the visible OpenRouter default for a new Profile", () => {
		const onUpdate = vi.fn()
		const profile = {
			id: "new-openrouter-profile",
			name: "New OpenRouter profile",
			provider: "openrouter",
			modelId: "",
			usedFor: ["act"],
			enabled: true,
		} as ApiProfile

		render(<OpenRouterModelPicker onUpdate={onUpdate} profile={profile} />)

		expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue("anthropic/claude-sonnet-4.5")
		expect(onUpdate).toHaveBeenCalledWith({
			modelId: "anthropic/claude-sonnet-4.5",
			modelInfo: mocks.models["anthropic/claude-sonnet-4.5"],
		})
	})
})

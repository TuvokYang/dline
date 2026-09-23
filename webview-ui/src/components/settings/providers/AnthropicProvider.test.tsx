// @vitest-environment jsdom
import type { ModelInfo } from "@shared/proto/dline/models"
import type { ModelCapabilities, ModelPricing } from "@shared/proto/dline/models/metadata"
import type { ApiProfile } from "@shared/proto/dline/profile"
import { AnthropicProviderConfig } from "@shared/proto/dline/provider/anthropic"
import { fireEvent, render, screen } from "@testing-library/react"
import React, { type ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { AnthropicProvider } from "./AnthropicProvider"

const registryModel: ModelInfo = {
	id: "claude-custom",
	name: "Registry Claude",
	capabilities: {
		contextWindow: 200_000,
		contextWindowTiers: [
			{ id: "standard", contextWindow: 200_000, label: "200K" },
			{ id: "long", contextWindow: 1_000_000, label: "1M", apiModelSuffix: ":1m" },
		],
		maxTokens: 8192,
		supportsImages: true,
		supportsPromptCache: true,
	} as ModelCapabilities,
	pricing: {
		inputPrice: 3,
		outputPrice: 15,
		currency: "USD",
	} as ModelPricing,
}

const nativeContextModel: ModelInfo = {
	id: "claude-native",
	name: "Native Context Claude",
	capabilities: {
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		supportsPromptCache: true,
	} as ModelCapabilities,
}

const adaptiveModel: ModelInfo = {
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	capabilities: {
		supportsReasoning: true,
		thinking: {
			supported: true,
			mode: "effort",
			effortLevels: ["none", "low", "medium", "high", "max"],
		},
	} as ModelCapabilities,
}

const defaultAdaptiveModel: ModelInfo = {
	id: "claude-opus-5",
	name: "Claude Opus 5",
	capabilities: {
		contextWindow: 1_000_000,
		supportsReasoning: true,
		thinking: {
			supported: true,
			mode: "effort",
			effortLevels: ["none", "low", "medium", "high", "xhigh", "max"],
		},
	} as ModelCapabilities,
}

const requiredAdaptiveModel: ModelInfo = {
	id: "claude-fable-5",
	name: "Claude Fable 5",
	capabilities: {
		contextWindow: 1_000_000,
		supportsReasoning: true,
		thinking: {
			supported: true,
			mode: "effort",
			effortLevels: ["low", "medium", "high", "xhigh", "max"],
		},
	} as ModelCapabilities,
}

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ remoteConfigSettings: {} }),
}))

const catalogModels = {
	"claude-custom": registryModel,
	"claude-native": nativeContextModel,
	"claude-sonnet-4-6": adaptiveModel,
	"claude-opus-5": defaultAdaptiveModel,
	"claude-fable-5": requiredAdaptiveModel,
}

const listingOnlyModel: ModelInfo = { id: "claude-listing-only", name: "claude-listing-only" }

vi.mock("./useProviderModelOptions", () => ({
	useProviderModelOptions: () => ({
		models: catalogModels,
		defaultModelId: "claude-custom",
		modelInfoSaneDefaults: registryModel,
		loading: false,
		options: { "claude-listing-only": listingOnlyModel, ...catalogModels },
		optionOrigins: {
			"claude-listing-only": "remote",
			...Object.fromEntries(Object.keys(catalogModels).map((id) => [id, "catalog"])),
		},
		refreshRemoteModels: vi.fn(),
	}),
}))

vi.mock("../common/ModelConfiguration", () => ({
	ModelConfiguration: ({
		contextWindowValue,
		fields,
		onCapabilitiesUpdate,
		onContextWindowUpdate,
	}: {
		contextWindowValue?: number
		fields: { capabilities?: string[] }
		onCapabilitiesUpdate: (updates: Partial<ModelCapabilities>) => void
		onContextWindowUpdate?: (value: number) => void
	}) => (
		<>
			<span data-testid="capability-fields">{fields.capabilities?.join(",")}</span>
			<span data-testid="current-context-window">{contextWindowValue}</span>
			<button onClick={() => onContextWindowUpdate?.(1_500_000)} type="button">
				Update Current Window
			</button>
			<button onClick={() => onCapabilitiesUpdate({ supportsPromptCache: false })} type="button">
				Update Cache
			</button>
			<button
				onClick={() =>
					onCapabilitiesUpdate({
						contextWindowTiers: [{ id: "long", contextWindow: 1_000_000, label: "1M" }],
					})
				}
				type="button">
				Add Context Tier
			</button>
		</>
	),
}))

vi.mock("../common/ModelInfoView", () => ({
	ModelInfoView: ({ modelInfo }: { modelInfo: ModelInfo }) => (
		<div>
			<span>max:{modelInfo.capabilities?.maxTokens}</span>
			<span>input:{modelInfo.pricing?.inputPrice}</span>
			<span>context:{modelInfo.capabilities?.contextWindow}</span>
		</div>
	),
}))

vi.mock("../common/ApiKeyField", () => ({ ApiKeyField: () => <div /> }))
vi.mock("../common/BaseUrlField", () => ({ BaseUrlField: () => <div /> }))
vi.mock("../common/ContextWindowSwitcher", () => ({ ContextWindowSwitcher: () => <div /> }))
// The custom-model branch renders its id through this field, so the mock has to
// stay a real input or the branch becomes unobservable in jsdom.
vi.mock("../common/DebouncedTextField", () => ({
	DebouncedTextField: ({
		id,
		initialValue,
		onChange,
		placeholder,
	}: {
		id?: string
		initialValue?: string
		onChange?: (value: string) => void
		placeholder?: string
	}) => (
		<input
			defaultValue={initialValue ?? ""}
			id={id}
			onChange={(event) => onChange?.(event.target.value)}
			placeholder={placeholder}
		/>
	),
}))
vi.mock("../common/ModelAutocomplete", () => ({
	ModelAutocomplete: ({ models, onChange, selectedModelId }: any) => (
		<input
			aria-label="Model"
			onChange={(event) => onChange(event.target.value, models[event.target.value])}
			value={selectedModelId ?? ""}
		/>
	),
}))
vi.mock("../common/RemotelyConfiguredInputWrapper", () => ({
	RemotelyConfiguredInputWrapper: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock("../ThinkingControl", () => ({
	default: ({
		defaultEffort,
		defaultEnabled,
		disableSupported,
		effortOptions,
	}: {
		defaultEffort?: string
		defaultEnabled?: boolean
		disableSupported?: boolean
		effortOptions?: readonly string[]
	}) => (
		<div data-testid="thinking-control">
			<span data-testid="thinking-efforts">{effortOptions?.join(",")}</span>
			<span data-testid="thinking-default-enabled">{String(defaultEnabled)}</span>
			<span data-testid="thinking-default-effort">{defaultEffort}</span>
			<span data-testid="thinking-disable-supported">{String(disableSupported)}</span>
		</div>
	),
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({
		checked,
		children,
		onChange,
	}: {
		checked?: boolean
		children: ReactNode
		onChange?: React.ChangeEventHandler<HTMLInputElement>
	}) => (
		<label>
			<input checked={checked} onChange={onChange} type="checkbox" />
			{children}
		</label>
	),
}))

describe("AnthropicProvider", () => {
	it("marks a model outside the catalog as custom when it is committed", () => {
		const onUpdate = vi.fn()
		const profile = {
			id: "profile-origin",
			provider: "anthropic",
			modelId: "claude-native",
			anthropic: AnthropicProviderConfig.create({}),
		} as unknown as ApiProfile

		render(<AnthropicProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)

		// A single picker covers both catalog and listing-only models, and the
		// custom-model switch stays available for ids no listing returns.
		expect(screen.getByRole("checkbox", { name: "Use custom model ID" })).not.toBeChecked()
		fireEvent.change(screen.getByRole("textbox", { name: "Model" }), { target: { value: "claude-listing-only" } })

		// The switch belongs to the user. Deriving it from catalog membership would
		// let listing-only ids mask the catalog's own hosted capabilities.
		expect(onUpdate).toHaveBeenCalledWith({ modelId: "claude-listing-only" })
	})

	it("keeps the custom-model switch on when a catalog model is committed", () => {
		const onUpdate = vi.fn()
		const profile = {
			id: "profile-origin-catalog",
			provider: "anthropic",
			modelId: "claude-native",
			anthropic: AnthropicProviderConfig.create({ customModelEnabled: true }),
		} as unknown as ApiProfile

		render(<AnthropicProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)

		// With the switch on, the picker is replaced by a free-form id field, so the
		// merged picker must be absent and the id must commit on its own.
		expect(screen.queryByRole("button", { name: "Open Model" })).not.toBeInTheDocument()
		fireEvent.input(screen.getByLabelText("Model ID"), { target: { value: "claude-sonnet-4-6" } })

		expect(onUpdate).toHaveBeenCalledWith({ modelId: "claude-sonnet-4-6" })
	})

	it("uses provider capabilities for custom model updates and merged display", () => {
		const onUpdate = vi.fn()
		const profile = {
			id: "profile-1",
			provider: "anthropic",
			modelId: "claude-custom",
			anthropic: AnthropicProviderConfig.create({
				customModelEnabled: true,
				capabilities: { maxTokens: 64_000 } as ModelCapabilities,
				pricing: { inputPrice: 0.5 } as ModelPricing,
			}),
		} as unknown as ApiProfile

		render(<AnthropicProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)

		expect(screen.getByText("max:64000")).toBeInTheDocument()
		expect(screen.getByText("input:0.5")).toBeInTheDocument()
		expect(screen.getByTestId("capability-fields")).toHaveTextContent(
			"supportsImages,hostedWebSearch,hostedWebFetch,supportsBrowserAction,supportsPromptCache",
		)

		fireEvent.click(screen.getByText("Update Cache"))

		expect(onUpdate).toHaveBeenCalledWith({
			anthropic: {
				...profile.anthropic,
				capabilities: { maxTokens: 64_000, supportsPromptCache: false },
			},
		})
	})

	it("replaces a custom model's selected tier window without preserving a legacy direct window", () => {
		const onUpdate = vi.fn()
		const profile = {
			id: "profile-custom-tier-window",
			provider: "anthropic",
			modelId: "claude-custom",
			anthropic: AnthropicProviderConfig.create({
				customModelEnabled: true,
				enableLongContext: true,
				capabilities: {
					contextWindow: 999_999,
					contextWindowTiers: [
						{ id: "standard", contextWindow: 160_000, label: "160K" },
						{ id: "long", contextWindow: 1_200_000, label: "1.2M", apiModelSuffix: ":1m" },
					],
				} as ModelCapabilities,
			}),
		} as unknown as ApiProfile

		render(<AnthropicProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
		fireEvent.click(screen.getByText("Update Current Window"))

		expect(onUpdate).toHaveBeenCalledWith({
			anthropic: {
				...profile.anthropic,
				capabilities: {
					contextWindowTiers: [
						{ id: "standard", contextWindow: 160_000, label: "160K" },
						{ id: "long", contextWindow: 1_500_000, label: "1.2M", apiModelSuffix: ":1m" },
					],
				},
			},
		})
	})

	it("does not expose context tier editing for native-window official models", () => {
		const profile = {
			id: "profile-2",
			provider: "anthropic",
			modelId: "claude-native",
			anthropic: AnthropicProviderConfig.create({}),
		} as unknown as ApiProfile

		render(<AnthropicProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)

		expect(screen.getByTestId("capability-fields")).not.toHaveTextContent("contextWindowTiers")
		expect(screen.queryByRole("checkbox", { name: "Enable Long Context" })).not.toBeInTheDocument()
		expect(screen.getByTestId("current-context-window")).toHaveTextContent("1000000")
	})

	it("uses the selected tier for the explicit context window and preserves both tier values", () => {
		const onUpdate = vi.fn()
		const profile = {
			id: "profile-tier-window",
			provider: "anthropic",
			modelId: "claude-custom",
			anthropic: AnthropicProviderConfig.create({
				enableLongContext: true,
				capabilities: {
					contextWindowTiers: [
						{ id: "standard", contextWindow: 160_000, label: "160K" },
						{ id: "long", contextWindow: 1_200_000, label: "1.2M", apiModelSuffix: ":1m" },
					],
				} as ModelCapabilities,
			}),
		} as unknown as ApiProfile

		const { rerender } = render(<AnthropicProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)

		expect(screen.getByRole("checkbox", { name: "Enable Long Context" })).toBeChecked()
		expect(screen.getByTestId("current-context-window")).toHaveTextContent("1200000")
		fireEvent.click(screen.getByText("Update Current Window"))
		expect(onUpdate).toHaveBeenCalledWith({
			anthropic: {
				...profile.anthropic,
				capabilities: {
					contextWindowTiers: [
						{ id: "standard", contextWindow: 160_000, label: "160K" },
						{ id: "long", contextWindow: 1_500_000, label: "1.2M", apiModelSuffix: ":1m" },
					],
				},
			},
		})

		rerender(
			<AnthropicProvider
				onUpdate={onUpdate}
				profile={{ ...profile, anthropic: { ...profile.anthropic, enableLongContext: false } }}
				showModelOptions={true}
			/>,
		)
		expect(screen.getByRole("checkbox", { name: "Enable Long Context" })).not.toBeChecked()
		expect(screen.getByTestId("current-context-window")).toHaveTextContent("160000")
	})

	it("edits direct context windows without adding a long-context suffix tier", () => {
		const onUpdate = vi.fn()
		const profile = {
			id: "profile-native-window",
			provider: "anthropic",
			modelId: "claude-native",
			anthropic: AnthropicProviderConfig.create({
				enableLongContext: true,
				capabilities: {
					contextWindow: 1_250_000,
					contextWindowTiers: [
						{ id: "standard", contextWindow: 200_000, label: "200K" },
						{ id: "long", contextWindow: 1_000_000, label: "1M", apiModelSuffix: ":1m" },
					],
				} as ModelCapabilities,
			}),
		} as unknown as ApiProfile

		render(<AnthropicProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)

		expect(screen.queryByRole("checkbox", { name: "Enable Long Context" })).not.toBeInTheDocument()
		expect(screen.getByTestId("current-context-window")).toHaveTextContent("1250000")
		fireEvent.click(screen.getByText("Update Current Window"))
		expect(onUpdate).toHaveBeenCalledWith({
			anthropic: {
				...profile.anthropic,
				capabilities: { contextWindow: 1_500_000 },
			},
		})
	})

	it("reads adaptive-thinking efforts from the selected model metadata", () => {
		const profile = {
			id: "profile-adaptive",
			provider: "anthropic",
			modelId: "claude-sonnet-4-6",
			anthropic: AnthropicProviderConfig.create({ reasoning: { enableThinking: true, effort: "high" } }),
		} as unknown as ApiProfile

		render(<AnthropicProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)

		expect(screen.getByTestId("thinking-efforts")).toHaveTextContent("none,low,medium,high,max")
	})

	it("selects the long context by default for explicitly tiered registry models", () => {
		const onUpdate = vi.fn()
		const profile = {
			id: "profile-3",
			provider: "anthropic",
			modelId: "claude-custom",
			anthropic: AnthropicProviderConfig.create({}),
		} as unknown as ApiProfile

		render(<AnthropicProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)

		// Explicitly tiered compatible models keep the legacy long-context control.
		expect(screen.getByText("context:1000000")).toBeInTheDocument()
	})

	it("marks Opus 5 thinking as enabled by default while keeping disabled available", () => {
		const profile = {
			id: "profile-opus-5",
			provider: "anthropic",
			modelId: "claude-opus-5",
			anthropic: AnthropicProviderConfig.create({}),
		} as unknown as ApiProfile

		render(<AnthropicProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)

		expect(screen.getByTestId("thinking-default-enabled")).toHaveTextContent("true")
		expect(screen.getByTestId("thinking-default-effort")).toHaveTextContent("high")
		expect(screen.getByTestId("thinking-disable-supported")).toHaveTextContent("true")
		expect(screen.getByTestId("thinking-efforts")).toHaveTextContent("none,low,medium,high,xhigh,max")
	})

	it("keeps Fable 5 thinking required and removes the disabled effort", () => {
		const profile = {
			id: "profile-fable-5",
			provider: "anthropic",
			modelId: "claude-fable-5",
			anthropic: AnthropicProviderConfig.create({ reasoning: { enableThinking: false, effort: "none" } }),
		} as unknown as ApiProfile

		render(<AnthropicProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)

		expect(screen.getByTestId("thinking-default-enabled")).toHaveTextContent("true")
		expect(screen.getByTestId("thinking-disable-supported")).toHaveTextContent("false")
		expect(screen.getByTestId("thinking-efforts")).toHaveTextContent("low,medium,high,xhigh,max")
	})
})

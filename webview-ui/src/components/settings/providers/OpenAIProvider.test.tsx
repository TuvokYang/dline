// @vitest-environment jsdom
import type { ModelInfo } from "@shared/proto/dline/models"
import { ApiFormat, type ModelCapabilities, type ModelPricing } from "@shared/proto/dline/models/metadata"
import { WebToolsMode } from "@shared/proto/dline/provider/common"
import { OpenAiPromptCacheMode, OpenAiProviderConfig } from "@shared/proto/dline/provider/openai"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { OpenAIProvider } from "./OpenAIProvider"
import type { ApiProfile } from "./ProviderProfile"

const registryModel: ModelInfo = {
	id: "gpt-custom",
	name: "Registry GPT",
	capabilities: {
		contextWindow: 128_000,
		maxTokens: 4096,
		supportsImages: false,
		supportsPromptCache: false,
	} as ModelCapabilities,
	pricing: {
		inputPrice: 1,
		outputPrice: 2,
		currency: "USD",
	} as ModelPricing,
}

const multiFormatModel: ModelInfo = {
	id: "gpt-multi",
	name: "GPT Multi",
	apiFormats: [ApiFormat.OPENAI_RESPONSES, ApiFormat.OPENAI_CHAT],
	capabilities: {
		contextWindow: 272_000,
		maxTokens: 128_000,
		supportsTools: true,
		supportsReasoning: true,
	} as ModelCapabilities,
}

const catalogModels = { "gpt-multi": multiFormatModel, "gpt-custom": registryModel }

const refreshRemoteModels = vi.fn()

vi.mock("./useProviderModelOptions", () => ({
	useProviderModelOptions: () => ({
		models: catalogModels,
		defaultModelId: "gpt-multi",
		modelInfoSaneDefaults: multiFormatModel,
		imageModels: {
			"gpt-image-2": { id: "gpt-image-2", name: "GPT Image 2" },
			"gpt-image-custom": { id: "gpt-image-custom", name: "Custom Image" },
		},
		defaultImageModelId: "gpt-image-2",
		loading: false,
		// Catalog entries win over discovered ids, matching the hook's merge.
		options: { "gpt-listed-only": { id: "gpt-listed-only" }, ...catalogModels },
		optionOrigins: {
			"gpt-listed-only": "remote",
			"gpt-multi": "catalog",
			"gpt-custom": "catalog",
		},
		refreshRemoteModels,
	}),
}))

vi.mock("../common/ModelConfiguration", () => ({
	ModelConfiguration: ({
		defaults,
		fields,
		onCapabilitiesUpdate,
		onPricingUpdate,
	}: {
		defaults?: ModelInfo
		fields: { capabilities?: string[] }
		onCapabilitiesUpdate: (updates: Partial<ModelCapabilities>) => void
		onPricingUpdate: (updates: Partial<ModelPricing>) => void
	}) => (
		<>
			<span data-testid="default-native-tools">{String(defaults?.capabilities?.supportsTools)}</span>
			<span data-testid="capability-fields">{fields.capabilities?.join(",")}</span>
			<button onClick={() => onCapabilitiesUpdate({ supportsImages: true })} type="button">
				Update Images
			</button>
			<button onClick={() => onPricingUpdate({ inputPrice: 1.25 })} type="button">
				Set Input Price
			</button>
			<button onClick={() => onPricingUpdate({ outputPrice: 2.5 })} type="button">
				Set Output Price
			</button>
			{fields.capabilities?.includes("supportsTools") && (
				<button onClick={() => onCapabilitiesUpdate({ supportsTools: true })} type="button">
					Enable Native Tools
				</button>
			)}
		</>
	),
}))

vi.mock("../common/ModelInfoView", () => ({
	ModelInfoView: ({ modelInfo }: { modelInfo: ModelInfo }) => (
		<div>
			<span>context:{modelInfo.capabilities?.contextWindow}</span>
			<span>max:{modelInfo.capabilities?.maxTokens}</span>
			<span>input:{modelInfo.pricing?.inputPrice}</span>
			<span>output:{modelInfo.pricing?.outputPrice}</span>
		</div>
	),
}))

vi.mock("../common/ApiKeyField", () => ({ ApiKeyField: () => <div /> }))
vi.mock("../common/BaseUrlField", () => ({ BaseUrlField: () => <div /> }))
vi.mock("../common/DebouncedTextField", () => ({
	DebouncedTextField: ({ ariaLabel, children, className, id, initialValue, onChange }: any) => {
		const input = (
			<input
				aria-label={ariaLabel ?? (typeof children === "string" ? children : "Model ID")}
				className={className}
				defaultValue={initialValue}
				id={id}
				onChange={(event) => onChange(event.target.value)}
			/>
		)
		return children ? (
			<label>
				{children}
				{input}
			</label>
		) : (
			input
		)
	},
}))
vi.mock("../common/ModelAutocomplete", () => ({
	ModelAutocomplete: ({ label, models, onChange, onOpen, optionOrigins, selectedModelId }: any) => (
		<div>
			<button aria-label={`Open ${label}`} onClick={onOpen} type="button">
				Open {label}
			</button>
			<input
				aria-label={label}
				onChange={(event) => onChange(event.target.value, models[event.target.value])}
				value={selectedModelId ?? ""}
			/>
			<span data-testid="model-options">{Object.keys(models).join(",")}</span>
			<span data-testid="remote-model-options">
				{Object.entries(optionOrigins ?? {})
					.filter(([, origin]) => origin === "remote")
					.map(([id]) => id)
					.join(",")}
			</span>
		</div>
	),
}))
vi.mock("../ThinkingControl", () => ({
	default: ({ effortOptions }: { effortOptions?: readonly string[] }) => (
		<div data-testid="thinking-efforts">{effortOptions?.join(",")}</div>
	),
}))
vi.mock("../OpenAIServiceTierSelector", () => ({
	default: ({
		onServiceTierChange,
		onServiceTierEnabledChange,
		serviceTierEnabled,
	}: {
		onServiceTierChange: (value: string) => void
		onServiceTierEnabledChange: (enabled: boolean) => void
		serviceTierEnabled?: boolean
	}) => (
		<>
			<span data-testid="service-tier-enabled">{String(serviceTierEnabled === true)}</span>
			<button onClick={() => onServiceTierChange("priority")} type="button">
				Set Priority Tier
			</button>
			<button onClick={() => onServiceTierEnabledChange(false)} type="button">
				Disable Service Tier
			</button>
		</>
	),
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, onClick }: any) => (
		<button onClick={onClick} type="button">
			{children}
		</button>
	),
	VSCodeCheckbox: ({ checked, children, onChange }: any) => (
		<label>
			<input checked={checked} onChange={onChange} type="checkbox" />
			{children}
		</label>
	),
}))
vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: { refreshOpenAiModels: vi.fn(), refreshProviderModels: vi.fn() },
}))

describe("OpenAIProvider", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("uses the official model catalog and metadata-driven API Format selector", () => {
		const onUpdate = vi.fn()
		const config = OpenAiProviderConfig.create({ customModelEnabled: false })
		;(config as any).apiFormat = ApiFormat.OPENAI_RESPONSES
		const profile = {
			id: "official-openai",
			provider: "openai",
			modelId: "gpt-multi",
			openai: config,
			webToolsMode: WebToolsMode.WEB_TOOLS_MODE_AUTO,
		} as unknown as ApiProfile

		render(<OpenAIProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)

		expect(screen.getByRole("textbox", { name: "Model" })).toHaveValue("gpt-multi")
		// A single picker covers both catalog and listing-only models; the custom
		// switch stays available for ids no listing returns.
		expect(screen.getByRole("checkbox", { name: "Use custom model ID" })).not.toBeChecked()
		expect(screen.getByTestId("model-options")).toHaveTextContent("gpt-listed-only")
		expect(screen.getByTestId("remote-model-options")).toHaveTextContent("gpt-listed-only")
		const apiFormat = screen.getByRole("combobox", { name: "API Format" })
		expect(apiFormat).toHaveValue(String(ApiFormat.OPENAI_RESPONSES))
		expect(apiFormat).toHaveStyle({
			backgroundColor: "var(--vscode-dropdown-background)",
			color: "var(--vscode-dropdown-foreground)",
		})
		expect(screen.getByRole("option", { name: "OpenAI Responses" })).toBeInTheDocument()
		expect(screen.getByRole("option", { name: "OpenAI Chat" })).toBeInTheDocument()
		expect(screen.getByTestId("capability-fields")).toHaveTextContent("hostedWebSearch")
		expect(screen.getByRole("combobox", { name: "Web Tools mode" })).toHaveValue(String(WebToolsMode.WEB_TOOLS_MODE_AUTO))
		expect(screen.getByRole("checkbox", { name: "Use explicit prompt cache controls" })).not.toBeChecked()

		fireEvent.change(apiFormat, { target: { value: String(ApiFormat.OPENAI_CHAT) } })
		expect(onUpdate).toHaveBeenCalledWith({
			openai: expect.objectContaining({ apiFormat: ApiFormat.OPENAI_CHAT }),
		})
	})

	it("leaves image source and model selection to the API Profile card", () => {
		const profile = {
			id: "openai-images",
			provider: "openai",
			modelId: "gpt-multi",
			imageModelId: "gpt-image-2",
			usedFor: ["act", "image"],
			openai: OpenAiProviderConfig.create({ customModelEnabled: false }),
		} as unknown as ApiProfile

		render(<OpenAIProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
		expect(screen.queryByRole("combobox", { name: "Image model" })).not.toBeInTheDocument()
	})

	it("preserves a legacy compatible profile as custom configuration", () => {
		const onUpdate = vi.fn()
		const profile = {
			id: "custom-openai",
			provider: "openai",
			modelId: "legacy-compatible-model",
			openai: OpenAiProviderConfig.create(),
		} as unknown as ApiProfile

		render(<OpenAIProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)

		// An id outside the catalog stays selectable through the merged picker while
		// the custom switch remains the user's own choice.
		expect(screen.getByRole("textbox", { name: "Model" })).toHaveValue("legacy-compatible-model")
		expect(screen.getByRole("checkbox", { name: "Use custom model ID" })).not.toBeChecked()
		expect(screen.getByRole("combobox", { name: "API Format" })).toBeInTheDocument()
		expect(screen.getByTestId("default-native-tools")).toHaveTextContent("true")
	})

	it("commits a listing-only model without claiming the custom-model switch", () => {
		const onUpdate = vi.fn()
		const profile = {
			id: "official-openai",
			provider: "openai",
			modelId: "gpt-multi",
			openai: OpenAiProviderConfig.create({ customModelEnabled: false }),
		} as unknown as ApiProfile

		render(<OpenAIProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)

		fireEvent.change(screen.getByRole("textbox", { name: "Model" }), { target: { value: "gpt-listed-only" } })

		// The switch belongs to the user. Flipping it from a model commit would
		// let listing-only ids mask the catalog's own metadata.
		expect(onUpdate).toHaveBeenCalledWith({
			modelId: "gpt-listed-only",
			openai: expect.objectContaining({ customModelEnabled: false }),
		})
	})

	it("keeps the custom-model switch on when a catalog model is committed", () => {
		const onUpdate = vi.fn()
		const profile = {
			id: "official-openai",
			provider: "openai",
			modelId: "gpt-multi",
			openai: OpenAiProviderConfig.create({ customModelEnabled: true }),
		} as unknown as ApiProfile

		render(<OpenAIProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)

		fireEvent.change(screen.getByRole("textbox", { name: "Model ID" }), { target: { value: "gpt-custom" } })

		expect(onUpdate).toHaveBeenCalledWith({ modelId: "gpt-custom" })
	})

	it("refreshes the provider listing when the picker opens", async () => {
		const profile = {
			id: "discovered-openai",
			provider: "openai",
			apiKey: "secret",
			baseUrl: "https://gateway.example.test",
			modelId: "gpt-multi",
			openai: OpenAiProviderConfig.create(),
		} as unknown as ApiProfile

		render(<OpenAIProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)

		fireEvent.click(screen.getByRole("button", { name: "Open Model" }))

		await waitFor(() => expect(refreshRemoteModels).toHaveBeenCalled())
	})

	it("uses provider capabilities for configuration updates and merged display", () => {
		const onUpdate = vi.fn()
		const profile = {
			id: "profile-1",
			provider: "openai",
			modelId: "gpt-custom",
			openai: OpenAiProviderConfig.create({
				customModelEnabled: true,
				capabilities: { maxTokens: 64_000 } as ModelCapabilities,
				pricing: { inputPrice: 0.5 } as ModelPricing,
			}),
		} as unknown as ApiProfile

		render(<OpenAIProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)

		expect(screen.getByText("max:64000")).toBeInTheDocument()
		expect(screen.getByText("input:0.5")).toBeInTheDocument()
		expect(screen.getByTestId("capability-fields")).toHaveTextContent(
			"supportsImages,hostedWebSearch,supportsBrowserAction,supportsPromptCache",
		)

		fireEvent.click(screen.getByText("Update Images"))

		expect(onUpdate).toHaveBeenCalledWith({
			openai: {
				...profile.openai,
				capabilities: { maxTokens: 64_000, supportsImages: true },
			},
		})

		// The profile prop has not echoed the previous click back yet, so this
		// update must build on it instead of reverting to the rendered config.
		fireEvent.click(screen.getByRole("button", { name: "Enable Native Tools" }))
		expect(onUpdate).toHaveBeenCalledWith({
			openai: {
				...profile.openai,
				capabilities: { maxTokens: 64_000, supportsImages: true, supportsTools: true },
			},
		})
	})

	it("keeps Service Tier disabled when the OpenAI Profile has not explicitly enabled it", () => {
		const profile = {
			id: "profile-1",
			provider: "openai",
			modelId: "gpt-multi",
			openai: OpenAiProviderConfig.create(),
		} as unknown as ApiProfile

		render(<OpenAIProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)

		expect(screen.getByTestId("service-tier-enabled")).toHaveTextContent("false")
	})

	it("uses a responsive field grid for custom headers", () => {
		const profile = {
			id: "profile-headers",
			provider: "openai",
			modelId: "gpt-multi",
			openai: OpenAiProviderConfig.create({ openAiHeaders: { Authorization: "Bearer token" } }),
		} as unknown as ApiProfile

		render(<OpenAIProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)

		const row = screen.getByTestId("custom-header-row")
		expect(row).toHaveClass("grid-cols-1", "xs:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]")
		expect(screen.getByRole("textbox", { name: "Header name" })).toHaveClass("min-h-7", "w-full")
		expect(screen.getByRole("textbox", { name: "Header value" })).toHaveClass("min-h-7", "w-full")
		expect(screen.getByRole("button", { name: "Remove" }).parentElement).toHaveClass("justify-end", "xs:self-end")
	})

	it("shows the configured output price instead of the registry default", () => {
		const profile = {
			id: "profile-1",
			provider: "openai",
			modelId: "gpt-custom",
			openai: OpenAiProviderConfig.create({
				customModelEnabled: false,
				pricing: { inputPrice: 1.25, outputPrice: 2.5 } as ModelPricing,
			}),
		} as unknown as ApiProfile

		render(<OpenAIProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)

		// The registry model prices output at 2, so a stale read shows that instead.
		expect(screen.getByText("output:2.5")).toBeInTheDocument()
	})

	it("keeps an earlier pricing edit when the next edit runs before the profile echoes back", () => {
		const onUpdate = vi.fn()
		const profile = {
			id: "profile-1",
			provider: "openai",
			modelId: "gpt-custom",
			openai: OpenAiProviderConfig.create({ customModelEnabled: true }),
		} as unknown as ApiProfile

		render(<OpenAIProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)

		// Each debounced price field commits on its own timer, so a second field can
		// save before the parent re-renders with the first field's value. Both edits
		// must survive that window.
		fireEvent.click(screen.getByRole("button", { name: "Set Input Price" }))
		fireEvent.click(screen.getByRole("button", { name: "Set Output Price" }))

		expect(onUpdate).toHaveBeenLastCalledWith({
			openai: expect.objectContaining({
				pricing: expect.objectContaining({ inputPrice: 1.25, outputPrice: 2.5 }),
			}),
		})
	})

	it("shows the default Responses stream idle timeout and persists a positive number of seconds", () => {
		const onUpdate = vi.fn()
		const profile = {
			id: "profile-1",
			provider: "openai",
			modelId: "gpt-multi",
			openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_RESPONSES }),
		} as unknown as ApiProfile

		render(<OpenAIProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)

		const input = screen.getByRole("textbox", { name: "Responses stream idle timeout (seconds)" })
		expect(input).toHaveValue("120")
		fireEvent.change(input, { target: { value: "45" } })
		expect(onUpdate).toHaveBeenCalledWith({
			openai: expect.objectContaining({ streamIdleTimeoutSeconds: 45 }),
		})
	})

	it("uses the declared compatible efforts while preserving OpenAI request options", () => {
		const onUpdate = vi.fn()
		const profile = {
			id: "profile-1",
			provider: "openai",
			modelId: "gpt-custom",
			modelInfo: {
				id: "gpt-custom",
				capabilities: {
					thinking: { supported: true, mode: "effort", effortLevels: ["none", "custom"] },
				},
			},
			openai: OpenAiProviderConfig.create({ customModelEnabled: true, serviceTier: "auto", serviceTierEnabled: true }),
		} as unknown as ApiProfile

		render(<OpenAIProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)

		expect(screen.getByTestId("thinking-efforts")).toHaveTextContent("none,custom")
		expect(screen.getByTestId("service-tier-enabled")).toHaveTextContent("true")

		// Each control replaces the whole provider config, and the profile prop
		// only echoes a save back after the backend commits it. Editing several
		// controls in a row must therefore accumulate: rebuilding from the prop
		// each time would silently drop every edit but the last.
		fireEvent.click(screen.getByRole("button", { name: "Set Priority Tier" }))
		expect(onUpdate).toHaveBeenLastCalledWith({
			openai: {
				...profile.openai,
				serviceTier: "priority",
			},
		})

		fireEvent.click(screen.getByRole("button", { name: "Disable Service Tier" }))
		expect(onUpdate).toHaveBeenLastCalledWith({
			openai: {
				...profile.openai,
				serviceTier: "priority",
				serviceTierEnabled: false,
			},
		})

		fireEvent.click(screen.getByRole("checkbox", { name: "Use explicit prompt cache controls" }))
		expect(onUpdate).toHaveBeenLastCalledWith({
			openai: {
				...profile.openai,
				serviceTier: "priority",
				serviceTierEnabled: false,
				promptCacheMode: OpenAiPromptCacheMode.OPENAI_PROMPT_CACHE_MODE_EXPLICIT,
			},
		})

		fireEvent.change(screen.getByRole("combobox", { name: "API Format" }), {
			target: { value: String(ApiFormat.OPENAI_RESPONSES) },
		})
		expect(onUpdate).toHaveBeenLastCalledWith({
			openai: {
				...profile.openai,
				serviceTier: "priority",
				serviceTierEnabled: false,
				promptCacheMode: OpenAiPromptCacheMode.OPENAI_PROMPT_CACHE_MODE_EXPLICIT,
				apiEndpoint: undefined,
				apiFormat: ApiFormat.OPENAI_RESPONSES,
			},
		})
	})

	it("does not show a compatibility notice for a catalog model with known metadata", () => {
		const profile = {
			id: "official-openai",
			provider: "openai",
			modelId: "gpt-multi",
			openai: OpenAiProviderConfig.create(),
		} as unknown as ApiProfile

		render(<OpenAIProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)

		expect(screen.queryByText("Dline uses complex prompts", { exact: false })).not.toBeInTheDocument()
		expect(screen.queryByText("Model metadata incomplete")).not.toBeInTheDocument()
	})

	it("shows metadata guidance for a custom model without prompt-relevant metadata", () => {
		const profile = {
			id: "custom-openai",
			provider: "openai",
			modelId: "custom-model",
			openai: OpenAiProviderConfig.create({ customModelEnabled: true }),
		} as unknown as ApiProfile

		render(<OpenAIProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)

		expect(screen.getByText("Model metadata incomplete")).toBeInTheDocument()
		expect(screen.getByRole("status")).toHaveTextContent("Confirm the context window and native tool support")
	})

	it("shows Lite prompt guidance for a custom model below 64K context", () => {
		const profile = {
			id: "small-openai",
			provider: "openai",
			modelId: "small-model",
			openai: OpenAiProviderConfig.create({
				customModelEnabled: true,
				capabilities: { contextWindow: 32_768, supportsTools: false } as ModelCapabilities,
			}),
		} as unknown as ApiProfile

		render(<OpenAIProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)

		expect(screen.getByText("Lite prompt profile")).toBeInTheDocument()
		expect(screen.getByRole("status")).toHaveTextContent("below 64K tokens")
	})
})

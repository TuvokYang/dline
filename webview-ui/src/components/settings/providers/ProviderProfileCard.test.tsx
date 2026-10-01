import { ApiFormat, ServerTool, type ThinkingConfig } from "@shared/proto/dline/models/metadata"
import { ApiProfile, type ImageGenerationProfile, ImageGenerationSource } from "@shared/proto/dline/profile"
import { AnthropicProviderConfig } from "@shared/proto/dline/provider/anthropic"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
import { OpenAiProviderConfig } from "@shared/proto/dline/provider/openai"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import ProviderProfileCard from "./ProviderProfileCard"

const providerCatalog = vi.hoisted(() => ({
	anthropic: {
		defaultModelId: "claude-chat",
		defaultImageModelId: "",
		models: { "claude-chat": { id: "claude-chat", name: "Claude Chat" } },
		imageModels: {},
	},
	gemini: {
		defaultModelId: "gemini-chat",
		defaultImageModelId: "gemini-3.1-flash-image",
		models: { "gemini-chat": { id: "gemini-chat", name: "Gemini Chat" } },
		imageModels: {
			"gemini-3.1-flash-image": {
				id: "gemini-3.1-flash-image",
				name: "Nano Banana 2",
			},
		},
	},
	openai: {
		defaultModelId: "model-a",
		defaultImageModelId: "gpt-image-2.5",
		models: {
			"model-a": {
				id: "model-a",
				name: "Model A",
				apiFormats: [4],
				capabilities: { tools: [2] },
			},
		},
		imageModels: {
			"gpt-image-1": { id: "gpt-image-1", name: "GPT Image 1" },
			"gpt-image-2": { id: "gpt-image-2", name: "GPT Image 2" },
			"gpt-image-2.5": { id: "gpt-image-2.5", name: "GPT Image 2.5" },
			"gpt-image-2-sub": { id: "gpt-image-2-sub", name: "GPT Image 2 (Subscription)" },
		},
	},
	"openai-codex": {
		defaultModelId: "gpt-5",
		defaultImageModelId: "gpt-image-2.5",
		models: { "gpt-5": { id: "gpt-5", name: "GPT-5" } },
		imageModels: {
			"gpt-image-1": { id: "gpt-image-1", name: "GPT Image 1" },
			"gpt-image-2.5": { id: "gpt-image-2.5", name: "GPT Image 2.5" },
		},
	},
}))

vi.mock("./useProviderModels", () => ({
	getCachedProviderDefaultImageModelId: (providerId: keyof typeof providerCatalog) =>
		providerCatalog[providerId]?.defaultImageModelId ?? "",
	getCachedProviderDefaultModelId: (providerId: keyof typeof providerCatalog) =>
		providerCatalog[providerId]?.defaultModelId ?? "",
	useProviderModels: (providerId: keyof typeof providerCatalog) => ({
		...(providerCatalog[providerId] ?? {
			defaultModelId: "",
			defaultImageModelId: "",
			models: {},
			imageModels: {},
		}),
		loading: false,
	}),
}))

vi.mock("./ProviderProfileEditor", () => ({
	default: () => <div>Provider editor</div>,
}))

const providerOptions = [
	{ value: "openai", label: "OpenAI" },
	{ value: "openai-codex", label: "OpenAI Codex" },
	{ value: "gemini", label: "Google Gemini" },
	{ value: "anthropic", label: "Anthropic" },
]

/**
 * Build a profile fixture for card rendering tests.
 * @returns Api profile test fixture.
 */
function buildProfile(): ApiProfile {
	return ApiProfile.create({
		id: "profile-1",
		name: "openai:model-a",
		provider: "openai",
		modelId: "model-a",
		usedFor: ["act", "plan"],
		enabled: true,
	})
}

describe("ProviderProfileCard", () => {
	it("renders the profile name as text while collapsed outside Manage mode", () => {
		render(
			<ProviderProfileCard
				currentMode="act"
				editMode={false}
				isExpanded={false}
				onDelete={vi.fn()}
				onToggleExpand={vi.fn()}
				onUpdate={vi.fn()}
				profile={buildProfile()}
				providerOptions={providerOptions}
			/>,
		)

		expect(screen.getByText("openai:model-a")).toBeInTheDocument()
		expect(screen.queryByDisplayValue("openai:model-a")).not.toBeInTheDocument()
		expect(screen.getByText("openai · model-a")).toBeInTheDocument()
	})

	it("keeps the profile name input editable while expanded", () => {
		const onUpdate = vi.fn()

		render(
			<ProviderProfileCard
				currentMode="act"
				editMode={false}
				isExpanded={true}
				onDelete={vi.fn()}
				onToggleExpand={vi.fn()}
				onUpdate={onUpdate}
				profile={buildProfile()}
				providerOptions={providerOptions}
			/>,
		)

		const nameInput = screen.getByDisplayValue("openai:model-a")
		expect(nameInput).toHaveClass("max-w-80", "justify-self-start")
		fireEvent.change(nameInput, { target: { value: "openai:custom" } })
		expect(onUpdate).not.toHaveBeenCalled()
		fireEvent.blur(nameInput)

		expect(onUpdate).toHaveBeenCalledWith({ name: "openai:custom" })
	})

	it("shows effort-based Thinking in the second-line provider summary", () => {
		const profile = ApiProfile.create({
			...buildProfile(),
			openai: OpenAiProviderConfig.create({
				capabilities: {
					supportsReasoning: true,
					thinking: { supported: true, mode: "effort", effortLevels: ["low", "medium", "high"] },
				},
				reasoning: { enableThinking: true, effort: "high", thinkingBudget: 0 },
			}),
		})
		render(
			<ProviderProfileCard
				currentMode="act"
				editMode={false}
				isExpanded={false}
				onDelete={vi.fn()}
				onToggleExpand={vi.fn()}
				onUpdate={vi.fn()}
				profile={profile}
				providerOptions={providerOptions}
			/>,
		)

		expect(screen.getByText("openai · model-a · Thinking: High")).toBeInTheDocument()
	})

	it("shows budget-based Thinking in the second-line provider summary", () => {
		const profile = ApiProfile.create({
			...buildProfile(),
			openai: OpenAiProviderConfig.create({
				capabilities: { supportsReasoning: true, thinking: { supported: true, mode: "budget", maxBudget: 16_384 } },
				reasoning: { enableThinking: true, effort: "", thinkingBudget: 8_192 },
			}),
		})
		render(
			<ProviderProfileCard
				currentMode="act"
				editMode={false}
				isExpanded={false}
				onDelete={vi.fn()}
				onToggleExpand={vi.fn()}
				onUpdate={vi.fn()}
				profile={profile}
				providerOptions={providerOptions}
			/>,
		)

		expect(screen.getByText("openai · model-a · Thinking: 8,192 tokens")).toBeInTheDocument()
	})

	it.each<{
		name: string
		thinking: ThinkingConfig
		reasoning: ReasoningConfig
		summary?: string
	}>([
		{
			name: "effort ignores a stale positive budget",
			thinking: { supported: true, mode: "effort", effortLevels: ["low"], maxBudget: 2000 },
			reasoning: { effort: "low", thinkingBudget: 1500 },
			summary: "Thinking: Low",
		},
		{
			name: "effort does not activate from a budget alone",
			thinking: { supported: true, mode: "effort", effortLevels: ["low"], maxBudget: 2000 },
			reasoning: { thinkingBudget: 1500 },
		},
		{
			name: "an effort default does not imply a default-enabled model",
			thinking: { supported: true, mode: "effort", effortLevels: ["low"], defaultEffort: "low", defaultEnabled: false },
			reasoning: {},
		},
		{
			name: "budget does not activate from an effort alone",
			thinking: { supported: true, mode: "budget", maxBudget: 2000 },
			reasoning: { effort: "low" },
		},
		{
			name: "a maximum does not declare a mode",
			thinking: { supported: true, maxBudget: 2000 },
			reasoning: { enableThinking: true, thinkingBudget: 1500 },
		},
		{
			name: "a budget without a declared maximum remains displayable",
			thinking: { supported: true, mode: "budget", minBudget: 17 },
			reasoning: { thinkingBudget: 23 },
			summary: "Thinking: 23 tokens",
		},
		{
			name: "the summary applies the effective positive-budget minimum",
			thinking: { supported: true, mode: "budget", minBudget: 17, maxBudget: 101 },
			reasoning: { thinkingBudget: 3 },
			summary: "Thinking: 17 tokens",
		},
		{
			name: "zero overrides a default-enabled optional budget",
			thinking: { supported: true, mode: "budget", maxBudget: 101, defaultEnabled: true },
			reasoning: { enableThinking: true, thinkingBudget: 0 },
			summary: "Thinking: Off",
		},
		{
			name: "required effort discards a stale disabled preference",
			thinking: { supported: true, mode: "effort", effortLevels: ["low"], defaultEffort: "low", canDisable: false },
			reasoning: { enableThinking: false, effort: "none" },
			summary: "Thinking: On",
		},
		{
			name: "required budget does not display stale zero as disabled",
			thinking: { supported: true, mode: "budget", minBudget: 17, canDisable: false },
			reasoning: { enableThinking: false, thinkingBudget: 0 },
			summary: "Thinking: Budget",
		},
		{
			name: "invalid bounds do not produce a token summary",
			thinking: { supported: true, mode: "budget", minBudget: 17, maxBudget: 11 },
			reasoning: { enableThinking: true, thinkingBudget: 23 },
		},
	])("renders the effective declaration: $name", ({ thinking, reasoning, summary }) => {
		const onUpdate = vi.fn()
		const profile = ApiProfile.create({
			...buildProfile(),
			openai: { capabilities: { thinking }, reasoning },
		})
		render(
			<ProviderProfileCard
				currentMode="act"
				editMode={false}
				isExpanded={false}
				onDelete={vi.fn()}
				onToggleExpand={vi.fn()}
				onUpdate={onUpdate}
				profile={profile}
				providerOptions={providerOptions}
			/>,
		)
		expect(screen.getByText(["openai", "model-a", summary].filter(Boolean).join(" · "))).toBeInTheDocument()
		expect(onUpdate).not.toHaveBeenCalled()
	})

	it("keeps usage badges and capability icons in a right-aligned tail", () => {
		const profile = ApiProfile.create({
			...buildProfile(),
			modelInfo: { capabilities: { supportsImages: true, supportsReasoning: true } },
		})
		render(
			<ProviderProfileCard
				currentMode="act"
				editMode={false}
				isExpanded={false}
				onDelete={vi.fn()}
				onToggleExpand={vi.fn()}
				onUpdate={vi.fn()}
				profile={profile}
				providerOptions={providerOptions}
			/>,
		)

		const tail = screen.getByTestId("profile-summary-tail")
		expect(tail).toHaveClass("ml-auto", "shrink-0", "justify-end", "row-start-2", "xs:row-start-1")
		const usageGroup = screen.getByRole("group", { name: "Profile uses" })
		expect(usageGroup).toBeInTheDocument()
		expect(usageGroup.querySelectorAll("span")).not.toHaveLength(0)
		for (const badge of usageGroup.querySelectorAll("span")) expect(badge).toHaveClass("h-5")
		expect(screen.getByRole("list", { name: "Model capabilities" })).toBeInTheDocument()
		expect(screen.queryByText("🧠")).not.toBeInTheDocument()
	})

	it("uses muted settings-compatible card surfaces", () => {
		const { container } = render(
			<ProviderProfileCard
				currentMode="act"
				editMode={false}
				isExpanded={true}
				onDelete={vi.fn()}
				onToggleExpand={vi.fn()}
				onUpdate={vi.fn()}
				profile={buildProfile()}
				providerOptions={providerOptions}
			/>,
		)

		const card = container.firstElementChild
		const body = screen.getByText("Provider editor").closest(".profile-form")

		expect(card).toHaveClass("border-b", "border-editor-widget-border/35")
		expect(card).not.toHaveClass("bg-(--vscode-editor-background)")
		expect(body).toHaveClass("profile-form", "border-editor-widget-border/30", "gap-4")
		expect(screen.getByText("Provider editor").parentElement).toHaveClass(
			"gap-3",
			"[&>div]:flex",
			"[&>div]:flex-col",
			"[&>div]:!gap-3",
		)
	})

	it("initializes a newly selected Anthropic provider with long context enabled", () => {
		const onUpdate = vi.fn()
		render(
			<ProviderProfileCard
				currentMode="act"
				editMode={false}
				isExpanded={true}
				onDelete={vi.fn()}
				onToggleExpand={vi.fn()}
				onUpdate={onUpdate}
				profile={ApiProfile.create({ ...buildProfile(), provider: "", modelId: "" })}
				providerOptions={providerOptions}
			/>,
		)

		fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), { target: { value: "anthropic" } })

		expect(onUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "anthropic",
				anthropic: AnthropicProviderConfig.create({ enableLongContext: true }),
			}),
		)
	})

	it("delegates Web Search settings to the provider editor without rendering a duplicate outer control", () => {
		render(
			<ProviderProfileCard
				currentMode="act"
				editMode={false}
				isExpanded={true}
				onDelete={vi.fn()}
				onToggleExpand={vi.fn()}
				onUpdate={vi.fn()}
				profile={buildProfile()}
				providerOptions={providerOptions}
			/>,
		)

		expect(screen.queryByRole("combobox", { name: "Web Tools mode" })).not.toBeInTheDocument()
	})

	it("shows image configuration only when the global feature is enabled", () => {
		const profile = buildProfile()
		const { rerender } = render(
			<ProviderProfileCard
				currentMode="act"
				editMode={false}
				imageGenerationEnabled={false}
				isExpanded={true}
				onDelete={vi.fn()}
				onToggleExpand={vi.fn()}
				onUpdate={vi.fn()}
				profile={profile}
				providerOptions={providerOptions}
			/>,
		)
		expect(screen.queryByRole("combobox", { name: "Image source" })).not.toBeInTheDocument()

		rerender(
			<ProviderProfileCard
				currentMode="act"
				editMode={false}
				imageGenerationEnabled={true}
				isExpanded={true}
				onDelete={vi.fn()}
				onToggleExpand={vi.fn()}
				onUpdate={vi.fn()}
				profile={profile}
				providerOptions={providerOptions}
			/>,
		)
		expect(screen.getByRole("combobox", { name: "Image source" })).toHaveValue(
			String(ImageGenerationSource.IMAGE_GENERATION_SOURCE_UNSPECIFIED),
		)
		expect(screen.getByRole("option", { name: "None" })).toBeInTheDocument()
		expect(screen.queryByRole("combobox", { name: "Image model" })).not.toBeInTheDocument()
		expect(screen.queryByRole("checkbox", { name: "Image" })).not.toBeInTheDocument()
	})

	it("shows GPT image models from provider metadata and persists the selected model", () => {
		const onUpdate = vi.fn()
		const profile = ApiProfile.create({
			...buildProfile(),
			modelId: "custom-responses-model",
			modelInfo: { id: "custom-responses-model", apiFormats: [ApiFormat.OPENAI_RESPONSES] },
			imageSource: ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION,
			openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_RESPONSES }),
		})

		render(
			<ProviderProfileCard
				currentMode="act"
				editMode={false}
				imageGenerationEnabled={true}
				isExpanded={true}
				onDelete={vi.fn()}
				onToggleExpand={vi.fn()}
				onUpdate={onUpdate}
				profile={profile}
				providerOptions={providerOptions}
			/>,
		)

		const imageModel = screen.getByRole("combobox", { name: "Image model" })
		expect(imageModel).toHaveValue("gpt-image-2.5")
		expect(screen.getByRole("option", { name: "GPT Image 1" })).toBeInTheDocument()
		expect(screen.getByRole("option", { name: "GPT Image 2" })).toBeInTheDocument()
		expect(screen.queryByRole("option", { name: "GPT Image 2 (Subscription)" })).not.toBeInTheDocument()

		fireEvent.change(imageModel, { target: { value: "gpt-image-1" } })
		expect(onUpdate).toHaveBeenCalledWith({ imageModelId: "gpt-image-1" })
	})

	it("hides the subscription alias from an Independent OpenAI Images connection", () => {
		const profile = ApiProfile.create({
			...buildProfile(),
			imageSource: ImageGenerationSource.IMAGE_GENERATION_SOURCE_INDEPENDENT,
			imageProfileId: "independent-openai",
			imageModelId: "gpt-image-2",
		})
		const imageProfiles: ImageGenerationProfile[] = [
			{ id: "independent-openai", name: "Independent OpenAI", provider: "openai", enabled: true, legacyNames: [] },
		]

		render(
			<ProviderProfileCard
				currentMode="act"
				editMode={false}
				imageGenerationEnabled={true}
				imageProfiles={imageProfiles}
				isExpanded={true}
				onDelete={vi.fn()}
				onToggleExpand={vi.fn()}
				onUpdate={vi.fn()}
				profile={profile}
				providerOptions={providerOptions}
			/>,
		)

		expect(screen.getByRole("option", { name: "GPT Image 2" })).toBeInTheDocument()
		expect(screen.queryByRole("option", { name: "GPT Image 2 (Subscription)" })).not.toBeInTheDocument()
	})

	it("shows Independent source controls and uses the selected Image Profile provider catalog", () => {
		const imageProfiles = [
			{
				id: "independent-gemini",
				name: "Independent Gemini",
				provider: "gemini",
				baseUrl: "https://images.example.test",
				enabled: true,
				legacyNames: [],
			},
		] as ImageGenerationProfile[]
		const profile = {
			...buildProfile(),
			provider: "anthropic",
			modelId: "claude-chat",
			usedFor: ["act"],
			imageSource: ImageGenerationSource.IMAGE_GENERATION_SOURCE_INDEPENDENT,
			imageProfileId: imageProfiles[0].id,
			imageModelId: "gemini-3.1-flash-image",
		} as ApiProfile

		render(
			<ProviderProfileCard
				currentMode="act"
				editMode={false}
				imageGenerationEnabled={true}
				imageProfiles={imageProfiles}
				isExpanded={true}
				onDelete={vi.fn()}
				onToggleExpand={vi.fn()}
				onUpdate={vi.fn()}
				profile={profile}
				providerOptions={providerOptions}
			/>,
		)

		expect(screen.queryByRole("checkbox", { name: "Image" })).not.toBeInTheDocument()
		expect(screen.getByRole("combobox", { name: "Image source" })).toHaveValue(
			String(ImageGenerationSource.IMAGE_GENERATION_SOURCE_INDEPENDENT),
		)
		expect(screen.getByRole("combobox", { name: "Image profile" })).toHaveValue("independent-gemini")
		expect(screen.getByRole("combobox", { name: "Image model" })).toHaveValue("gemini-3.1-flash-image")
	})

	it("shows GPT Subscription, GPT API, Independent, and Hosted sources with API billing guidance", () => {
		const profile = ApiProfile.create({
			...buildProfile(),
			usedFor: ["act"],
			imageSource: ImageGenerationSource.IMAGE_GENERATION_SOURCE_HOSTED,
			modelInfo: {
				id: "model-a",
				apiFormats: [ApiFormat.OPENAI_RESPONSES],
			},
			openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_RESPONSES }),
		})
		render(
			<ProviderProfileCard
				currentMode="act"
				editMode={false}
				imageGenerationEnabled={true}
				isExpanded={true}
				onDelete={vi.fn()}
				onToggleExpand={vi.fn()}
				onUpdate={vi.fn()}
				profile={profile}
				providerOptions={providerOptions}
			/>,
		)

		const source = screen.getByRole("combobox", { name: "Image source" })
		expect(source).toHaveValue(String(ImageGenerationSource.IMAGE_GENERATION_SOURCE_HOSTED))
		expect(screen.getByRole("option", { name: "None" })).toBeInTheDocument()
		expect(screen.getByRole("option", { name: "GPT Subscription" })).toBeInTheDocument()
		expect(screen.getByRole("option", { name: "GPT API" })).toBeInTheDocument()
		expect(screen.queryByRole("option", { name: "Independent" })).not.toBeInTheDocument()
		expect(screen.getByRole("option", { name: "Hosted" })).toBeEnabled()
		expect(screen.queryByRole("combobox", { name: "Image model" })).not.toBeInTheDocument()
		expect(screen.getByText(/separate API Platform billing/)).toBeInTheDocument()
		expect(screen.getByText(/ChatGPT\/GPT subscriptions are not used/)).toBeInTheDocument()
	})

	it("limits OpenAI Codex to None, GPT Subscription, Independent, and Hosted", () => {
		const profile = ApiProfile.create({
			...buildProfile(),
			provider: "openai-codex",
			modelId: "gpt-5",
			imageSource: ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION,
			imageModelId: "gpt-image-2.5",
		})
		const imageProfiles: ImageGenerationProfile[] = [
			{ id: "independent-openai", name: "Independent OpenAI", provider: "openai", enabled: true, legacyNames: [] },
		]

		render(
			<ProviderProfileCard
				currentMode="act"
				editMode={false}
				imageGenerationEnabled={true}
				imageProfiles={imageProfiles}
				isExpanded={true}
				onDelete={vi.fn()}
				onToggleExpand={vi.fn()}
				onUpdate={vi.fn()}
				profile={profile}
				providerOptions={providerOptions}
			/>,
		)

		expect(screen.getByRole("option", { name: "None" })).toBeInTheDocument()
		expect(screen.getByRole("option", { name: "GPT Subscription" })).toBeInTheDocument()
		expect(screen.getByRole("option", { name: "Independent" })).toBeInTheDocument()
		expect(screen.queryByRole("option", { name: "GPT API" })).not.toBeInTheDocument()
		expect(screen.getByRole("option", { name: "Hosted" })).toBeInTheDocument()
	})

	it("selects Hosted without interception and clears local image bindings", () => {
		const onUpdate = vi.fn()
		const profile = ApiProfile.create({
			...buildProfile(),
			usedFor: ["act"],
			imageSource: ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION,
			imageModelId: "gpt-image-2",
			modelInfo: {
				id: "model-a",
				apiFormats: [ApiFormat.OPENAI_RESPONSES],
				capabilities: { tools: [ServerTool.IMAGE_GENERATION] },
			},
			openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_RESPONSES }),
		})
		render(
			<ProviderProfileCard
				currentMode="act"
				editMode={false}
				imageGenerationEnabled={true}
				isExpanded={true}
				onDelete={vi.fn()}
				onToggleExpand={vi.fn()}
				onUpdate={onUpdate}
				profile={profile}
				providerOptions={providerOptions}
			/>,
		)

		fireEvent.change(screen.getByRole("combobox", { name: "Image source" }), {
			target: { value: String(ImageGenerationSource.IMAGE_GENERATION_SOURCE_HOSTED) },
		})

		expect(onUpdate).toHaveBeenCalledWith({
			imageSource: ImageGenerationSource.IMAGE_GENERATION_SOURCE_HOSTED,
			imageProfileId: undefined,
			imageModelId: undefined,
		})
	})

	it("selects None and clears all image bindings", () => {
		const onUpdate = vi.fn()
		const profile = ApiProfile.create({
			...buildProfile(),
			imageSource: ImageGenerationSource.IMAGE_GENERATION_SOURCE_INDEPENDENT,
			imageProfileId: "independent-gemini",
			imageModelId: "gemini-3.1-flash-image",
		})
		render(
			<ProviderProfileCard
				currentMode="act"
				editMode={false}
				imageGenerationEnabled={true}
				isExpanded={true}
				onDelete={vi.fn()}
				onToggleExpand={vi.fn()}
				onUpdate={onUpdate}
				profile={profile}
				providerOptions={providerOptions}
			/>,
		)

		fireEvent.change(screen.getByRole("combobox", { name: "Image source" }), {
			target: { value: String(ImageGenerationSource.IMAGE_GENERATION_SOURCE_UNSPECIFIED) },
		})

		expect(onUpdate).toHaveBeenCalledWith({
			imageSource: ImageGenerationSource.IMAGE_GENERATION_SOURCE_UNSPECIFIED,
			imageProfileId: undefined,
			imageModelId: undefined,
		})
	})

	it("hides image configuration when the global feature is disabled without mutating saved fields", () => {
		const onUpdate = vi.fn()
		const profile = {
			...buildProfile(),
			imageModelId: "gpt-image-2",
			imageSource: ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION,
		} as ApiProfile
		render(
			<ProviderProfileCard
				currentMode="act"
				editMode={false}
				imageGenerationEnabled={false}
				isExpanded={true}
				onDelete={vi.fn()}
				onToggleExpand={vi.fn()}
				onUpdate={onUpdate}
				profile={profile}
				providerOptions={providerOptions}
			/>,
		)

		expect(screen.queryByRole("combobox", { name: "Image source" })).not.toBeInTheDocument()
		expect(onUpdate).not.toHaveBeenCalled()
		expect(profile).toHaveProperty("imageModelId", "gpt-image-2")
	})

	it.each([
		ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION,
		ImageGenerationSource.IMAGE_GENERATION_SOURCE_HOSTED,
	])("clears an OpenAI-only image source when the provider changes", (imageSource) => {
		const onUpdate = vi.fn()
		const profile = {
			...buildProfile(),
			imageSource,
			imageModelId:
				imageSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION ? "gpt-image-2" : undefined,
			usedFor: ["act"],
		} as ApiProfile
		render(
			<ProviderProfileCard
				currentMode="act"
				editMode={false}
				imageGenerationEnabled={true}
				isExpanded={true}
				onDelete={vi.fn()}
				onToggleExpand={vi.fn()}
				onUpdate={onUpdate}
				profile={profile}
				providerOptions={providerOptions}
			/>,
		)

		fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), { target: { value: "gemini" } })

		expect(onUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "gemini",
				modelId: "gemini-chat",
				imageSource: ImageGenerationSource.IMAGE_GENERATION_SOURCE_UNSPECIFIED,
				imageProfileId: undefined,
				imageModelId: undefined,
			}),
		)
	})

	it("does not render unavailable image source options", () => {
		const profile = { ...buildProfile(), provider: "anthropic", modelId: "claude-chat" }
		render(
			<ProviderProfileCard
				currentMode="act"
				editMode={false}
				imageGenerationEnabled={true}
				isExpanded={true}
				onDelete={vi.fn()}
				onToggleExpand={vi.fn()}
				onUpdate={vi.fn()}
				profile={profile}
				providerOptions={providerOptions}
			/>,
		)

		expect(screen.getByRole("option", { name: "None" })).toBeInTheDocument()
		expect(screen.getByRole("combobox", { name: "Image source" })).toHaveValue(
			String(ImageGenerationSource.IMAGE_GENERATION_SOURCE_UNSPECIFIED),
		)
		expect(screen.queryByRole("option", { name: "Current" })).not.toBeInTheDocument()
		expect(screen.queryByRole("option", { name: "Independent" })).not.toBeInTheDocument()
		expect(screen.queryByRole("option", { name: "Hosted" })).not.toBeInTheDocument()
		expect(screen.queryByRole("checkbox", { name: "Image" })).not.toBeInTheDocument()
	})

	it("does not show Image as a usage badge for a legacy persisted use", () => {
		const profile = { ...buildProfile(), usedFor: ["act", "image"] }
		render(
			<ProviderProfileCard
				currentMode="act"
				editMode={false}
				isExpanded={false}
				onDelete={vi.fn()}
				onToggleExpand={vi.fn()}
				onUpdate={vi.fn()}
				profile={profile}
				providerOptions={providerOptions}
			/>,
		)

		expect(screen.getByText("ACT")).toBeInTheDocument()
		expect(screen.queryByText("Image")).not.toBeInTheDocument()
	})
})

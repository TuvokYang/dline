// @vitest-environment jsdom
import type { ModelInfo } from "@shared/proto/dline/models"
import { ApiProfile } from "@shared/proto/dline/profile"
import { fireEvent, render, screen } from "@testing-library/react"
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AIhubmixProvider } from "./AihubmixProvider"
import { AskSageProvider } from "./AskSageProvider"
import { BasetenProvider } from "./BasetenProvider"
import { BedrockProvider } from "./BedrockProvider"
import { CerebrasProvider } from "./CerebrasProvider"
import { DoubaoProvider } from "./DoubaoProvider"
import { FireworksProvider } from "./FireworksProvider"
import { GeminiProvider } from "./GeminiProvider"
import { GroqProvider } from "./GroqProvider"
import { HicapProvider } from "./HicapProvider"
import { HuaweiCloudMaasProvider } from "./HuaweiCloudMaasProvider"
import { HuggingFaceProvider } from "./HuggingFaceProvider"
import { MinimaxProvider } from "./MiniMaxProvider"
import { MistralProvider } from "./MistralProvider"
import { MoonshotProvider } from "./MoonshotProvider"
import { NebiusProvider } from "./NebiusProvider"
import { NousResearchProvider } from "./NousresearchProvider"
import { OcaProvider } from "./OcaProvider"
import { OpenAIProvider } from "./OpenAIProvider"
import { OpenAiCodexProvider } from "./OpenAiCodexProvider"
import { QwenCodeProvider } from "./QwenCodeProvider"
import { QwenProvider } from "./QwenProvider"
import { RequestyProvider } from "./RequestyProvider"
import { SambanovaProvider } from "./SambanovaProvider"
import { SapAiCoreProvider } from "./SapAiCoreProvider"
import { TogetherProvider } from "./TogetherProvider"
import { VercelAIGatewayProvider } from "./VercelAIGatewayProvider"
import { VertexProvider } from "./VertexProvider"
import { WandbProvider } from "./WandbProvider"
import { XaiProvider } from "./XaiProvider"
import { ZAiProvider } from "./ZAiProvider"

const models: Record<string, ModelInfo> = {
	"effort-alias": {
		id: "effort-alias",
		capabilities: {
			thinking: {
				supported: true,
				mode: "effort",
				effortLevels: ["low"],
				defaultEffort: "low",
				defaultEnabled: true,
				canDisable: false,
			},
		},
	},
	"budget-alias": {
		id: "budget-alias",
		capabilities: { thinking: { supported: true, mode: "budget", maxBudget: 3000, defaultEnabled: true } },
	},
}

vi.mock("./useProviderModels", () => ({
	useProviderModels: () => ({ models, defaultModelId: "effort-alias", modelInfoSaneDefaults: models["effort-alias"] }),
}))
vi.mock("./useProviderModelOptions", () => ({
	useProviderModelOptions: () => ({
		models,
		defaultModelId: "effort-alias",
		modelInfoSaneDefaults: models["effort-alias"],
		options: models,
		refreshRemoteModels: vi.fn(),
	}),
}))
vi.mock("./OpenAiCodexOAuthControl", () => ({ OpenAiCodexOAuthControl: () => null }))
vi.mock("../common/ModelAutocomplete", () => ({
	ModelAutocomplete: ({ onChange }: { onChange: (value: string) => void }) => (
		<input aria-label="Model" onChange={(event) => onChange(event.target.value)} />
	),
}))
vi.mock("../common/ModelConfiguration", () => ({ ModelConfiguration: () => null }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => ({ remoteConfigSettings: {} }) }))
vi.mock("../ApiOptions", () => ({
	DROPDOWN_Z_INDEX: 1000,
	DropdownContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock("../common/ModelSelector", () => ({
	DropdownContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	ModelSelector: ({
		onChange,
		selectedModelId,
	}: {
		onChange: React.ChangeEventHandler<HTMLInputElement>
		selectedModelId: string
	}) => <input aria-label="Model" onChange={onChange} value={selectedModelId} />,
}))
vi.mock("../common/ModelInfoView", () => ({
	ModelInfoView: ({ modelInfo }: { modelInfo: ModelInfo }) => (
		<>
			<span data-testid="model-id">{modelInfo.id}</span>
			<span data-testid="model-info">{JSON.stringify(modelInfo)}</span>
		</>
	),
}))
vi.mock("../common/DebouncedTextField", () => ({ DebouncedTextField: () => <div /> }))
vi.mock("../common/ApiKeyField", () => ({ ApiKeyField: () => <div /> }))
vi.mock("../common/BaseUrlField", () => ({ BaseUrlField: () => <div /> }))
vi.mock("../common/RemotelyConfiguredInputWrapper", () => ({
	RemotelyConfiguredInputWrapper: ({ children }: { children: ReactNode }) => <>{children}</>,
	LockIcon: () => <span />,
}))
vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
	TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
	TooltipContent: () => null,
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
		<button type="button" {...props}>
			{children}
		</button>
	),
	VSCodeCheckbox: ({ checked, disabled, onChange, children }: InputHTMLAttributes<HTMLInputElement>) => (
		<label>
			<input checked={checked} disabled={disabled} onChange={onChange} type="checkbox" />
			{children}
		</label>
	),
	VSCodeDropdown: (props: SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} />,
	VSCodeOption: ({ children, value }: { children: ReactNode; value: string }) => <option value={value}>{children}</option>,
	VSCodeRadioGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	VSCodeRadio: ({ children }: { children: ReactNode }) => <span>{children}</span>,
	VSCodeTextField: ({ children: _children, ...props }: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
	VSCodeLink: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
}))

for (const [provider, configKey, Panel] of [
	["baseten", "baseten", BasetenProvider],
	["groq", "groq", GroqProvider],
	["huawei-cloud-maas", "huaweiCloudMaas", HuaweiCloudMaasProvider],
	["minimax", "minimax", MinimaxProvider],
	["aihubmix", "aihubmix", AIhubmixProvider],
	["fireworks", "fireworks", FireworksProvider],
	["doubao", "doubao", DoubaoProvider],
	["cerebras", "cerebras", CerebrasProvider],
	["huggingface", "huggingface", HuggingFaceProvider],
	["asksage", "asksage", AskSageProvider],
	["zai", "zai", ZAiProvider],
	["xai", "xai", XaiProvider],
	["wandb", "wandb", WandbProvider],
	["together", "together", TogetherProvider],
	["sapaicore", "sapaicore", SapAiCoreProvider],
	["sambanova", "sambanova", SambanovaProvider],
	["requesty", "requesty", RequestyProvider],
	["nousResearch", "nousResearch", NousResearchProvider],
	["qwen-code", "qwenCode", QwenCodeProvider],
	["nebius", "nebius", NebiusProvider],
	["moonshot", "moonshot", MoonshotProvider],
	["mistral", "mistral", MistralProvider],
	["hicap", "hicap", HicapProvider],
] as const) {
	describe(`${provider} effective information projection`, () => {
		beforeEach(() => {
			if (provider === "asksage") {
				vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ response: [] }) }))
			}
		})
		afterEach(() => vi.unstubAllGlobals())

		it("rejects stale metadata and default capabilities for an explicit unknown selection", () => {
			const onUpdate = vi.fn()
			const profile = ApiProfile.create({ provider, modelId: "unknown-ui", modelInfo: models["effort-alias"] })
			render(<Panel onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
			expect(JSON.parse(screen.getByTestId("model-info").textContent ?? "null")).toEqual({
				id: "unknown-ui",
				capabilities: { supportsPromptCache: true },
			})
			expect(screen.getByRole("textbox", { name: "Model" })).toHaveValue("unknown-ui")
			expect(onUpdate).not.toHaveBeenCalled()
		})

		it("keeps profile-carried identity and full declarations aligned with the picker", () => {
			const onUpdate = vi.fn()
			const profile = ApiProfile.create({
				provider,
				modelInfo: {
					id: "opaque-ui",
					capabilities: { supportsReasoning: false, thinking: { supported: false, effortLevels: [], maxBudget: 0 } },
					pricing: { inputPrice: 0 },
				},
			})
			render(<Panel onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
			expect(JSON.parse(screen.getByTestId("model-info").textContent ?? "null")).toEqual({
				id: "opaque-ui",
				capabilities: {
					supportsPromptCache: true,
					supportsReasoning: false,
					thinking: { supported: false, effortLevels: [], maxBudget: 0 },
				},
				pricing: { inputPrice: 0 },
			})
			expect(screen.getByRole("textbox", { name: "Model" })).toHaveValue("opaque-ui")
			expect(onUpdate).not.toHaveBeenCalled()
		})

		it("displays catalog overrides but persists raw selected metadata rather than the effective clone", () => {
			const onUpdate = vi.fn()
			const profile = ApiProfile.create({
				provider,
				modelId: "effort-alias",
				modelInfo: models["budget-alias"],
				[configKey]: {
					capabilities: { supportsReasoning: false, thinking: { supported: false, effortLevels: [], maxBudget: 0 } },
					pricing: { inputPrice: 0 },
				},
			})
			render(<Panel onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
			expect(JSON.parse(screen.getByTestId("model-info").textContent ?? "null")).toMatchObject({
				id: "effort-alias",
				capabilities: {
					supportsReasoning: false,
					thinking: { supported: false, mode: "effort", effortLevels: [], defaultEffort: "low", maxBudget: 0 },
				},
				pricing: { inputPrice: 0 },
			})
			expect(onUpdate).not.toHaveBeenCalled()
			fireEvent.change(screen.getByRole("textbox", { name: "Model" }), { target: { value: "budget-alias" } })
			expect(onUpdate).toHaveBeenCalledWith({ modelId: "budget-alias", modelInfo: models["budget-alias"] })
		})
	})
}

for (const [provider, configKey, Panel] of [
	["vertex", "vertex", VertexProvider],
	["bedrock", "bedrock", BedrockProvider],
	["gemini", "gemini", GeminiProvider],
	["vercel-ai-gateway", "vercelAiGateway", VercelAIGatewayProvider],
	["openai", "openai", OpenAIProvider],
	["openai-codex", "openaiCodex", OpenAiCodexProvider],
] as const) {
	describe(`${provider} thinking controls`, () => {
		it("uses an opaque model's declared effort, default and disable constraint", () => {
			const profile = ApiProfile.create({ provider, modelId: "effort-alias" })
			render(<Panel onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
			const checkbox = screen.getByRole("checkbox", { name: "Enable Thinking" })
			expect(checkbox).toBeChecked()
			expect(checkbox).toBeDisabled()
			expect(screen.getAllByRole("combobox").filter((item) => item.textContent === "Low")).toHaveLength(1)
			expect(screen.queryByRole("slider")).not.toBeInTheDocument()
		})

		it("does not authorize thinking from a known-looking name, stale metadata or a preference", () => {
			const profile = ApiProfile.create({
				provider,
				modelId: "claude-opus-4-7-unknown",
				modelInfo: models["effort-alias"],
				[configKey]: { reasoning: { enableThinking: true, effort: "high", thinkingBudget: 2000 } },
			})
			render(<Panel onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
			expect(screen.queryByRole("checkbox", { name: "Enable Thinking" })).not.toBeInTheDocument()
			expect(screen.getByTestId("model-id")).toHaveTextContent("claude-opus-4-7-unknown")
		})

		it("does not infer a mode from a declared maximum or coarse reasoning flag", () => {
			const profile = ApiProfile.create({
				provider,
				modelId: "opaque-no-mode",
				modelInfo: {
					id: "opaque-no-mode",
					capabilities: { supportsReasoning: true, thinking: { supported: true, maxBudget: 3000 } },
				},
				[configKey]: { reasoning: { enableThinking: true, effort: "low", thinkingBudget: 2000 } },
			})
			render(<Panel onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
			expect(screen.queryByRole("checkbox", { name: "Enable Thinking" })).not.toBeInTheDocument()
		})

		it("keeps an explicit empty effort list instead of offering a provider-wide whitelist", () => {
			const profile = ApiProfile.create({
				provider,
				modelId: "effort-alias",
				[configKey]: { capabilities: { thinking: { effortLevels: [] } } },
			})
			render(<Panel onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
			expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeChecked()
			expect(screen.queryByText("Reasoning Effort")).not.toBeInTheDocument()
			expect(screen.queryByText("Thinking Mode")).not.toBeInTheDocument()
			expect(screen.queryByRole("slider")).not.toBeInTheDocument()
		})

		it("honors an explicit false capability override", () => {
			const profile = ApiProfile.create({
				provider,
				modelId: "effort-alias",
				[configKey]: { capabilities: { thinking: { supported: false } } },
			})
			render(<Panel onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
			expect(screen.queryByRole("checkbox", { name: "Enable Thinking" })).not.toBeInTheDocument()
		})

		it("uses the effective minimum override rather than a provider constant", () => {
			const onUpdate = vi.fn()
			const profile = ApiProfile.create({
				provider,
				modelId: "budget-alias",
				[configKey]: { capabilities: { thinking: { minBudget: 17 } }, reasoning: { thinkingBudget: 1500 } },
			})
			render(<Panel onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
			const slider = screen.getByRole("slider")
			expect(slider).toHaveAttribute("min", "17")
			fireEvent.change(slider, { target: { value: "3" } })
			fireEvent.mouseUp(slider)
			expect(onUpdate.mock.calls[0][0][configKey].reasoning.thinkingBudget).toBe(17)
		})

		it("persists a bounded budget edit with the existing display preference", () => {
			const onUpdate = vi.fn()
			const profile = ApiProfile.create({
				provider,
				modelId: "budget-alias",
				[configKey]: { reasoning: { thinkingBudget: 1500, display: "omitted" } },
			})
			render(<Panel onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
			const slider = screen.getByRole("slider")
			expect(slider).toHaveAttribute("max", "3000")
			fireEvent.change(slider, { target: { value: "2400" } })
			fireEvent.mouseUp(slider)
			expect(onUpdate).toHaveBeenCalledWith({
				[configKey]: {
					...profile[configKey],
					reasoning: { enableThinking: true, effort: undefined, thinkingBudget: 2400, display: "omitted" },
				},
			})
		})
	})
}

for (const [provider, configKey, Panel] of [
	["openai", "openai", OpenAIProvider],
	["openai-codex", "openaiCodex", OpenAiCodexProvider],
] as const) {
	describe(`${provider} selected metadata`, () => {
		it("retains a matching complete Profile declaration instead of rereading catalog thinking", () => {
			const profile = ApiProfile.create({
				provider,
				modelId: "effort-alias",
				modelInfo: { id: "effort-alias", capabilities: { thinking: { supported: false } } },
				[configKey]: { reasoning: { enableThinking: true, effort: "low" } },
			})
			render(<Panel onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
			expect(screen.queryByRole("checkbox", { name: "Enable Thinking" })).not.toBeInTheDocument()
		})

		it("edits a declared minimum without inventing an upper bound", () => {
			const onUpdate = vi.fn()
			const profile = ApiProfile.create({
				provider,
				modelId: "unbounded-budget",
				modelInfo: {
					id: "unbounded-budget",
					capabilities: { thinking: { supported: true, mode: "budget", minBudget: 17, defaultEnabled: true } },
				},
				[configKey]: { reasoning: { thinkingBudget: 23 } },
			})
			render(<Panel onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
			const input = screen.getByRole("spinbutton", { name: "Thinking Budget" })
			expect(input).toHaveAttribute("min", "17")
			expect(input).not.toHaveAttribute("max")
			fireEvent.change(input, { target: { value: "3" } })
			fireEvent.blur(input)
			expect(onUpdate.mock.calls[0][0][configKey].reasoning.thinkingBudget).toBe(17)
		})
	})
}

for (const [provider, configKey, Panel] of [
	["qwen", "qwen", QwenProvider],
	["oca", "oca", OcaProvider],
] as const) {
	describe(`${provider} matched budget controls`, () => {
		it("edits the effective minimum and preserves the existing display preference", () => {
			const onUpdate = vi.fn()
			const profile = ApiProfile.create({
				provider,
				modelId: "budget-alias",
				modelInfo: models["budget-alias"],
				[configKey]: {
					capabilities: { thinking: { minBudget: 17 } },
					reasoning: { thinkingBudget: 1500, display: "omitted" },
				},
			})
			render(<Panel onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
			const slider = screen.getByRole("slider")
			expect(slider).toHaveAttribute("min", "17")
			fireEvent.change(slider, { target: { value: "3" } })
			fireEvent.mouseUp(slider)
			expect(onUpdate.mock.calls[0][0][configKey].reasoning).toEqual({
				enableThinking: true,
				effort: undefined,
				thinkingBudget: 17,
				display: "omitted",
			})
		})

		it.each(["stale", "unsupported", "missing-mode"])("does not manufacture controls for %s metadata", (state) => {
			const profile = ApiProfile.create({
				provider,
				modelId: "qwen3-32b",
				modelInfo: {
					id: state === "stale" ? "another-model" : "qwen3-32b",
					capabilities: {
						thinking: {
							supported: state !== "unsupported",
							mode: state === "missing-mode" ? undefined : "budget",
							maxBudget: 101,
						},
					},
				},
				[configKey]: { reasoning: { thinkingBudget: 23 } },
			})
			render(<Panel onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
			expect(screen.queryByRole("checkbox", { name: /Enable Thinking/i })).not.toBeInTheDocument()
		})

		it("keeps required thinking on without persisting a fabricated budget", () => {
			const onUpdate = vi.fn()
			const profile = ApiProfile.create({
				provider,
				modelId: "required-budget",
				modelInfo: {
					id: "required-budget",
					capabilities: { thinking: { supported: true, mode: "budget", minBudget: 17, canDisable: false } },
				},
				[configKey]: { reasoning: { enableThinking: false, thinkingBudget: 0 } },
			})
			render(<Panel onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
			expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeChecked()
			expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeDisabled()
			expect(onUpdate).not.toHaveBeenCalled()
		})
	})
}

describe("Bedrock custom base thinking", () => {
	it("uses only the explicitly selected base declaration while preserving the custom ARN", () => {
		const profile = ApiProfile.create({
			provider: "bedrock",
			modelId: "arn:custom",
			bedrock: { awsBedrockCustomSelected: true, awsBedrockCustomModelBaseId: "effort-alias" },
		})
		render(<BedrockProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
		expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeDisabled()
		expect(screen.getByTestId("model-id")).toHaveTextContent("arn:custom")
	})

	it("does not borrow the provider default for an unknown explicit base", () => {
		const profile = ApiProfile.create({
			provider: "bedrock",
			modelId: "arn:custom",
			bedrock: { awsBedrockCustomSelected: true, awsBedrockCustomModelBaseId: "unknown-base" },
		})
		render(<BedrockProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
		expect(screen.queryByRole("checkbox", { name: "Enable Thinking" })).not.toBeInTheDocument()
	})
})

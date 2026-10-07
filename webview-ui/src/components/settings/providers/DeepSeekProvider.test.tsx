// @vitest-environment jsdom
import type { ModelInfo } from "@shared/proto/dline/models"
import { ApiFormat } from "@shared/proto/dline/models/metadata"
import { ApiProfile as ProtoApiProfile } from "@shared/proto/dline/profile"
import { BaseProviderConfig } from "@shared/proto/dline/provider/common"
import { fireEvent, render, screen } from "@testing-library/react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { flushPendingDebouncedInputs } from "../utils/useDebouncedInput"
import { DeepSeekProvider } from "./DeepSeekProvider"
import type { ApiProfile } from "./ProviderProfile"

const models = {
	"deepseek-v4-pro": {
		id: "deepseek-v4-pro",
		apiFormats: [ApiFormat.OPENAI_CHAT, ApiFormat.OPENAI_RESPONSES, ApiFormat.ANTHROPIC_CHAT],
		capabilities: {
			contextWindow: 1_000_000,
			maxTokens: 384_000,
			supportsPromptCache: true,
			supportsReasoning: true,
			thinking: {
				supported: true,
				mode: "effort",
				defaultEnabled: true,
				defaultEffort: "high",
				effortLevels: ["low", "high", "max"],
			},
		},
		pricing: {
			inputPrice: 3,
			outputPrice: 6,
			cacheWritesPrice: 3,
			cacheReadsPrice: 0.025,
			currency: "CNY",
		},
	} as ModelInfo,
	"deepseek-v4-flash": {
		id: "deepseek-v4-flash",
		apiFormats: [ApiFormat.OPENAI_CHAT, ApiFormat.OPENAI_RESPONSES, ApiFormat.ANTHROPIC_CHAT],
		capabilities: {
			contextWindow: 1_000_000,
			maxTokens: 384_000,
			supportsPromptCache: true,
			supportsReasoning: true,
			thinking: {
				supported: true,
				mode: "effort",
				defaultEnabled: true,
				defaultEffort: "high",
				effortLevels: ["low", "high", "max"],
			},
		},
		pricing: {
			inputPrice: 1,
			outputPrice: 2,
			cacheWritesPrice: 1,
			cacheReadsPrice: 0.02,
			currency: "CNY",
		},
	} as ModelInfo,
}

const remoteModels = {
	"deepseek-v4-preview": { id: "deepseek-v4-preview" } as ModelInfo,
}

vi.mock("./useProviderModelOptions", () => ({
	useProviderModelOptions: () => ({
		models,
		defaultModelId: "deepseek-v4-flash",
		modelInfoSaneDefaults: models["deepseek-v4-flash"],
		imageModels: {},
		defaultImageModelId: "",
		loading: false,
		// Catalog entries win over discovered ids, matching the hook's merge.
		options: { ...remoteModels, ...models },
		refreshRemoteModels: vi.fn(),
	}),
}))

vi.mock("../common/ApiKeyField", () => ({ ApiKeyField: () => <div /> }))
vi.mock("../common/ModelInfoView", () => ({ ModelInfoView: () => <div /> }))
vi.mock("../ReasoningEffortSelector", () => ({ default: () => <div /> }))
vi.mock("../common/ModelAutocomplete", () => ({
	ModelAutocomplete: ({ models: availableModels }: { models: Record<string, ModelInfo> }) => (
		<div data-testid="deepseek-models">{Object.keys(availableModels).join(",")}</div>
	),
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children: _children, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
	VSCodeCheckbox: ({
		checked,
		children,
		onChange,
	}: {
		checked?: boolean
		children: React.ReactNode
		onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void
	}) => (
		<label>
			<input
				aria-label={typeof children === "string" ? children : undefined}
				checked={checked}
				onChange={onChange}
				type="checkbox"
			/>
			{children}
		</label>
	),
}))

describe("DeepSeekProvider", () => {
	it.each([
		{ name: "invalid implicit effort", effort: "invalid", effortLevels: ["high"], enabled: false },
		{ name: "empty legal list", effort: "high", effortLevels: [], enabled: false },
		{ name: "unsupported alias", effort: "xhigh", effortLevels: ["high"], enabled: false },
		{ name: "legal xhigh alias", effort: "xhigh", effortLevels: ["max"], enabled: true },
		{ name: "legal ultra alias", effort: "ultra", effortLevels: ["max"], enabled: true },
		{
			name: "none vetoes explicit enable",
			effort: "none",
			effortLevels: ["none", "high"],
			enableThinking: true,
			enabled: false,
		},
	])("shows $name without rewriting preferences", ({ effort, effortLevels, enableThinking, enabled }) => {
		const onUpdate = vi.fn()
		const profile = ProtoApiProfile.create({
			provider: "deepseek",
			modelId: "opaque-activation-test",
			modelInfo: {
				id: "opaque-activation-test",
				capabilities: { thinking: { supported: true, mode: "effort", effortLevels } },
			},
			deepseek: { reasoning: { effort, enableThinking } },
		})
		render(<DeepSeekProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
		const checkbox = screen.getByRole("checkbox", { name: "Enable Thinking" })
		if (enabled) expect(checkbox).toBeChecked()
		else expect(checkbox).not.toBeChecked()
		expect(onUpdate).not.toHaveBeenCalled()
	})

	it("does not create thinking controls for an undeclared model with an enabled preference", () => {
		const profile = {
			id: "custom-profile",
			provider: "deepseek",
			modelId: "opaque-model",
			modelInfo: { id: "opaque-model", capabilities: { supportsReasoning: true } },
			deepseek: BaseProviderConfig.create({ reasoning: { enableThinking: true, effort: "high" } }),
		} as unknown as ApiProfile
		render(<DeepSeekProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
		expect(screen.queryByRole("checkbox", { name: "Enable Thinking" })).not.toBeInTheDocument()
	})

	it("uses the custom declaration default rather than a fixed high effort", () => {
		const onUpdate = vi.fn()
		const profile = {
			id: "custom-profile",
			provider: "deepseek",
			modelId: "opaque-model",
			modelInfo: {
				id: "opaque-model",
				capabilities: { thinking: { supported: true, mode: "effort", defaultEffort: "low", effortLevels: ["low"] } },
			},
			deepseek: BaseProviderConfig.create({ reasoning: { enableThinking: false } }),
		} as unknown as ApiProfile
		render(<DeepSeekProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
		fireEvent.click(screen.getByRole("checkbox", { name: "Enable Thinking" }))
		expect(onUpdate).toHaveBeenCalledWith({
			deepseek: expect.objectContaining({ reasoning: { enableThinking: true, effort: "low" } }),
		})
	})

	it("persists explicit Enable Thinking without a zero budget", () => {
		const onUpdate = vi.fn()
		const profile = {
			id: "deepseek-profile",
			provider: "deepseek",
			modelId: "deepseek-v4-pro",
			deepseek: BaseProviderConfig.create({ reasoning: { enableThinking: false } }),
		} as unknown as ApiProfile

		render(<DeepSeekProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
		fireEvent.click(screen.getByRole("checkbox", { name: "Enable Thinking" }))

		expect(onUpdate).toHaveBeenCalledWith({
			deepseek: expect.objectContaining({
				reasoning: { enableThinking: true, effort: "high" },
			}),
		})
		const update = onUpdate.mock.calls.at(-1)?.[0] as { deepseek?: { reasoning?: Record<string, unknown> } }
		expect(update.deepseek?.reasoning).not.toHaveProperty("thinkingBudget")
	})

	it("persists explicit disable and clears the effort and budget fields", () => {
		const onUpdate = vi.fn()
		const profile = {
			id: "deepseek-profile",
			provider: "deepseek",
			modelId: "deepseek-v4-pro",
			deepseek: BaseProviderConfig.create({
				reasoning: { enableThinking: true, effort: "high", thinkingBudget: 0 },
			}),
		} as unknown as ApiProfile

		render(<DeepSeekProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
		fireEvent.click(screen.getByRole("checkbox", { name: "Enable Thinking" }))

		expect(onUpdate).toHaveBeenCalledWith({
			deepseek: expect.objectContaining({ reasoning: { enableThinking: false } }),
		})
		const update = onUpdate.mock.calls.at(-1)?.[0] as { deepseek?: { reasoning?: Record<string, unknown> } }
		expect(update.deepseek?.reasoning).not.toHaveProperty("effort")
		expect(update.deepseek?.reasoning).not.toHaveProperty("thinkingBudget")
	})

	it("shows the complete DeepSeek limits and CNY pricing from registry metadata", () => {
		const profile = ProtoApiProfile.create({
			id: "deepseek-metadata-profile",
			provider: "deepseek",
			modelId: "deepseek-v4-pro",
			deepseek: BaseProviderConfig.create(),
		})

		render(<DeepSeekProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
		fireEvent.click(screen.getByRole("button", { name: "Model Configuration" }))

		expect(screen.getByRole("textbox", { name: "Context Window Size" })).toHaveValue("1000000")
		expect(screen.getByRole("textbox", { name: "Max Output Tokens" })).toHaveValue("384000")
		expect(screen.getByRole("textbox", { name: "Input Price (¥/1M tokens)" })).toHaveValue("3")
		expect(screen.getByRole("textbox", { name: "Output Price (¥/1M tokens)" })).toHaveValue("6")
		expect(screen.getByRole("textbox", { name: "Cache Writes (¥/M)" })).toHaveValue("3")
		expect(screen.getByRole("textbox", { name: "Cache Reads (¥/M)" })).toHaveValue("0.025")
	})

	it("persists a context override without losing a preceding API format edit or existing provider settings", async () => {
		const onUpdate = vi.fn()
		const profile = ProtoApiProfile.create({
			id: "deepseek-context-profile",
			provider: "deepseek",
			modelId: "deepseek-v4-pro",
			deepseek: BaseProviderConfig.create({
				apiFormat: ApiFormat.OPENAI_CHAT,
				reasoning: { enableThinking: false },
				capabilities: { maxTokens: 12_345 },
			}),
		})

		render(<DeepSeekProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)

		const format = screen.getByRole("combobox", { name: "API Format" })
		fireEvent.change(format, { target: { value: String(ApiFormat.OPENAI_RESPONSES) } })

		fireEvent.click(screen.getByRole("button", { name: "Model Configuration" }))
		const contextWindow = screen.getByRole("textbox", { name: "Context Window Size" })
		expect(contextWindow).toHaveValue("1000000")
		fireEvent.input(contextWindow, { target: { value: "262144" } })
		await flushPendingDebouncedInputs()

		expect(onUpdate).toHaveBeenLastCalledWith({
			deepseek: expect.objectContaining({
				apiFormat: ApiFormat.OPENAI_RESPONSES,
				reasoning: { enableThinking: false },
				capabilities: expect.objectContaining({ maxTokens: 12_345, contextWindow: 262_144 }),
			}),
		})
	})

	it("shows metadata-supported API formats while retaining the complete model catalog", () => {
		const onUpdate = vi.fn()
		const profile = {
			id: "deepseek-profile",
			provider: "deepseek",
			modelId: "deepseek-v4-pro",
			modelInfo: {
				id: "deepseek-v4-pro",
				capabilities: { supportsReasoning: true },
			},
			deepseek: BaseProviderConfig.create(),
		} as unknown as ApiProfile

		render(<DeepSeekProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)

		// The picker lists remote discoveries alongside the local catalog.
		expect(screen.getByTestId("deepseek-models")).toHaveTextContent("deepseek-v4-preview,deepseek-v4-pro,deepseek-v4-flash")
		const format = screen.getByRole("combobox", { name: "API Format" })
		expect(format).toHaveValue(String(ApiFormat.OPENAI_CHAT))
		expect(screen.getByRole("option", { name: "OpenAI Chat" })).toBeInTheDocument()
		expect(screen.getByRole("option", { name: "OpenAI Responses" })).toBeInTheDocument()
		expect(screen.getByRole("option", { name: "Anthropic Messages" })).toBeInTheDocument()

		fireEvent.change(format, { target: { value: String(ApiFormat.OPENAI_RESPONSES) } })
		expect(onUpdate).toHaveBeenCalledWith({
			deepseek: expect.objectContaining({ apiFormat: ApiFormat.OPENAI_RESPONSES }),
		})
	})
})

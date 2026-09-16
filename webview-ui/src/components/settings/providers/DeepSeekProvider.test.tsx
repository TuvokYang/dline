// @vitest-environment jsdom
import type { ModelInfo } from "@shared/proto/dline/models"
import { ApiFormat } from "@shared/proto/dline/models/metadata"
import { BaseProviderConfig } from "@shared/proto/dline/provider/common"
import { fireEvent, render, screen } from "@testing-library/react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { DeepSeekProvider } from "./DeepSeekProvider"
import type { ApiProfile } from "./ProviderProfile"

const models = {
	"deepseek-v4-pro": {
		id: "deepseek-v4-pro",
		apiFormats: [ApiFormat.OPENAI_CHAT, ApiFormat.OPENAI_RESPONSES, ApiFormat.ANTHROPIC_CHAT],
		capabilities: { supportsReasoning: true },
	} as ModelInfo,
	"deepseek-v4-flash": {
		id: "deepseek-v4-flash",
		apiFormats: [ApiFormat.OPENAI_CHAT, ApiFormat.OPENAI_RESPONSES, ApiFormat.ANTHROPIC_CHAT],
		capabilities: { supportsReasoning: true },
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

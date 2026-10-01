// @vitest-environment jsdom
import type { ModelInfo } from "@shared/proto/dline/models"
import { fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { ClaudeCodeProvider } from "./ClaudeCodeProvider"
import type { ApiProfile } from "./ProviderProfile"

/**
 * The panel offers the thinking controls the selected model can actually use.
 *
 * The request shape follows the declared thinking mode: an adaptive model takes
 * an effort level and rejects a token budget, and the reverse holds for a budget
 * model. Keying the UI on `maxBudget` alone hid the whole section from adaptive
 * models, including the default one, so their effort and display were
 * unreachable even though the handler already sent both.
 */

const ADAPTIVE_MODEL = "claude-opus-5-5"
const BUDGET_MODEL = "claude-budget-model"
const PLAIN_MODEL = "claude-plain-model"

vi.mock("./useProviderModels", () => ({
	useProviderModels: () => ({
		models: {
			[ADAPTIVE_MODEL]: {
				id: ADAPTIVE_MODEL,
				capabilities: {
					thinking: {
						supported: true,
						mode: "effort",
						effortLevels: ["none", "low", "medium", "high"],
						defaultEnabled: true,
						canDisable: true,
						defaultEffort: "high",
					},
				},
			},
			[BUDGET_MODEL]: {
				id: BUDGET_MODEL,
				capabilities: { thinking: { supported: true, mode: "budget", maxBudget: 8_192 } },
			},
			[PLAIN_MODEL]: { id: PLAIN_MODEL, capabilities: {} },
		},
		defaultModelId: ADAPTIVE_MODEL,
		modelInfoSaneDefaults: { id: ADAPTIVE_MODEL, capabilities: {} },
		loading: false,
	}),
}))

vi.mock("../common/ModelInfoView", () => ({ ModelInfoView: () => <div /> }))
vi.mock("./ClaudeCodeOAuthControl", () => ({ ClaudeCodeOAuthControl: () => <div /> }))
vi.mock("../common/ModelSelector", () => ({
	ModelSelector: ({ onChange }: { onChange: React.ChangeEventHandler<HTMLInputElement> }) => (
		<input aria-label="Model" onChange={onChange} />
	),
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({
		checked,
		disabled,
		children,
		onChange,
	}: {
		checked?: boolean
		disabled?: boolean
		children: ReactNode
		onChange?: React.ChangeEventHandler<HTMLInputElement>
	}) => (
		<label>
			<input checked={checked} disabled={disabled} onChange={onChange} type="checkbox" />
			{children}
		</label>
	),
}))

/** Render the panel with one model selected and an optional stored reasoning config. */
function renderPanel(modelId: string, reasoning?: Record<string, unknown>) {
	const profile = {
		id: "claude-code-profile",
		provider: "claude-code",
		modelId,
		...(reasoning ? { claudeCode: { reasoning } } : {}),
	} as unknown as ApiProfile
	render(<ClaudeCodeProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
}

describe("ClaudeCodeProvider thinking controls", () => {
	it("uses declared defaults for an opaque alias without guessing from its name", () => {
		const profile = {
			id: "opaque-alias-profile",
			provider: "claude-code",
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
		} as ApiProfile
		render(<ClaudeCodeProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
		expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeChecked()
		expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeDisabled()
		expect(screen.getAllByRole("combobox")[0]).toHaveTextContent("Low")
	})

	it("honors a provider negative override before displaying thinking controls", () => {
		const profile = {
			id: "negative-override-profile",
			provider: "claude-code",
			modelId: ADAPTIVE_MODEL,
			claudeCode: { capabilities: { supportsReasoning: false } },
		} as ApiProfile
		render(<ClaudeCodeProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
		expect(screen.queryByRole("checkbox", { name: "Enable Thinking" })).not.toBeInTheDocument()
	})

	it.each([undefined, false])("does not authorize budget controls with supported=%s", (supported) => {
		const profile = {
			id: "unsupported-budget-profile",
			provider: "claude-code",
			modelId: "budget-alias",
			modelInfo: { id: "budget-alias", capabilities: { thinking: { supported, mode: "budget", maxBudget: 8000 } } },
			claudeCode: { reasoning: { enableThinking: true, thinkingBudget: 4000 } },
		} as ApiProfile
		render(<ClaudeCodeProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
		expect(screen.queryByRole("checkbox", { name: "Enable Thinking" })).not.toBeInTheDocument()
	})

	it("keeps required thinking and display available without inventing an effort list", () => {
		const profile = {
			id: "empty-efforts-profile",
			provider: "claude-code",
			modelId: "required-alias",
			modelInfo: {
				id: "required-alias",
				capabilities: {
					thinking: {
						supported: true,
						mode: "effort",
						effortLevels: [],
						canDisable: false,
					},
				},
			},
		} as ApiProfile
		render(<ClaudeCodeProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
		expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeChecked()
		expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeDisabled()
		expect(screen.queryByText("Adaptive Thinking")).not.toBeInTheDocument()
		expect(screen.getByText("Thinking Display")).toBeInTheDocument()
		expect(screen.getAllByRole("combobox")).toHaveLength(1)
	})

	it("does not borrow stale metadata when the selected ID changes", () => {
		const stale: ModelInfo = {
			id: "old-id",
			capabilities: { thinking: { supported: true, mode: "effort", effortLevels: ["low"] } },
		}
		const profile = { id: "stale-profile", provider: "claude-code", modelId: "new-id", modelInfo: stale } as ApiProfile
		const onUpdate = vi.fn()
		render(<ClaudeCodeProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
		expect(screen.queryByRole("checkbox", { name: "Enable Thinking" })).not.toBeInTheDocument()
		fireEvent.change(screen.getByRole("textbox", { name: "Model" }), { target: { value: "next-id" } })
		expect(onUpdate).toHaveBeenCalledWith({ modelId: "next-id", modelInfo: undefined })
		expect(onUpdate.mock.calls[0][0]).toHaveProperty("modelInfo", undefined)
	})

	it("uses the effective declared minimum for a custom budget model", () => {
		const onUpdate = vi.fn()
		const profile = {
			id: "budget-min-profile",
			provider: "claude-code",
			modelId: BUDGET_MODEL,
			claudeCode: { capabilities: { thinking: { minBudget: 17 } }, reasoning: { thinkingBudget: 1500 } },
		} as ApiProfile
		render(<ClaudeCodeProvider onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
		const slider = screen.getByRole("slider")
		expect(slider).toHaveAttribute("min", "17")
		fireEvent.change(slider, { target: { value: "3" } })
		fireEvent.mouseUp(slider)
		expect(onUpdate.mock.calls[0][0].claudeCode.reasoning.thinkingBudget).toBe(17)
	})

	it("offers an explicit budget editor without inventing a missing model maximum", () => {
		const profile = {
			id: "budget-no-max-profile",
			provider: "claude-code",
			modelId: "budget-no-max",
			modelInfo: {
				id: "budget-no-max",
				capabilities: { thinking: { supported: true, mode: "budget", defaultEnabled: true } },
			},
		} as ApiProfile
		render(<ClaudeCodeProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
		expect(screen.getByRole("spinbutton", { name: "Thinking Budget" })).not.toHaveAttribute("max")
	})
	it("offers effort and display for an adaptive model", () => {
		renderPanel(ADAPTIVE_MODEL)

		expect(screen.getByText("Adaptive Thinking")).toBeInTheDocument()
		expect(screen.getByText("Thinking Display")).toBeInTheDocument()
	})

	it("offers a budget rather than an effort level for a budget model", () => {
		// Thinking is off by default here, so the enable switch is the only
		// control until the user turns it on.
		renderPanel(BUDGET_MODEL)

		expect(screen.queryByText("Adaptive Thinking")).not.toBeInTheDocument()
		expect(screen.queryByText("Thinking Display")).not.toBeInTheDocument()
	})

	it("offers the display choice once budget thinking is enabled", () => {
		renderPanel(BUDGET_MODEL, { enableThinking: true, thinkingBudget: 4_096 })

		expect(screen.getByText("Thinking Display")).toBeInTheDocument()
		expect(screen.queryByText("Adaptive Thinking")).not.toBeInTheDocument()
	})

	it("offers nothing when the model declares no thinking support", () => {
		renderPanel(PLAIN_MODEL)

		expect(screen.queryByText("Adaptive Thinking")).not.toBeInTheDocument()
		expect(screen.queryByText("Thinking Display")).not.toBeInTheDocument()
	})
})

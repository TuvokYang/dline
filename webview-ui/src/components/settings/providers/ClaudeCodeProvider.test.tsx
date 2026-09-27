// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
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
					thinking: { supported: true, mode: "effort", effortLevels: ["none", "low", "medium", "high"] },
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
vi.mock("../common/ModelSelector", () => ({ ModelSelector: () => <div /> }))

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

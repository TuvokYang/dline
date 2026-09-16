// @vitest-environment jsdom

import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { SubagentMetrics } from "./SubagentMetrics"

const baseProps = {
	toolCalls: 3,
	startedAt: 1_000,
	finishedAt: 5_000,
	inputTokens: 1_200,
	outputTokens: 340,
	totalCost: 0.0123,
	currency: "USD",
}

describe("SubagentMetrics context usage", () => {
	it("renders context tokens against the context window", () => {
		render(<SubagentMetrics {...baseProps} contextTokens={64_000} contextWindow={200_000} />)

		const usage = screen.getByTestId("subagent-context-usage")
		expect(usage.textContent).toBe("Ctx:64.0K/200.0K (32%)")
	})

	it("omits the segment when the context window is unknown", () => {
		render(<SubagentMetrics {...baseProps} contextTokens={64_000} />)

		expect(screen.queryByTestId("subagent-context-usage")).toBeNull()
	})

	it("omits the segment when the context window is zero", () => {
		render(<SubagentMetrics {...baseProps} contextTokens={64_000} contextWindow={0} />)

		expect(screen.queryByTestId("subagent-context-usage")).toBeNull()
	})

	it("omits the segment when context tokens are unknown", () => {
		render(<SubagentMetrics {...baseProps} contextWindow={200_000} />)

		expect(screen.queryByTestId("subagent-context-usage")).toBeNull()
	})

	it("caps the reported percentage at 100 when usage exceeds the window", () => {
		render(<SubagentMetrics {...baseProps} contextTokens={250_000} contextWindow={200_000} />)

		expect(screen.getByTestId("subagent-context-usage").textContent).toContain("100%")
	})

	it("keeps the existing token and cost segments intact", () => {
		render(<SubagentMetrics {...baseProps} contextTokens={64_000} contextWindow={200_000} />)

		const metrics = screen.getByTestId("subagent-metrics")
		expect(metrics.textContent).toContain("3 tools")
		expect(metrics.textContent).toContain("In:")
		expect(metrics.textContent).toContain("Out:")
		// Costs at or above 0.01 render with two fraction digits by existing design.
		expect(metrics.textContent).toContain("$0.01")
	})
})

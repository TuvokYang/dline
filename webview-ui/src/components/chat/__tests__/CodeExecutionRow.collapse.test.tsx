import type { CodeExecutionPresentationV1 } from "@shared/code-execution-tools"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import CodeExecutionRow from "../CodeExecutionRow"

const completedRun: CodeExecutionPresentationV1 = {
	schemaVersion: 1,
	status: "completed",
	source: { id: "anthropic-hosted", label: "Anthropic Code Execution", provider: "anthropic" },
	operation: { type: "bash", command: "echo sandbox" },
	output: { stdout: "sandbox stdout marker", returnCode: 0 },
} as CodeExecutionPresentationV1

describe("CodeExecutionRow collapse", () => {
	it("toggles the execution output from the card title as well as the output bar", () => {
		render(<CodeExecutionRow codeExecution={completedRun} messageType="say" />)
		const header = screen.getByTestId("code-execution-header")
		const toggle = screen.getByTestId("code-execution-output-toggle")
		expect(header).toHaveAttribute("aria-expanded", "true")
		expect(screen.getByText("sandbox stdout marker")).toBeInTheDocument()

		fireEvent.click(header)

		expect(header).toHaveAttribute("aria-expanded", "false")
		expect(toggle).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryByTestId("code-execution-output")).not.toBeInTheDocument()

		fireEvent.click(toggle)

		expect(header).toHaveAttribute("aria-expanded", "true")
		expect(screen.getByText("sandbox stdout marker")).toBeInTheDocument()
	})

	it("keeps a plain title while there is no output to collapse", () => {
		render(<CodeExecutionRow codeExecution={{ ...completedRun, status: "running", output: undefined }} messageType="say" />)

		const header = screen.getByTestId("code-execution-header")
		expect(header.tagName).toBe("DIV")
		expect(header).not.toHaveAttribute("aria-expanded")
		expect(screen.queryByTestId("code-execution-output-toggle")).not.toBeInTheDocument()
	})
})

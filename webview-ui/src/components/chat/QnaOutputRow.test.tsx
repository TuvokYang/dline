import { render, screen } from "@testing-library/react"
import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import QnaOutputRow from "./QnaOutputRow"

const mocks = vi.hoisted(() => ({
	copyText: vi.fn(),
	renderMarkdown: vi.fn(),
}))

vi.mock("@/components/common/CopyButton", () => ({
	CopyButton: ({ textToCopy }: { textToCopy?: string }) => {
		mocks.copyText(textToCopy)
		return <button type="button">Copy</button>
	},
}))

vi.mock("@/components/common/MarkdownBlock", () => ({
	default: ({ markdown }: { markdown?: string }) => {
		mocks.renderMarkdown(markdown)
		return <div data-testid="markdown-block">{markdown}</div>
	},
}))

void React

describe("QnaOutputRow rendering boundary", () => {
	beforeEach(() => {
		mocks.copyText.mockClear()
		mocks.renderMarkdown.mockClear()
	})

	it("renders ordinary responses as markdown and keeps the full response copyable", () => {
		const response = "## Result\n\nA concise answer."

		render(<QnaOutputRow text={response} />)

		expect(screen.getByTestId("markdown-block")).toHaveTextContent("Result")
		expect(mocks.renderMarkdown).toHaveBeenCalledWith(response)
		expect(mocks.copyText).toHaveBeenCalledWith(response)
		expect(screen.queryByTestId("qna-output-preview")).not.toBeInTheDocument()
	})

	it("uses a bounded plain-text preview for very large responses while keeping the complete response copyable", () => {
		const response = `E2E_ROLLING_TURN_A\n${"A".repeat(520_000)}\nTAIL_MARKER`

		render(<QnaOutputRow text={response} />)

		const preview = screen.getByTestId("qna-output-preview")
		expect(preview.textContent).toHaveLength(32 * 1024)
		expect(preview).toHaveTextContent("E2E_ROLLING_TURN_A")
		expect(preview).not.toHaveTextContent("TAIL_MARKER")
		expect(screen.getByTestId("qna-output-preview-notice")).toHaveTextContent("Use Copy to access the complete response")
		expect(mocks.renderMarkdown).not.toHaveBeenCalled()
		expect(mocks.copyText).toHaveBeenCalledWith(response)
	})
})

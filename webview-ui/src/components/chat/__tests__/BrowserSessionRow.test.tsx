// @vitest-environment jsdom
import type { ClineMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import React, { type ReactElement } from "react"
import { describe, expect, it, vi } from "vitest"
import BrowserSessionRow from "../BrowserSessionRow"

void React

vi.mock("react-use", () => ({
	useSize: (element: ReactElement) => [element, { height: 100, width: 600 }],
}))

vi.mock("@vscode/webview-ui-toolkit/react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@vscode/webview-ui-toolkit/react")>()
	return {
		...actual,
		VSCodeButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
			<button type="button" {...props}>
				{children}
			</button>
		),
	}
})

vi.mock("@components/browser/BrowserSettingsMenu", () => ({
	BrowserSettingsMenu: () => <button type="button">Browser settings</button>,
}))

vi.mock("@components/chat/ChatRow", () => ({
	ChatRowContent: ({ message }: { message: ClineMessage }) => (
		<div data-testid={`conversation-message-${message.ts}`}>{message.text}</div>
	),
	ProgressIndicator: () => <div>Browsing</div>,
}))

vi.mock("@components/common/CodeBlock", () => ({
	default: ({ source }: { source: string }) => <pre>{source}</pre>,
	CODE_BLOCK_BG_COLOR: "#111",
}))

vi.mock("@context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		browserSettings: { viewport: { height: 600, width: 900 } },
	}),
}))

vi.mock("../../../services/grpc-client", () => ({
	FileServiceClient: { openImage: vi.fn(async () => undefined) },
}))

function launch(ts: number): ClineMessage {
	return { ts, type: "say", say: "browser_action_launch", text: "https://start.example" }
}

function result(ts: number, currentUrl: string): ClineMessage {
	return {
		ts,
		type: "say",
		say: "browser_action_result",
		text: JSON.stringify({
			currentUrl,
			screenshot: `data:image/png;base64,${ts}`,
			currentMousePosition: "120,240",
			logs: "",
		}),
	}
}

function action(ts: number, coordinate: string): ClineMessage {
	return {
		ts,
		type: "say",
		say: "browser_action",
		text: JSON.stringify({ action: "click", coordinate }),
	}
}

const baseProps = {
	expandedRows: {},
	isLast: false,
	onHeightChange: vi.fn(),
	onSetQuote: vi.fn(),
	onToggleExpand: vi.fn(),
}

describe("BrowserSessionRow", () => {
	it("renders navigation and browser actions before ordinary conversation messages", () => {
		const messages: ClineMessage[] = [
			launch(1),
			result(2, "https://one.example"),
			{ ts: 3, type: "say", say: "reasoning", text: "THINKING_OUTSIDE_BROWSER" },
			{ ts: 4, type: "say", say: "text", text: "RESPOND_OUTSIDE_BROWSER" },
			action(5, "20,30"),
			result(6, "https://two.example"),
		]

		render(<BrowserSessionRow {...baseProps} messages={messages} />)

		const previous = screen.getByRole("button", { name: "Previous browser step" })
		const frame = screen.getByTestId("browser-session-frame")
		const url = screen.getByText("https://two.example")
		const browserAction = screen.getByText("Click (20, 30)", { exact: false })
		const reasoning = screen.getByTestId("conversation-message-3")
		const response = screen.getByTestId("conversation-message-4")

		expect(frame.style.maxHeight).toBe("60vh")
		expect(frame.style.overflowY).toBe("auto")
		expect(frame.style.overscrollBehavior).toBe("contain")
		expect(previous.compareDocumentPosition(url) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
		expect(browserAction.compareDocumentPosition(reasoning) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
		expect(reasoning.compareDocumentPosition(response) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
		expect(screen.getAllByText("THINKING_OUTSIDE_BROWSER")).toHaveLength(1)
		expect(screen.getAllByText("RESPOND_OUTSIDE_BROWSER")).toHaveLength(1)
	})

	it("reconstructs the latest persisted page after the row is remounted", () => {
		const messages: ClineMessage[] = [
			launch(20),
			result(21, "https://one.example"),
			action(22, "40,40"),
			result(23, "https://two.example"),
		]
		const firstRender = render(<BrowserSessionRow {...baseProps} messages={messages} />)

		fireEvent.click(screen.getByRole("button", { name: "Previous browser step" }))
		expect(screen.getByText("Step 1 of 2")).toBeInTheDocument()
		firstRender.unmount()

		render(<BrowserSessionRow {...baseProps} messages={messages} />)
		expect(screen.getByText("Step 2 of 2")).toBeInTheDocument()
		expect(screen.getByText("https://two.example")).toBeInTheDocument()
	})

	it("keeps the selected historical page when a newer browser result arrives", () => {
		const initialMessages: ClineMessage[] = [
			launch(10),
			result(11, "https://one.example"),
			action(12, "10,10"),
			result(13, "https://two.example"),
		]
		const { rerender } = render(<BrowserSessionRow {...baseProps} messages={initialMessages} />)

		fireEvent.click(screen.getByRole("button", { name: "Previous browser step" }))
		expect(screen.getByText("Step 1 of 2")).toBeInTheDocument()
		expect(screen.getByText("https://one.example")).toBeInTheDocument()

		rerender(
			<BrowserSessionRow
				{...baseProps}
				messages={[...initialMessages, action(14, "30,30"), result(15, "https://three.example")]}
			/>,
		)

		expect(screen.getByText("Step 1 of 3")).toBeInTheDocument()
		expect(screen.getByText("https://one.example")).toBeInTheDocument()
		expect(screen.queryByText("https://three.example")).not.toBeInTheDocument()
	})
})

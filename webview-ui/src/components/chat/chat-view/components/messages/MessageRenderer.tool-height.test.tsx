import type { UiMessage } from "@shared/ExtensionMessage"
import { render, screen } from "@testing-library/react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import type { MessageHandlers } from "../../types/chatTypes"
import { MessageRenderer } from "./MessageRenderer"

void React

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ mode: "act" }),
}))

vi.mock("@/components/chat/BrowserSessionRow", () => ({
	default: () => <div data-testid="browser-session-row" />,
}))

vi.mock("@/components/chat/ChatRow", () => ({
	default: () => <div data-testid="chat-row" />,
}))

vi.mock("../../utils/messageUtils", () => ({
	findReasoningForApiReq: () => ({ reasoning: undefined, responseStarted: false }),
	isTextMessagePendingToolCall: () => false,
	isToolGroup: (value: UiMessage | UiMessage[]) => Array.isArray(value),
	resolveMessageRowExpanded: () => false,
}))

vi.mock("./ToolGroupRenderer", () => ({
	ToolGroupRenderer: () => <div data-testid="tool-group-renderer" />,
}))

const messageHandlers: MessageHandlers = {
	handleSendMessage: vi.fn(async () => undefined),
	handleTaskCloseButtonClick: vi.fn(),
	startNewTask: vi.fn(async () => undefined),
}

describe("MessageRenderer tool-group height boundary", () => {
	it("caps grouped tool rows at 60vh without modifying ToolGroupRenderer", () => {
		const group: UiMessage[] = [
			{ ts: 1, type: "say", say: "tool", text: JSON.stringify({ tool: "readFile", path: "src/example.ts" }) },
		]

		render(
			<MessageRenderer
				expandedRows={{}}
				footerActive={false}
				groupedMessages={[group]}
				index={0}
				messageHandlers={messageHandlers}
				messageOrGroup={group}
				modifiedMessages={group}
				onAddToInput={vi.fn()}
				onFollowupOptionSelect={vi.fn(async () => undefined)}
				onHeightChange={vi.fn()}
				onSetQuote={vi.fn()}
				onToggleExpand={vi.fn()}
			/>,
		)

		expect(screen.getByTestId("tool-group-scroll")).toHaveClass("max-h-[60vh]", "overflow-y-auto", "overscroll-x-contain")
		expect(screen.getByTestId("tool-group-renderer")).toBeInTheDocument()
	})
})

import type { UiMessage } from "@shared/ExtensionMessage"
import { render, screen } from "@testing-library/react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { ChatRowContent } from "../ChatRow"

void React

let clineMessages: UiMessage[] = []

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		autoApprovalSettings: { actions: { useMcp: true } },
		backgroundEditEnabled: true,
		mcpServers: [
			{
				name: "docs",
				config: "{}",
				status: "connected",
				tools: [{ name: "search", description: "Search docs", autoApprove: true }],
			},
		],
		mcpMarketplaceCatalog: { items: [] },
		mcpDisplayMode: "plain",
		mcpResponsesCollapsed: false,
		onRelinquishControl: () => () => undefined,
		vscodeTerminalExecutionMode: "backgroundExec",
		clineMessages,
		showFeatureTips: false,
		taskViewState: undefined,
		currentTaskItem: { id: "task-1" },
	}),
}))

const baseProps = {
	isExpanded: false,
	isLast: true,
	onSetQuote: vi.fn(),
	onToggleExpand: vi.fn(),
}

describe("ChatRow MCP tool rendering", () => {
	it("shows invocation details without Configure auto-approval controls", () => {
		clineMessages = []
		render(
			<ChatRowContent
				{...baseProps}
				message={{
					ts: 1,
					type: "say",
					say: "use_mcp_server",
					text: JSON.stringify({
						type: "use_mcp_tool",
						serverName: "docs",
						toolName: "search",
						arguments: '{"query":"Dline"}',
					}),
				}}
			/>,
		)

		expect(screen.getByText("search")).toBeInTheDocument()
		expect(screen.getByText("Search docs")).toBeInTheDocument()
		expect(screen.queryByText("Auto-approve")).not.toBeInTheDocument()
		expect(screen.getByText(/Dline is using the/)).toBeInTheDocument()
		expect(screen.getByTestId("mcp-request-card")).toHaveClass("max-h-[60vh]", "overflow-y-auto", "overscroll-x-contain")
	})

	it("groups every response item into the connected request card", async () => {
		clineMessages = [
			{
				ts: 10,
				type: "say",
				say: "use_mcp_server",
				text: JSON.stringify({ type: "use_mcp_tool", serverName: "docs", toolName: "search", arguments: "{}" }),
			},
			{
				ts: 11,
				type: "say",
				say: "mcp_server_response",
				text: JSON.stringify({ type: "mcp_server_response", requestTs: 999, responses: ["first", "second"] }),
			},
		]

		render(<ChatRowContent {...baseProps} message={clineMessages[0]} />)

		await screen.findByText(/first/)
		expect(screen.getByTestId("mcp-response-group")).toHaveTextContent("second")
	})

	it("caps MCP notifications at 60vh", () => {
		render(
			<ChatRowContent
				{...baseProps}
				message={{
					ts: 2,
					type: "say",
					say: "mcp_notification",
					text: "Long-running MCP notification",
				}}
			/>,
		)

		expect(screen.getByTestId("mcp-notification-card")).toHaveClass("max-h-[60vh]", "overflow-y-auto", "overscroll-x-contain")
	})

	it("caps generated explanation cards without affecting excluded output rows", () => {
		render(
			<ChatRowContent
				{...baseProps}
				message={{
					ts: 3,
					type: "say",
					say: "generate_explanation",
					text: JSON.stringify({ title: "Changes", fromRef: "a", toRef: "b", status: "complete" }),
				}}
			/>,
		)

		expect(screen.getByTestId("generate-explanation-scroll")).toHaveClass(
			"max-h-[60vh]",
			"overflow-y-auto",
			"overscroll-x-contain",
		)
	})
})

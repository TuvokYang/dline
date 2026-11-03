import type { UiMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
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
        const body = screen.getByTestId("mcp-request-body")
        // The tool name is a fixed title outside the scroll area; only the
        // description and arguments scroll.
        const title = screen.getByTestId("mcp-tool-title")
        expect(body).not.toContainElement(title)
        expect(body).toContainElement(screen.getByTestId("mcp-tool-description"))
        // Both detail sections carry a subheading.
        // Without a response the request may use the whole card.
        expect(screen.queryByTestId("mcp-response-group")).not.toBeInTheDocument()
    })

    it("folds the tool details from the tool title and shows string arguments unescaped", () => {
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
                        arguments: JSON.stringify({ logql: '{service_name="dline"} |= "error"', limit: 10 }),
                    }),
                }}
            />,
        )

        const args = screen.getByTestId("mcp-tool-arguments")
        expect(args.textContent).not.toContain("\\")

        const title = screen.getByTestId("mcp-tool-title")
        expect(title).toHaveAttribute("aria-expanded", "true")
        fireEvent.click(title)
        expect(title).toHaveAttribute("aria-expanded", "false")
        expect(screen.queryByTestId("mcp-request-body")).not.toBeInTheDocument()
        // Folding the details leaves the card and the title in place.
        expect(screen.getByTestId("mcp-request-card")).toContainElement(title)
        fireEvent.click(title)
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

        render(<ChatRowContent {...baseProps} isExpanded={true} message={clineMessages[0]} />)

        await screen.findByText(/first/)
        const group = screen.getByTestId("mcp-response-group")
        // The response renders inside the request card, below a request capped so it keeps room.
        expect(screen.getByTestId("mcp-request-card")).toContainElement(group)
        // The card owns the 60vh bound, so the embedded response drops its own cap but still scrolls.
        expect(screen.getByTestId("mcp-response-card").style.maxHeight).toBe("")
        expect(screen.getByTestId("mcp-response-content").style.overflowY).toBe("auto")
    })

    // While the call runs the card shows; once its response has landed the call is
    // final and folds to its header, request and response together.
    it("folds a final call to its header and reopens it from there", () => {
        clineMessages = [
            {
                ts: 20,
                type: "say",
                say: "use_mcp_server",
                text: JSON.stringify({ type: "use_mcp_tool", serverName: "docs", toolName: "search", arguments: "{}" }),
            },
            {
                ts: 21,
                type: "say",
                say: "mcp_server_response",
                text: JSON.stringify({ type: "mcp_server_response", requestTs: 20, responses: ["done"] }),
            },
        ]
        const onToggleExpand = vi.fn()

        render(<ChatRowContent {...baseProps} message={clineMessages[0]} onToggleExpand={onToggleExpand} />)

        expect(screen.queryByTestId("mcp-request-card")).not.toBeInTheDocument()
        expect(screen.queryByText(/done/)).not.toBeInTheDocument()
        const toggle = screen.getByTestId("mcp-call-toggle")
        expect(toggle).toHaveAttribute("aria-expanded", "false")
        fireEvent.click(toggle)
        expect(onToggleExpand).toHaveBeenCalledWith(20)
    })
})

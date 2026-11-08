import type { UiMessage } from "@shared/ExtensionMessage"
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import { ChatRowContent } from "../ChatRow"

const state = vi.hoisted(() => ({
    backgroundEditEnabled: true,
    mcpServers: [],
    mcpMarketplaceCatalog: { items: [] },
    onRelinquishControl: () => () => undefined,
    vscodeTerminalExecutionMode: "backgroundExec",
    clineMessages: [],
    showFeatureTips: false,
    currentTaskItem: { id: "task-1" },
}))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => state }))

const props = { isExpanded: true, isLast: false, onSetQuote: vi.fn(), onToggleExpand: vi.fn() }

describe("memoized chat row titles", () => {
    it.each([
        {
            message: {
                ts: 1,
                type: "ask",
                ask: "followup",
                text: JSON.stringify({ question: "Keep this question?", options: ["Keep original"] }),
            } satisfies UiMessage,
            english: "Dline has a question:",
            chinese: "Dline 有一个问题：",
            raw: "Keep this question?",
        },
        {
            message: {
                ts: 2,
                type: "ask",
                ask: "use_mcp_server",
                text: JSON.stringify({ serverName: "npm-docs", type: "use_mcp_tool", toolName: "get-docs", arguments: "{}" }),
            } satisfies UiMessage,
            english: "Dline wants to use a tool on the npm-docs MCP server:",
            chinese: "Dline 想要在 npm-docs MCP 服务器上使用工具：",
            raw: "npm-docs",
        },
        {
            message: {
                ts: 3,
                type: "ask",
                ask: "use_mcp_server",
                text: JSON.stringify({ serverName: "npm-docs", type: "access_mcp_resource", uri: "docs://original" }),
            } satisfies UiMessage,
            english: "Dline wants to access a resource on the npm-docs MCP server:",
            chinese: "Dline 想要访问 npm-docs MCP 服务器上的资源：",
            raw: "npm-docs",
        },
    ])("updates the title without replacing raw content: $english", ({ message, english, chinese, raw }) => {
        const row = <ChatRowContent {...props} message={message} />
        const { container, rerender } = render(<UiLanguageProvider language="en">{row}</UiLanguageProvider>)
        expect(container).toHaveTextContent(english)
        const content = screen.getAllByText(raw)[0]
        rerender(<UiLanguageProvider language="zh-CN">{row}</UiLanguageProvider>)
        expect(container).toHaveTextContent(chinese)
        expect(screen.getAllByText(raw)[0]).toBe(content)
        rerender(<UiLanguageProvider language="en">{row}</UiLanguageProvider>)
        expect(container).toHaveTextContent(english)
        expect(screen.getAllByText(raw)[0]).toBe(content)
    })
})

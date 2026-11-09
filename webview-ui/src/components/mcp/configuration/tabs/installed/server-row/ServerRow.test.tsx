// @vitest-environment jsdom

import type { McpServer } from "@shared/mcp"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import {
    type ButtonHTMLAttributes,
    Children,
    type HTMLAttributes,
    type InputHTMLAttributes,
    isValidElement,
    type ReactNode,
    type SelectHTMLAttributes,
} from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import ServerRow from "./ServerRow"

const mocks = vi.hoisted(() => ({
    authenticateMcpServer: vi.fn(),
    clearMcpServerVariables: vi.fn(),
    restartMcpServer: vi.fn(),
    setMcpServers: vi.fn(),
    toggleMcpServer: vi.fn(),
    toggleToolAutoApprove: vi.fn(),
    updateMcpTimeout: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({
        autoApprovalSettings: { actions: { useMcp: true } },
        mcpMarketplaceCatalog: { items: [] },
        remoteConfigSettings: undefined,
        setMcpServers: mocks.setMcpServers,
    }),
}))

vi.mock("@/services/grpc-client", () => ({
    McpServiceClient: {
        authenticateMcpServer: mocks.authenticateMcpServer,
        clearMcpServerVariables: mocks.clearMcpServerVariables,
        deleteMcpServer: vi.fn(),
        restartMcpServer: mocks.restartMcpServer,
        toggleMcpServer: mocks.toggleMcpServer,
        toggleToolAutoApprove: mocks.toggleToolAutoApprove,
        updateMcpTimeout: mocks.updateMcpTimeout,
    },
}))

vi.mock("@/components/ui/switch", () => ({
    Switch: ({ checked, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { checked?: boolean }) => (
        <button aria-checked={checked} role="switch" type="button" {...props} />
    ),
}))

vi.mock("@/components/ui/tooltip", () => ({
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
    VSCodeCheckbox: ({ children, ...props }: InputHTMLAttributes<HTMLInputElement> & { children?: ReactNode }) => (
        <label>
            <input type="checkbox" {...props} />
            {children}
        </label>
    ),
    VSCodeDropdown: ({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) => (
        <select {...props}>
            {Children.toArray(children).filter(
                (child) => !isValidElement<{ slot?: string }>(child) || child.props.slot !== "selected-value",
            )}
        </select>
    ),
    VSCodeOption: ({
        ariaLabel: _ariaLabel,
        ...props
    }: React.OptionHTMLAttributes<HTMLOptionElement> & { ariaLabel?: string }) => <option {...props} />,
    VSCodePanels: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    VSCodePanelTab: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    VSCodePanelView: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
}))

const workspaceServer: McpServer = {
    name: "docs@a1b2c3d4",
    displayName: "docs",
    description: "Workspace docs",
    source: "workspace",
    config: JSON.stringify({ type: "stdio", command: "node", timeout: 60 }),
    status: "connected",
    tools: [{ name: "search", autoApprove: false }],
}

describe("ServerRow workspace descriptor presentation", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it("shows the descriptor display name without settings-backed controls", () => {
        render(<ServerRow hasTrashIcon server={workspaceServer} />)

        expect(screen.getByText("docs")).toBeInTheDocument()
        expect(screen.queryByText("docs@a1b2c3d4")).not.toBeInTheDocument()
        expect(screen.queryByTitle("Delete Server")).not.toBeInTheDocument()

        fireEvent.click(screen.getByText("docs"))

        expect(screen.queryByText("Request Timeout")).not.toBeInTheDocument()
        expect(screen.queryByRole("button", { name: "Delete Server" })).not.toBeInTheDocument()
        expect(screen.getAllByRole("button", { name: "Restart Server" })).toHaveLength(2)
    })

    it("lets the user grant auto-approve to a workspace tool, unchecked until granted", () => {
        mocks.toggleToolAutoApprove.mockResolvedValue({ mcpServers: [] })
        const { rerender } = render(<ServerRow server={workspaceServer} />)
        fireEvent.click(screen.getByText("docs"))

        const toolCheckbox = screen.getByRole("checkbox", { name: "Auto-approve" })
        expect(toolCheckbox).not.toBeChecked()
        expect(screen.getByRole("checkbox", { name: "Auto-approve all tools" })).not.toBeChecked()

        fireEvent.click(toolCheckbox)

        // The backend records the grant for the internal workspace name, not in the descriptor file.
        expect(mocks.toggleToolAutoApprove).toHaveBeenCalledWith({
            serverName: "docs@a1b2c3d4",
            toolNames: ["search"],
            autoApprove: true,
        })

        rerender(<ServerRow server={{ ...workspaceServer, tools: [{ name: "search", autoApprove: true }] }} />)
        expect(screen.getByRole("checkbox", { name: "Auto-approve" })).toBeChecked()
    })

    it("switches a workspace server for the workspace when no task scope is given", () => {
        mocks.toggleMcpServer.mockResolvedValue({ mcpServers: [] })
        render(<ServerRow server={workspaceServer} />)

        const toggle = screen.getByRole("switch")
        expect(toggle).toHaveAttribute("aria-checked", "true")
        fireEvent.click(toggle)

        // The backend routes a workspace server to the workspace-level toggle, not mcp_settings.json.
        expect(mocks.toggleMcpServer).toHaveBeenCalledWith(
            expect.objectContaining({ serverName: "docs@a1b2c3d4", disabled: true }),
        )
    })

    it("keeps the existing task-scoped toggle", () => {
        const onToggleEnabled = vi.fn()
        render(<ServerRow enabled={false} onToggleEnabled={onToggleEnabled} server={workspaceServer} />)

        fireEvent.click(screen.getByRole("switch"))

        expect(onToggleEnabled).toHaveBeenCalledWith(true)
        expect(mocks.toggleMcpServer).not.toHaveBeenCalled()
    })

    it("does not offer deletion when a workspace descriptor connection fails", () => {
        render(<ServerRow hasTrashIcon server={{ ...workspaceServer, error: "Connection failed", status: "disconnected" }} />)

        expect(screen.getByText("Connection failed")).toBeInTheDocument()
        expect(screen.getByRole("button", { name: "Retry Connection" })).toBeInTheDocument()
        expect(screen.queryByRole("button", { name: "Delete Server" })).not.toBeInTheDocument()
    })

    it("keeps settings-backed controls for a settings server", () => {
        const settingsServer: McpServer = {
            ...workspaceServer,
            name: "global-docs",
            displayName: undefined,
            source: "settings",
        }
        render(<ServerRow hasTrashIcon server={settingsServer} />)

        expect(screen.getByRole("switch")).toBeInTheDocument()
        expect(screen.getByTitle("Delete Server")).toBeInTheDocument()
        fireEvent.click(screen.getByText("global-docs"))

        expect(screen.getByText("Request Timeout")).toBeInTheDocument()
        expect(screen.getByText("Auto-approve all tools")).toBeInTheDocument()
        expect(screen.getByText("Auto-approve")).toBeInTheDocument()
        expect(screen.getAllByRole("button", { name: "Delete Server" })).toHaveLength(2)
    })

    it("defaults unconfigured settings tools to auto-approve and persists an explicit disable", () => {
        mocks.toggleToolAutoApprove.mockResolvedValue({ mcpServers: [] })
        const settingsServer: McpServer = {
            ...workspaceServer,
            name: "global-docs",
            displayName: undefined,
            source: "settings",
            tools: [{ name: "search" }],
        }
        render(<ServerRow server={settingsServer} />)
        fireEvent.click(screen.getByText("global-docs"))

        const toolCheckbox = screen.getByRole("checkbox", { name: "Auto-approve" })
        expect(toolCheckbox).toBeChecked()

        fireEvent.click(toolCheckbox)

        expect(mocks.toggleToolAutoApprove).toHaveBeenCalledWith({
            serverName: "global-docs",
            toolNames: ["search"],
            autoApprove: false,
        })
    })
})

describe("ServerRow connection errors", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.authenticateMcpServer.mockResolvedValue({})
        mocks.restartMcpServer.mockResolvedValue({ mcpServers: [] })
    })

    it("keeps retrying available beside Authenticate when the server asked for authentication", () => {
        const server: McpServer = {
            ...workspaceServer,
            name: "show3d",
            displayName: undefined,
            source: "settings",
            config: JSON.stringify({ type: "streamableHttp", url: "http://127.0.0.1:3000/mcp" }),
            status: "disconnected",
            oauthRequired: true,
            oauthAuthStatus: "unauthenticated",
            error: "The server answered 401 Unauthorized: authenticate to connect, or retry if it was restarted.",
        }
        render(<ServerRow server={server} />)

        fireEvent.click(screen.getByRole("button", { name: "Authenticate" }))
        expect(mocks.authenticateMcpServer).toHaveBeenCalledWith({ value: "show3d" })

        fireEvent.click(screen.getByRole("button", { name: "Retry Connection" }))
        expect(mocks.restartMcpServer).toHaveBeenCalledWith({ value: "show3d" })
    })

    it("offers Reauthorize when saved OAuth credentials are no longer valid", () => {
        const server: McpServer = {
            ...workspaceServer,
            name: "show3d",
            source: "settings",
            status: "disconnected",
            oauthRequired: true,
            oauthAuthStatus: "reauthentication-required",
            error: "Authorization for this server is no longer valid. Reauthorize to reconnect.",
        }
        render(<ServerRow server={server} />)

        fireEvent.click(screen.getByRole("button", { name: "Reauthorize" }))
        expect(mocks.authenticateMcpServer).toHaveBeenCalledWith({ value: "show3d" })
        expect(screen.queryByRole("button", { name: "Authenticate" })).not.toBeInTheDocument()
    })

    it("offers only retrying when the server is unavailable", () => {
        render(<ServerRow server={{ ...workspaceServer, error: "fetch failed: connect ECONNREFUSED", status: "disconnected" }} />)

        expect(screen.queryByRole("button", { name: "Authenticate" })).not.toBeInTheDocument()
        expect(screen.queryByRole("button", { name: "Reauthorize" })).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Retry Connection" }))
        expect(mocks.restartMcpServer).toHaveBeenCalledWith({ value: "docs@a1b2c3d4" })
    })
})

describe("ServerRow saved variables", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.clearMcpServerVariables.mockResolvedValue({ mcpServers: [] })
    })

    it("offers clearing saved variables on the collapsed row of a server that references ${env:...}", () => {
        const server: McpServer = {
            ...workspaceServer,
            config: JSON.stringify({ type: "stdio", command: "node", env: { API_TOKEN: "${env:DOCS_TOKEN}" } }),
        }
        render(<ServerRow server={server} />)

        // Reachable without expanding the row.
        fireEvent.click(screen.getByTitle("Clear Saved Variables"))

        expect(mocks.clearMcpServerVariables).toHaveBeenCalledWith({ value: "docs@a1b2c3d4" })
    })

    it("offers no clearing for a server without ${env:...} references, which never has saved values", () => {
        render(<ServerRow server={workspaceServer} />)
        fireEvent.click(screen.getByText("docs"))

        expect(screen.queryByTitle("Clear Saved Variables")).not.toBeInTheDocument()
        expect(screen.queryByRole("button", { name: "Clear Saved Variables" })).not.toBeInTheDocument()
    })
})

describe("ServerRow live UI language and external contracts", () => {
    beforeEach(() => vi.clearAllMocks())
    it("keeps disclosure and numeric timeout, translates every table wrapper and sends exact original approval/toggle identity", async () => {
        mocks.toggleToolAutoApprove.mockResolvedValue({ mcpServers: [] })
        mocks.toggleMcpServer.mockResolvedValue({ mcpServers: [] })
        mocks.updateMcpTimeout.mockResolvedValue({ mcpServers: [] })
        let server: McpServer = {
            ...workspaceServer,
            source: "settings",
            tools: [
                {
                    name: "Search_Original",
                    description: "Do NOT translate this tool",
                    autoApprove: false,
                    inputSchema: { properties: { Query: { description: "User schema description" } }, required: ["Query"] },
                },
            ],
            resources: [
                {
                    name: "Original Resource",
                    uri: "repository://CaseSensitive/URI",
                    description: "External resource body",
                    mimeType: "text/plain",
                },
            ],
            prompts: [
                {
                    name: "Prompt_Name",
                    title: "Original Prompt",
                    description: "Third-party prompt body",
                    arguments: [{ name: "Input_Original", description: "Raw argument description", required: true }],
                },
            ],
        }
        const tree = (language: "en" | "zh-CN") => (
            <UiLanguageProvider language={language}>
                <ServerRow server={server} />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        fireEvent.click(screen.getByText("docs"))
        const timeout = screen.getByRole("combobox", { name: "Request Timeout" })
        fireEvent.change(timeout, { target: { value: "300" } })
        await waitFor(() => expect(mocks.updateMcpTimeout).toHaveBeenCalledWith({ serverName: "docs@a1b2c3d4", timeout: 300 }))
        const approval = screen.getByRole("checkbox", { name: "Auto-approve" })
        const toggle = screen.getByRole("switch", { name: "Enable docs" })
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("combobox", { name: "请求超时" })).toBe(timeout)
        expect(timeout).toHaveValue("300")
        expect(screen.getByRole("option", { name: "5 分钟" })).toHaveValue("300")
        expect(screen.getByRole("checkbox", { name: "自动批准" })).toBe(approval)
        expect(approval).not.toBeChecked()
        expect(screen.getByText("参数")).toBeInTheDocument()
        expect(screen.getByText("调用参数")).toBeInTheDocument()
        for (const text of [
            "Search_Original",
            "Do NOT translate this tool",
            "Query",
            "User schema description",
            "repository://CaseSensitive/URI",
            "Original Resource: External resource body",
            "text/plain",
            "Original Prompt",
            "Third-party prompt body",
            "Input_Original",
            "Raw argument description",
        ]) {
            expect(screen.getByText(text)).toBeInTheDocument()
        }
        fireEvent.click(approval)
        expect(mocks.toggleToolAutoApprove).toHaveBeenLastCalledWith({
            serverName: "docs@a1b2c3d4",
            toolNames: ["Search_Original"],
            autoApprove: true,
        })
        fireEvent.click(toggle)
        expect(mocks.toggleMcpServer).toHaveBeenLastCalledWith({ serverName: "docs@a1b2c3d4", disabled: true })
        server = { ...server, disabled: true, tools: server.tools?.map((tool) => ({ ...tool, autoApprove: true })) }
        view.rerender(tree("en"))
        expect(screen.getByRole("combobox", { name: "Request Timeout" })).toBe(timeout)
        expect(timeout).toHaveValue("300")
        expect(screen.getByRole("checkbox", { name: "Auto-approve" })).toBe(approval)
        expect(approval).toBeChecked()
        expect(screen.getByRole("switch", { name: "Enable docs" })).toBe(toggle)
        expect(toggle).toHaveAttribute("aria-checked", "false")
        expect(screen.getByText("Parameters")).toBeInTheDocument()
        expect(mocks.updateMcpTimeout).toHaveBeenCalledTimes(1)
        expect(mocks.toggleMcpServer).toHaveBeenCalledTimes(1)
        expect(mocks.toggleToolAutoApprove).toHaveBeenCalledTimes(1)
    })

    it("retranslates connection and OAuth error wrappers but never interprets or rewrites diagnostics", () => {
        mocks.authenticateMcpServer.mockResolvedValue({})
        const server: McpServer = {
            ...workspaceServer,
            error: "401 原始 error: https://host/Exact",
            oauthRequired: true,
            oauthAuthStatus: "reauthentication-required",
            status: "disconnected",
        }
        const tree = (language: "en" | "zh-CN") => (
            <UiLanguageProvider language={language}>
                <ServerRow server={server} />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        const button = screen.getByRole("button", { name: "Reauthorize" })
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("alert")).toHaveTextContent("无法连接到 MCP 服务器")
        expect(screen.getByRole("alert")).toHaveTextContent(server.error || "")
        expect(screen.getByRole("button", { name: "重新授权" })).toBe(button)
        fireEvent.click(button)
        expect(mocks.authenticateMcpServer).toHaveBeenCalledWith({ value: "docs@a1b2c3d4" })
        view.rerender(tree("en"))
        expect(screen.getByRole("button", { name: "Reauthorize" })).toBe(button)
        expect(screen.getByRole("alert")).toHaveTextContent("Could not connect to the MCP server.")
        expect(screen.getByRole("alert")).toHaveTextContent(server.error || "")
    })
})

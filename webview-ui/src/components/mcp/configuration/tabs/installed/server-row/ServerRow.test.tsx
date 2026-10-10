// @vitest-environment jsdom

import type { McpServer } from "@shared/mcp"
import { fireEvent, render, screen } from "@testing-library/react"
import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ServerRow from "./ServerRow"

const mocks = vi.hoisted(() => ({
    setMcpServers: vi.fn(),
    toggleMcpServer: vi.fn(),
    toggleToolAutoApprove: vi.fn(),
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
        authenticateMcpServer: vi.fn(),
        deleteMcpServer: vi.fn(),
        restartMcpServer: vi.fn(),
        toggleMcpServer: mocks.toggleMcpServer,
        toggleToolAutoApprove: mocks.toggleToolAutoApprove,
        updateMcpTimeout: vi.fn(),
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
    VSCodeDropdown: (props: SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} />,
    VSCodeOption: (props: React.OptionHTMLAttributes<HTMLOptionElement>) => <option {...props} />,
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
        expect(screen.queryByRole("switch")).not.toBeInTheDocument()
        expect(screen.queryByTitle("Delete Server")).not.toBeInTheDocument()

        fireEvent.click(screen.getByText("docs"))

        expect(screen.queryByText("Request Timeout")).not.toBeInTheDocument()
        expect(screen.queryByText("Auto-approve all tools")).not.toBeInTheDocument()
        expect(screen.queryByText("Auto-approve")).not.toBeInTheDocument()
        expect(screen.queryByRole("button", { name: "Delete Server" })).not.toBeInTheDocument()
        expect(screen.getAllByRole("button", { name: "Restart Server" })).toHaveLength(2)
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

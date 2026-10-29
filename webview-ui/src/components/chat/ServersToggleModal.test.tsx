// @vitest-environment jsdom

import { render, screen } from "@testing-library/react"
import type { ButtonHTMLAttributes, ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ServersToggleModal from "./ServersToggleModal"

const mocks = vi.hoisted(() => ({
    extensionState: {
        mcpEnabled: true,
        mcpServers: [],
        navigateToMcp: vi.fn(),
        setMcpServers: vi.fn(),
    },
}))

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => mocks.extensionState,
}))

vi.mock("@/hooks/useTaskCapabilityToggles", () => ({
    useTaskCapabilityToggles: () => ({
        isTaskScoped: false,
        reconcile: vi.fn(),
        snapshot: undefined,
        updateToggle: vi.fn(),
    }),
}))

vi.mock("react-use", () => ({
    useClickAway: vi.fn(),
    useWindowSize: () => ({ height: 800, width: 1200 }),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
    VSCodeButton: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { children?: ReactNode }) => (
        <button type="button" {...props}>
            {children}
        </button>
    ),
}))

vi.mock("@/components/common/PopupModalContainer", () => ({
    default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock("@/components/mcp/configuration/tabs/installed/ServersToggleList", () => ({
    default: () => <div>servers</div>,
}))

vi.mock("@/components/ui/tooltip", () => ({
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock("@/services/grpc-client", () => ({
    McpServiceClient: {
        getLatestMcpServers: vi.fn(),
        toggleMcpServer: vi.fn(),
    },
}))

describe("ServersToggleModal feature gate", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.extensionState.mcpEnabled = true
    })

    it("shows the MCP entry when MCP is enabled", () => {
        render(<ServersToggleModal />)

        expect(screen.getByRole("button", { name: "Show MCP Servers" })).toBeInTheDocument()
    })

    it("hides the MCP entry when MCP is disabled", () => {
        mocks.extensionState.mcpEnabled = false

        render(<ServersToggleModal />)

        expect(screen.queryByRole("button", { name: "Show MCP Servers" })).not.toBeInTheDocument()
    })
})

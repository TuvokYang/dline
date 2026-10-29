// @vitest-environment jsdom

import type { McpMarketplaceCatalog, McpMarketplaceItem } from "@shared/mcp"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import McpMarketplaceView from "./McpMarketplaceView"

const mocks = vi.hoisted(() => ({
    refreshMcpMarketplace: vi.fn(),
    setMcpMarketplaceCatalog: vi.fn(),
    catalog: { items: [] } as McpMarketplaceCatalog,
}))

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({
        mcpServers: [],
        mcpMarketplaceCatalog: mocks.catalog,
        setMcpMarketplaceCatalog: mocks.setMcpMarketplaceCatalog,
        remoteConfigSettings: undefined,
    }),
}))

vi.mock("@/services/grpc-client", () => ({
    McpServiceClient: {
        refreshMcpMarketplace: mocks.refreshMcpMarketplace,
        downloadMcp: vi.fn(),
    },
}))

vi.mock("./McpMarketplaceCard", () => ({
    default: ({ item }: { item: McpMarketplaceItem }) => <div data-testid="marketplace-card">{item.name}</div>,
}))

vi.mock("./McpSubmitCard", () => ({
    default: () => <div data-testid="submit-card" />,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
    VSCodeButton: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
        <button type="button" {...props}>
            {children}
        </button>
    ),
    VSCodeDropdown: ({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) => <select {...props}>{children}</select>,
    VSCodeOption: (props: React.OptionHTMLAttributes<HTMLOptionElement>) => <option {...props} />,
    VSCodeProgressRing: () => <div data-testid="progress-ring" />,
    VSCodeRadio: ({ children, ...props }: InputHTMLAttributes<HTMLInputElement> & { children?: ReactNode }) => (
        <label>
            <input type="radio" {...props} />
            {children}
        </label>
    ),
    VSCodeRadioGroup: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    // The search field must survive re-renders, so it is rendered as a plain controlled input.
    VSCodeTextField: ({
        children,
        onInput,
        value,
        placeholder,
    }: {
        children?: ReactNode
        onInput?: (event: { target: HTMLInputElement }) => void
        value?: string
        placeholder?: string
    }) => (
        <div>
            <input
                onChange={(event) => onInput?.({ target: event.target as HTMLInputElement })}
                placeholder={placeholder}
                value={value ?? ""}
            />
            {children}
        </div>
    ),
}))

function buildItem(overrides: Partial<McpMarketplaceItem> = {}): McpMarketplaceItem {
    return {
        mcpId: "example/server",
        githubUrl: "https://github.com/example/server",
        name: "Example Server",
        author: "example",
        description: "An example MCP server",
        codiconIcon: "server",
        logoUrl: "",
        category: "Utilities",
        tags: ["example"],
        requiresApiKey: false,
        readmeContent: "",
        llmsInstallationContent: "",
        isRecommended: false,
        githubStars: 1,
        downloadCount: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastGithubSync: "2026-01-01T00:00:00.000Z",
        ...overrides,
    } as McpMarketplaceItem
}

describe("McpMarketplaceView", () => {
    beforeEach(() => {
        mocks.refreshMcpMarketplace.mockReset()
        mocks.setMcpMarketplaceCatalog.mockReset()
        mocks.catalog = { items: [buildItem(), buildItem({ mcpId: "other/server", name: "Other Server" })] }
    })

    it("requests the marketplace catalog exactly once per mount", async () => {
        mocks.refreshMcpMarketplace.mockResolvedValue(mocks.catalog)

        render(<McpMarketplaceView />)

        await waitFor(() => {
            expect(screen.queryByTestId("progress-ring")).not.toBeInTheDocument()
        })

        // A render loop would keep issuing requests, so the count must stay at one.
        expect(mocks.refreshMcpMarketplace).toHaveBeenCalledTimes(1)
    })

    it("keeps the search field mounted and filters locally without extra requests", async () => {
        mocks.refreshMcpMarketplace.mockResolvedValue(mocks.catalog)
        const user = userEvent.setup()

        render(<McpMarketplaceView />)

        await waitFor(() => {
            expect(screen.queryByTestId("progress-ring")).not.toBeInTheDocument()
        })
        expect(screen.getAllByTestId("marketplace-card")).toHaveLength(2)

        const searchField = screen.getByPlaceholderText("Search MCPs...")
        await user.type(searchField, "Other")

        // The field must not be unmounted mid-typing, so every character is retained.
        expect(screen.getByPlaceholderText("Search MCPs...")).toHaveValue("Other")

        await waitFor(() => {
            expect(screen.getAllByTestId("marketplace-card")).toHaveLength(1)
        })
        expect(screen.getByText("Other Server")).toBeInTheDocument()

        // Filtering is local; typing must not trigger additional catalog requests.
        expect(mocks.refreshMcpMarketplace).toHaveBeenCalledTimes(1)
    })

    it("keeps the search field available when the catalog request fails", async () => {
        mocks.refreshMcpMarketplace.mockRejectedValue(new Error("network down"))
        vi.spyOn(console, "error").mockImplementation(() => {})

        render(<McpMarketplaceView />)

        await waitFor(() => {
            expect(screen.getByText("Failed to load marketplace data")).toBeInTheDocument()
        })
        expect(screen.getByPlaceholderText("Search MCPs...")).toBeInTheDocument()
        expect(screen.getByText("Retry")).toBeInTheDocument()
    })

    it("retries the catalog request when Retry is pressed", async () => {
        mocks.refreshMcpMarketplace.mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce(mocks.catalog)
        vi.spyOn(console, "error").mockImplementation(() => {})
        const user = userEvent.setup()

        render(<McpMarketplaceView />)

        await waitFor(() => {
            expect(screen.getByText("Retry")).toBeInTheDocument()
        })

        await user.click(screen.getByText("Retry"))

        await waitFor(() => {
            expect(mocks.refreshMcpMarketplace).toHaveBeenCalledTimes(2)
        })
        await waitFor(() => {
            expect(screen.getAllByTestId("marketplace-card")).toHaveLength(2)
        })
    })
})

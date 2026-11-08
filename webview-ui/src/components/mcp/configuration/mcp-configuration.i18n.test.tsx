import type { McpMarketplaceCatalog, McpMarketplaceItem } from "@shared/mcp"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import {
    type ButtonHTMLAttributes,
    Children,
    type HTMLAttributes,
    type InputHTMLAttributes,
    isValidElement,
    type ReactNode,
    type SelectHTMLAttributes,
} from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import AddRemoteServerForm from "./tabs/add-server/AddRemoteServerForm"
import ConfigureServersView from "./tabs/installed/ConfigureServersView"
import McpMarketplaceView from "./tabs/marketplace/McpMarketplaceView"

const mocks = vi.hoisted(() => ({
    addServer: vi.fn(),
    refresh: vi.fn(),
    download: vi.fn(),
    setServers: vi.fn(),
    relinquish: vi.fn(),
    navigate: vi.fn(),
    openSettings: vi.fn(),
}))
let catalog: McpMarketplaceCatalog = { items: [] }
const setCatalog = (next: McpMarketplaceCatalog) => {
    catalog = next
}
vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({
        mcpServers: [],
        mcpMarketplaceCatalog: catalog,
        setMcpMarketplaceCatalog: setCatalog,
        setMcpServers: mocks.setServers,
        navigateToSettings: mocks.navigate,
        remoteConfigSettings: {},
        onRelinquishControl: mocks.relinquish,
    }),
}))
vi.mock("@/services/grpc-client", () => ({
    McpServiceClient: {
        addRemoteMcpServer: mocks.addServer,
        openMcpSettings: mocks.openSettings,
        refreshMcpMarketplace: mocks.refresh,
        downloadMcp: mocks.download,
    },
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
    VSCodeButton: ({ appearance: _appearance, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { appearance?: string }) => (
        <button {...props} />
    ),
    VSCodeLink: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
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
    VSCodeProgressRing: (props: HTMLAttributes<HTMLDivElement>) => <div role="status" {...props} />,
    // The toolkit radio group owns change handling; native changes still bubble to it.
    VSCodeRadio: ({ children, ...props }: InputHTMLAttributes<HTMLInputElement>) => (
        <label>
            <input onChange={() => undefined} type="radio" {...props} />
            {children}
        </label>
    ),
    VSCodeRadioGroup: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    VSCodeTextField: ({ children, ...props }: InputHTMLAttributes<HTMLInputElement> & { children?: ReactNode }) => (
        <label>
            {children}
            <input {...props} />
        </label>
    ),
}))
function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((yes, no) => {
        resolve = yes
        reject = no
    })
    return { promise, resolve, reject }
}
/** Each card renders its own install button, so target the card by its server name. */
function cardFor(serverName: string): HTMLElement {
    const heading = screen.getByRole("heading", { name: serverName })
    const card = heading.closest("a")
    if (!card) throw new Error(`Expected card for ${serverName}`)
    return card
}
function installButton(serverName: string): HTMLElement {
    return within(cardFor(serverName)).getByRole("button")
}
function item(overrides: Partial<McpMarketplaceItem> = {}): McpMarketplaceItem {
    return {
        mcpId: "Owner/Original_ID",
        githubUrl: "https://github.com/Original/Repo",
        name: "Original Server",
        author: "Original Author",
        description: "Parameters",
        codiconIcon: "server",
        logoUrl: "https://original.example/Logo.png",
        category: "External Category",
        tags: ["Original_Tag"],
        requiresApiKey: true,
        readmeContent: "Original README",
        llmsInstallationContent: "Original installation instructions",
        isRecommended: false,
        githubStars: 12,
        downloadCount: 34,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        lastGithubSync: "2026-01-01",
        ...overrides,
    }
}
beforeEach(() => {
    vi.clearAllMocks()
    catalog = {
        items: [
            item(),
            item({ mcpId: "Other/Server", name: "Other Server", description: "Unrelated", category: "Other Category" }),
        ],
    }
    mocks.refresh.mockImplementation(async () => catalog)
    mocks.relinquish.mockReturnValue(() => undefined)
    // The settings action is fire-and-forget with a catch, so it must resolve.
    mocks.openSettings.mockResolvedValue({})
})
afterEach(() => {
    cleanup()
    // restoreMocks is off for this project, so console spies must be restored explicitly.
    vi.restoreAllMocks()
})

describe("MCP remote server form live language", () => {
    it("keeps drafts/transport/pending intent and retryable diagnostics while sending the original name and URL", async () => {
        const pending = deferred<{ mcpServers: [] }>()
        mocks.addServer.mockReturnValueOnce(pending.promise).mockResolvedValue({ mcpServers: [] })
        const done = vi.fn()
        const tree = (language: "en" | "zh-CN") => (
            <UiLanguageProvider language={language}>
                <AddRemoteServerForm onServerAdded={done} />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        const name = screen.getByRole("textbox", { name: "Server Name" })
        const url = screen.getByRole("textbox", { name: "Server URL" })
        const form = name.closest("form")
        if (!form) throw new Error("Expected remote server form")
        fireEvent.submit(form)
        expect(screen.getByRole("alert")).toHaveTextContent("Server name is required")
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("alert")).toHaveTextContent("请输入服务器名称")
        expect(screen.getByRole("textbox", { name: "服务器名称" })).toBe(name)
        fireEvent.change(name, { target: { value: "  Original Server 中文  " } })
        fireEvent.change(url, { target: { value: "https://Original.example/CaseSensitive" } })
        fireEvent.click(screen.getByRole("radio", { name: "SSE（旧版）" }))
        fireEvent.submit(form)
        expect(mocks.addServer).toHaveBeenCalledWith({
            serverName: "Original Server 中文",
            serverUrl: "https://Original.example/CaseSensitive",
            transportType: "sse",
        })
        expect(screen.getByRole("button", { name: "正在连接…" })).toBeDisabled()
        view.rerender(tree("en"))
        expect(screen.getByRole("textbox", { name: "Server Name" })).toBe(name)
        expect(name).toHaveValue("  Original Server 中文  ")
        expect(url).toHaveValue("https://Original.example/CaseSensitive")
        expect(screen.getByRole("radio", { name: "SSE (Legacy)" })).toBeChecked()
        expect(screen.getByRole("button", { name: "Connecting..." })).toBeDisabled()
        await act(async () => pending.reject(new Error("401 Original raw error 中文")))
        expect(screen.getByRole("alert")).toHaveTextContent("Failed to add server")
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("alert")).toHaveTextContent("添加服务器失败")
        expect(screen.getByRole("alert")).toHaveTextContent("401 Original raw error 中文")
        fireEvent.submit(form)
        await waitFor(() => expect(done).toHaveBeenCalledTimes(1))
        expect(mocks.addServer).toHaveBeenCalledTimes(2)
        expect(mocks.addServer.mock.calls[1][0]).toEqual(mocks.addServer.mock.calls[0][0])
        expect(mocks.setServers).toHaveBeenCalledWith([])
        expect(name).toHaveValue("")
    })
})

describe("MCP marketplace live language", () => {
    it("preserves search/filter/sort, external market text, installation identity and retained error diagnostics", async () => {
        const install = deferred<{ error: string }>()
        mocks.download.mockReturnValue(install.promise)
        const tree = (language: "en" | "zh-CN") => (
            <UiLanguageProvider language={language}>
                <McpMarketplaceView />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        await screen.findByText("Original Server")
        const search = screen.getByRole("textbox", { name: "Search MCPs..." })
        fireEvent.input(search, { target: { value: "Original" } })
        const filter = screen.getByRole("combobox", { name: "Filter:" })
        fireEvent.change(filter, { target: { value: "External Category" } })
        fireEvent.click(screen.getByRole("radio", { name: "Name" }))
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("textbox", { name: "搜索 MCP…" })).toBe(search)
        expect(search).toHaveValue("Original")
        expect(screen.getByRole("combobox", { name: "筛选：" })).toBe(filter)
        expect(filter).toHaveValue("External Category")
        expect(screen.getByRole("radio", { name: "名称" })).toBeChecked()
        expect(screen.getByText("Parameters")).toBeInTheDocument()
        expect(screen.getByText("Original Author")).toBeInTheDocument()
        expect(screen.getByText("Original_Tag")).toBeInTheDocument()
        expect(screen.getByAltText("Original Server 标志")).toHaveAttribute("src", "https://original.example/Logo.png")
        expect(screen.getByTitle("需要 API 密钥")).toBeInTheDocument()
        const button = screen.getByRole("button", { name: "安装" })
        fireEvent.click(button)
        expect(mocks.download).toHaveBeenCalledWith({ value: "Owner/Original_ID" })
        view.rerender(tree("en"))
        expect(screen.getByRole("button", { name: "Installing..." })).toBe(button)
        expect(button).toBeDisabled()
        expect(screen.getByRole("textbox", { name: "Search MCPs..." })).toBe(search)
        expect(mocks.refresh).toHaveBeenCalledTimes(1)
        await act(async () => install.resolve({ error: "Raw install error: Owner/Original_ID" }))
        expect(screen.getByRole("alert")).toHaveTextContent("Failed to install MCP server")
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("alert")).toHaveTextContent("安装 MCP 服务器失败")
        expect(screen.getByRole("alert")).toHaveTextContent("Raw install error: Owner/Original_ID")
        expect(screen.getByRole("textbox", { name: "搜索 MCP…" })).toHaveValue("Original")
        fireEvent.click(screen.getByRole("button", { name: "重试" }))
        await screen.findByText("Original Server")
        expect(mocks.refresh).toHaveBeenCalledTimes(2)
        expect(screen.getByText("Parameters")).toBeInTheDocument()
    })

    it("wraps a rejected transport install failure as a switchable install error without refetching", async () => {
        mocks.download.mockRejectedValue(new Error("Raw transport failure: Owner/Original_ID"))
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
        const tree = (language: "en" | "zh-CN") => (
            <UiLanguageProvider language={language}>
                <McpMarketplaceView />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        await screen.findByText("Original Server")
        fireEvent.click(installButton("Original Server"))
        expect(mocks.download).toHaveBeenCalledTimes(1)
        expect(mocks.download).toHaveBeenCalledWith({ value: "Owner/Original_ID" })
        const alert = await screen.findByRole("alert")
        expect(alert).toHaveTextContent("Failed to install MCP server")
        expect(alert).toHaveTextContent("Raw transport failure: Owner/Original_ID")
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("alert")).toBe(alert)
        expect(alert).toHaveTextContent("安装 MCP 服务器失败")
        expect(alert).toHaveTextContent("Raw transport failure: Owner/Original_ID")
        view.rerender(tree("en"))
        expect(screen.getByRole("alert")).toBe(alert)
        expect(alert).toHaveTextContent("Failed to install MCP server")
        expect(alert).toHaveTextContent("Raw transport failure: Owner/Original_ID")
        expect(mocks.refresh).toHaveBeenCalledTimes(1)
        // The raw cause is only logged as a diagnostic; failure stays a render-time translation.
        expect(consoleError).toHaveBeenCalled()
    })

    it("keeps a server-provided install error verbatim instead of treating it as product text", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined)
        const response = deferred<{ error: string }>()
        mocks.download.mockReturnValue(response.promise)
        const tree = (language: "en" | "zh-CN") => (
            <UiLanguageProvider language={language}>
                <McpMarketplaceView />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        await screen.findByText("Original Server")
        fireEvent.click(installButton("Original Server"))
        await act(async () => response.resolve({ error: "Server refused: Owner/Original_ID" }))
        const alert = await screen.findByRole("alert")
        expect(alert).toHaveTextContent("Failed to install MCP server")
        expect(alert).toHaveTextContent("Server refused: Owner/Original_ID")
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("alert")).toBe(alert)
        expect(alert).toHaveTextContent("安装 MCP 服务器失败")
        expect(alert).toHaveTextContent("Server refused: Owner/Original_ID")
        // Retry re-requests the catalog; it must not replay the install.
        fireEvent.click(screen.getByRole("button", { name: "重试" }))
        await screen.findByText("Original Server")
        expect(mocks.download).toHaveBeenCalledTimes(1)
        expect(mocks.refresh).toHaveBeenCalledTimes(2)
        // The failure was local display state only: nothing was reported as installed.
        expect(within(cardFor("Original Server")).getByRole("button", { name: "安装" })).toBeEnabled()
    })

    it("wraps a non-Error install rejection as switchable diagnostics", async () => {
        const response = deferred<{ error: string }>()
        mocks.download.mockReturnValue(response.promise)
        vi.spyOn(console, "error").mockImplementation(() => undefined)
        const tree = (language: "en" | "zh-CN") => (
            <UiLanguageProvider language={language}>
                <McpMarketplaceView />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        await screen.findByText("Original Server")
        fireEvent.click(installButton("Original Server"))
        await act(async () => response.reject("Raw rejection: Owner/Original_ID"))
        const alert = await screen.findByRole("alert")
        expect(alert).toHaveTextContent("Failed to install MCP server")
        expect(alert).toHaveTextContent("Raw rejection: Owner/Original_ID")
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("alert")).toBe(alert)
        expect(alert).toHaveTextContent("安装 MCP 服务器失败")
        expect(alert).toHaveTextContent("Raw rejection: Owner/Original_ID")
        expect(mocks.refresh).toHaveBeenCalledTimes(1)
    })

    it("never issues a second install while the first attempt is still pending", async () => {
        const pending = deferred<{ error: string }>()
        mocks.download.mockReturnValue(pending.promise)
        const tree = (language: "en" | "zh-CN") => (
            <UiLanguageProvider language={language}>
                <McpMarketplaceView />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        await screen.findByText("Original Server")
        const button = installButton("Original Server")
        fireEvent.click(button)
        fireEvent.click(button)
        fireEvent.click(button)
        expect(mocks.download).toHaveBeenCalledTimes(1)
        expect(button).toBeDisabled()
        // The pending label is translated without re-requesting or resetting the attempt.
        view.rerender(tree("zh-CN"))
        expect(within(cardFor("Original Server")).getByRole("button", { name: "正在安装…" })).toBe(button)
        expect(button).toBeDisabled()
        expect(mocks.download).toHaveBeenCalledTimes(1)
        expect(mocks.refresh).toHaveBeenCalledTimes(1)
    })
})

describe("MCP configure servers live language", () => {
    const tree = (language: "en" | "zh-CN") => (
        <UiLanguageProvider language={language}>
            <ConfigureServersView />
        </UiLanguageProvider>
    )

    it("translates the illustrative example as display-only text and keeps protocol links, brand names and actions intact", () => {
        const view = render(tree("en"))
        const example = screen.getByText("add a tool that gets the latest npm docs")
        // The protocol and advanced links carry their own translated text, so match them by element.
        const protocol = document.querySelector<HTMLAnchorElement>('a[href="https://github.com/modelcontextprotocol"]')
        if (!protocol) throw new Error("Expected the protocol link")
        const community = screen.getByRole("link", { name: "community-made servers" })
        const demo = screen.getByRole("link", { name: "See a demo here." })
        const settings = screen.getByRole("button", { name: "Configure MCP Servers" })
        const advanced = screen.getByText("Advanced MCP Settings", { selector: "a" })
        expect(screen.getByText("No MCP servers installed")).toBeInTheDocument()

        view.rerender(tree("zh-CN"))
        // The example is a static illustration, so only its display form changes.
        expect(screen.getByText("添加一个获取最新 npm 文档的工具")).toBe(example)
        expect(document.querySelector('a[href="https://github.com/modelcontextprotocol"]')).toBe(protocol)
        expect(protocol).toHaveTextContent("Model Context Protocol")
        expect(protocol).toHaveAttribute("href", "https://github.com/modelcontextprotocol")
        expect(screen.getByRole("link", { name: "社区制作的服务器" })).toBe(community)
        expect(community).toHaveAttribute("href", "https://github.com/modelcontextprotocol/servers")
        expect(screen.getByRole("link", { name: "查看演示。" })).toBe(demo)
        expect(demo).toHaveAttribute("href", "https://x.com/sdrzn/status/1867271665086074969")
        expect(screen.getByRole("button", { name: "配置 MCP 服务器" })).toBe(settings)
        expect(screen.getByText("高级 MCP 设置", { selector: "a" })).toBe(advanced)
        expect(screen.getByText("未安装 MCP 服务器")).toBeInTheDocument()

        fireEvent.click(settings)
        expect(mocks.openSettings).toHaveBeenCalledTimes(1)
        fireEvent.click(advanced)
        expect(mocks.navigate).toHaveBeenCalledWith("features")

        view.rerender(tree("en"))
        expect(screen.getByRole("button", { name: "Configure MCP Servers" })).toBe(settings)
        expect(screen.getByText("add a tool that gets the latest npm docs")).toBe(example)
        expect(mocks.openSettings).toHaveBeenCalledTimes(1)
        expect(mocks.navigate).toHaveBeenCalledTimes(1)
    })
})

import { McpDisplayMode } from "@shared/McpDisplayMode"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { PropsWithChildren } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import ImagePreview from "./ImagePreview"
import LinkPreview from "./LinkPreview"
import McpResponseDisplay from "./McpResponseDisplay"
import McpToolRequest from "./McpToolRequest"

const mocks = vi.hoisted(() => ({
    mode: "plain" as McpDisplayMode,
    updateSetting: vi.fn(),
    fetchOpenGraph: vi.fn(),
    checkImage: vi.fn(),
    openInBrowser: vi.fn(),
}))
vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({ mcpResponsesCollapsed: false, mcpDisplayMode: mocks.mode }),
}))
vi.mock("@/components/settings/ApiOptions", () => ({
    DropdownContainer: ({ children }: PropsWithChildren) => <div>{children}</div>,
}))
vi.mock("@/components/settings/utils/settingsHandlers", () => ({ updateSetting: mocks.updateSetting }))
vi.mock("@/services/grpc-client", () => ({
    WebServiceClient: {
        fetchOpenGraphData: mocks.fetchOpenGraph,
        checkIsImageUrl: mocks.checkImage,
        openInBrowser: mocks.openInBrowser,
    },
    FileServiceClient: { openImage: vi.fn() },
}))
function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: Error) => void
    const promise = new Promise<T>((yes, no) => {
        resolve = yes
        reject = no
    })
    return { promise, resolve, reject }
}
beforeEach(() => {
    vi.clearAllMocks()
    mocks.mode = "plain"
})
afterEach(cleanup)

describe("MCP request and response live UI language", () => {
    it("preserves disclosure, raw tool/argument/response content and display-mode identity across both switches", () => {
        const tree = (language: "en" | "zh-CN") => (
            <UiLanguageProvider language={language}>
                <McpToolRequest
                    argumentsJson={'{"Query":"Keep English Path /Case"}'}
                    description="Original tool Description"
                    hasResponse
                    toolName="External_Tool"
                />
                <McpResponseDisplay responseText="Response Parameters Keep English URI://Case" />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        const title = screen.getByRole("button", { name: "External_Tool" })
        const card = screen.getByTestId("mcp-response-card")
        fireEvent.click(title)
        fireEvent.click(screen.getByText("Response"))
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("button", { name: "External_Tool" })).toBe(title)
        expect(title).toHaveAttribute("aria-expanded", "false")
        expect(screen.queryByTestId("mcp-tool-description")).not.toBeInTheDocument()
        expect(screen.queryByTestId("mcp-response-content")).not.toBeInTheDocument()
        expect(screen.getByTestId("mcp-response-card")).toBe(card)
        fireEvent.click(title)
        fireEvent.click(screen.getByText("响应"))
        expect(screen.getByText("描述")).toBeInTheDocument()
        expect(screen.getByText("调用参数")).toBeInTheDocument()
        expect(screen.getByText("Original tool Description")).toBeInTheDocument()
        expect(screen.getByText("Query")).toBeInTheDocument()
        expect(screen.getByText("Keep English Path /Case")).toBeInTheDocument()
        expect(screen.getByText("Response Parameters Keep English URI://Case")).toBeInTheDocument()
        const mode = screen.getByRole("combobox", { name: "响应显示模式" })
        fireEvent.change(mode, { target: { value: "markdown" } })
        expect(mocks.updateSetting).toHaveBeenLastCalledWith("mcpDisplayMode", "markdown")
        mocks.mode = "markdown"
        view.rerender(tree("en"))
        expect(screen.getByRole("combobox", { name: "Response display mode" })).toBe(mode)
        expect(mode).toHaveValue("markdown")
        expect(screen.getByRole("button", { name: "External_Tool" })).toBe(title)
        expect(title).toHaveAttribute("aria-expanded", "true")
        expect(screen.getByText("Description")).toBeInTheDocument()
        expect(screen.getByText("Arguments")).toBeInTheDocument()
        expect(screen.getByText("Response Parameters Keep English URI://Case")).toBeInTheDocument()
    })
})

describe("MCP memoized preview live UI language", () => {
    it("updates a pending and completed link preview through both memo boundaries without refetching third-party metadata", async () => {
        const request = deferred<{ title: string; description: string; siteName: string }>()
        mocks.fetchOpenGraph.mockReturnValue(request.promise)
        const tree = (language: "en" | "zh-CN") => (
            <UiLanguageProvider language={language}>
                <LinkPreview url="https://Original.example/Case" />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        const loading = screen.getByText("Loading preview for original.example...")
        view.rerender(tree("zh-CN"))
        expect(screen.getByText("正在加载 original.example 的预览…")).toBe(loading)
        await act(async () => request.resolve({ title: "Third-party English Title", description: "", siteName: "External Site" }))
        const preview = view.container.querySelector(".link-preview")
        expect(screen.getByText("无可用描述")).toBeInTheDocument()
        expect(screen.getByText("Third-party English Title")).toBeInTheDocument()
        view.rerender(tree("en"))
        expect(view.container.querySelector(".link-preview")).toBe(preview)
        expect(screen.getByText("No description available")).toBeInTheDocument()
        expect(screen.getByText("Third-party English Title")).toBeInTheDocument()
        expect(screen.getByText("External Site")).toBeInTheDocument()
        view.rerender(tree("zh-CN"))
        expect(screen.getByText("无可用描述")).toBeInTheDocument()
        expect(mocks.fetchOpenGraph).toHaveBeenCalledTimes(1)
        expect(mocks.fetchOpenGraph).toHaveBeenCalledWith({ value: "https://Original.example/Case" })
    })

    it("retains raw failed-link diagnostics and original browser target while translating the error both ways", async () => {
        mocks.fetchOpenGraph.mockRejectedValue(new Error("ECONNRESET Original Error 诊断"))
        mocks.openInBrowser.mockResolvedValue({})
        const tree = (language: "en" | "zh-CN") => (
            <UiLanguageProvider language={language}>
                <LinkPreview url="https://Original.example/Case" />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        await screen.findByText("Unable to load preview")
        view.rerender(tree("zh-CN"))
        expect(screen.getByText("无法加载预览")).toBeInTheDocument()
        expect(screen.getByText("ECONNRESET Original Error 诊断")).toBeInTheDocument()
        fireEvent.click(screen.getByText("点击在浏览器中打开"))
        expect(mocks.openInBrowser).toHaveBeenCalledWith({ value: "https://Original.example/Case" })
        view.rerender(tree("en"))
        expect(screen.getByText("Unable to load preview")).toBeInTheDocument()
        expect(screen.getByText("ECONNRESET Original Error 诊断")).toBeInTheDocument()
        expect(mocks.fetchOpenGraph).toHaveBeenCalledTimes(1)
    })

    it("updates image loading and accessible descriptions without resetting a loaded instance or its URL", async () => {
        mocks.checkImage.mockResolvedValue({ isImage: true })
        const url = "https://Original.example/Case.png"
        const tree = (language: "en" | "zh-CN") => (
            <UiLanguageProvider language={language}>
                <ImagePreview url={url} />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        const loading = screen.getByText("Loading image from original.example...")
        view.rerender(tree("zh-CN"))
        expect(screen.getByText("正在从 original.example 加载图片…")).toBe(loading)
        const hiddenImage = view.container.querySelector("img")
        expect(hiddenImage).not.toBeNull()
        if (!hiddenImage) throw new Error("Expected the original image loader")
        fireEvent.load(hiddenImage)
        const image = screen.getByAltText("来自 original.example 的图片")
        expect(image).toHaveAttribute("src", url)
        view.rerender(tree("en"))
        expect(screen.getByAltText("Image from original.example")).toBe(image)
        expect(image).toHaveAttribute("src", url)
        view.rerender(tree("zh-CN"))
        expect(screen.getByAltText("来自 original.example 的图片")).toBe(image)
        await waitFor(() => expect(mocks.checkImage).toHaveBeenCalledTimes(1))
    })
})

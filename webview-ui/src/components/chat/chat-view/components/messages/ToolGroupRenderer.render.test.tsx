import type { UiMessage, UiSayTool } from "@shared/ExtensionMessage"
import type { UiLanguage } from "@shared/UiLanguage"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import { FileServiceClient } from "@/services/grpc-client"
import { ToolGroupRenderer } from "./ToolGroupRenderer"

let rowWidth = 1000
let resize: () => void
const disconnect = vi.fn()

beforeEach(() => {
    rowWidth = 1000
    vi.stubGlobal(
        "ResizeObserver",
        class implements ResizeObserver {
            constructor(private readonly callback: ResizeObserverCallback) {}
            observe(target: Element) {
                // Tooltip creates its own observers; only drive the row's measured-layout observer.
                if (target.getAttribute("data-tool-part") === "measure") resize = () => this.callback([], this)
            }
            unobserve() {}
            disconnect = disconnect
        },
    )
    // jsdom has no geometry. This controls decisions only; Playwright checks real pixels.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        const width = this.tagName === "BUTTON" ? rowWidth : (this.textContent?.length ?? 0) * 7
        return { width, height: 16, top: 0, left: 0, right: width, bottom: 16, x: 0, y: 0, toJSON: () => ({}) }
    })
})

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
})

async function setRowWidth(width: number) {
    rowWidth = width
    await act(async () => {
        resize()
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
}

vi.mock("@/services/grpc-client", () => ({
    FileServiceClient: { openFileRelativePath: vi.fn().mockResolvedValue({}) },
}))

/** A completed tool message carrying the given say payload. */
function toolMessage(ts: number, payload: UiSayTool): UiMessage {
    return { ts, type: "say", say: "tool", text: JSON.stringify(payload) }
}

/** Render one completed tool entry outside any active request. */
function renderTool(payload: UiSayTool) {
    const message = toolMessage(1, payload)
    return render(<ToolGroupRenderer allMessages={[message]} isLastGroup={false} messages={[message]} />)
}

describe("ToolGroupRenderer rows", () => {
    it("still labels a reference lookup when the symbol could not be resolved", () => {
        renderTool({ tool: "findReferences", path: "src/a.ts", count: 2, files: 1 })

        expect(screen.getByRole("button", { name: "references in src/a.ts (2 refs · 1 file)" })).toBeInTheDocument()
    })

    it("resizes reversibly with independent suffixes, full tooltip text and the original open target", async () => {
        const path = "src/core/task/tools/handlers/ReadFileToolHandler.ts"
        renderTool({ tool: "readFile", path, readLineStart: 125, readLineEnd: 416 })
        const row = screen.getByRole("button", { name: `${path} · lines 125-416` })
        await setRowWidth(350)
        expect(row.querySelector('[data-tool-part="path"]')?.textContent).toMatch(/^…\//)
        await setRowWidth(100)
        expect(row.querySelector('[data-tool-part="path"]')).toBeNull()
        expect(row.querySelector('[data-tool-part="prefix"]')).toBeNull()
        expect(row.querySelector("svg")).toBeNull()
        expect(within(row).getByText("lines 125-416")).toBeInTheDocument()

        fireEvent.focus(row)
        fireEvent.click(row)
        expect(FileServiceClient.openFileRelativePath).toHaveBeenCalledWith(expect.objectContaining({ value: `${path}:125` }))
        await setRowWidth(1000)
        expect(row.querySelector("svg")).not.toBeNull()
    })

    it("keeps active metadata visible immediately and does not activate the running tool", async () => {
        rowWidth = 100
        const request: UiMessage = { ts: 1, type: "say", say: "api_req_started", text: "{}" }
        const tool: UiMessage = {
            ts: 2,
            type: "ask",
            ask: "tool",
            text: JSON.stringify({ tool: "readFile", path: "src/a.ts", readLineStart: 125, readLineEnd: 416 }),
        }
        const { unmount } = render(<ToolGroupRenderer allMessages={[request, tool]} isLastGroup messages={[tool]} />)
        const row = screen.getByRole("button")
        expect(row).toHaveAttribute("aria-busy", "true")
        fireEvent.click(row)
        expect(FileServiceClient.openFileRelativePath).not.toHaveBeenCalled()
        fireEvent.focus(row)
        await setRowWidth(1000)
        unmount()
        expect(disconnect).toHaveBeenCalled()
    })

    it("keeps a completed read while another read of the same path is active", () => {
        const finishedRequest: UiMessage = { ts: 1, type: "say", say: "api_req_started", text: JSON.stringify({ cost: 0.01 }) }
        const request: UiMessage = { ts: 2, type: "say", say: "api_req_started", text: "{}" }
        const completed = toolMessage(3, { tool: "readFile", path: "src/a.ts" })
        const active: UiMessage = {
            ts: 4,
            type: "ask",
            ask: "tool",
            partial: true,
            text: JSON.stringify({ tool: "readFile", path: "src/a.ts" }),
        }
        render(
            <ToolGroupRenderer
                allMessages={[finishedRequest, request, completed, active]}
                isLastGroup
                messages={[completed, active]}
            />,
        )

        const rows = screen.getAllByRole("button")
        expect(rows).toHaveLength(2)
        expect(rows.filter((row) => row.getAttribute("aria-busy") === "true")).toHaveLength(1)
    })

    it("does not draw an active row for a call the group does not hold", () => {
        const request: UiMessage = { ts: 1, type: "say", say: "api_req_started", text: "{}" }
        const member = toolMessage(2, { tool: "readFile", path: "src/b.ts" })
        // Drawn on its own as the approval card, outside this group.
        const approval: UiMessage = {
            ts: 3,
            type: "ask",
            ask: "tool",
            text: JSON.stringify({ tool: "readFile", path: "src/c.ts" }),
        }
        render(<ToolGroupRenderer allMessages={[request, member, approval]} isLastGroup messages={[member]} />)

        const rows = screen.getAllByRole("button")
        expect(rows).toHaveLength(1)
        expect(rows[0]).not.toHaveAttribute("aria-busy")
    })

    it("retranslates the memoized active row while preserving expanded raw results and file-open identity", () => {
        const completed = toolMessage(1, {
            tool: "searchFiles",
            path: "src/raw",
            regex: "needle",
            count: 2,
            files: 1,
            content: "RAW tool result Receiving 原文",
        })
        const request: UiMessage = { ts: 2, type: "say", say: "api_req_started", text: "{}" }
        const active: UiMessage = {
            ts: 3,
            type: "ask",
            ask: "tool",
            partial: true,
            text: JSON.stringify({ tool: "readFile", path: "src/Receiving.ts", readLineStart: 5, readLineEnd: 9 }),
        }
        const messages = [completed, active]
        const allMessages = [completed, request, active]
        const original = JSON.stringify(allMessages)
        const tree = (language: UiLanguage) => (
            <UiLanguageProvider language={language}>
                <ToolGroupRenderer allMessages={allMessages} isLastGroup messages={messages} />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        const search = screen.getByRole("button", { name: '"needle" in src/raw/ (2 matches · 1 file)' })
        const reading = screen.getByRole("button", { name: "Reading src/Receiving.ts (lines 5-9)" })
        fireEvent.click(search)
        const rawResult = screen.getByText("RAW tool result Receiving 原文")

        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("button", { name: '"needle" 位于 src/raw/（2 处匹配 · 1 个文件）' })).toBe(search)
        expect(screen.getByRole("button", { name: "正在读取 src/Receiving.ts（第 5-9 行）" })).toBe(reading)
        expect(reading).toHaveAttribute("aria-busy", "true")
        expect(reading).toHaveAttribute("aria-disabled", "true")
        expect(search).toHaveAttribute("aria-expanded", "true")
        expect(screen.getByText("RAW tool result Receiving 原文")).toBe(rawResult)
        fireEvent.click(reading)
        expect(FileServiceClient.openFileRelativePath).not.toHaveBeenCalled()

        view.rerender(tree("en"))
        expect(reading).toHaveAccessibleName("Reading src/Receiving.ts (lines 5-9)")
        expect(search).toHaveAttribute("aria-expanded", "true")
        expect(screen.getByText("RAW tool result Receiving 原文")).toBe(rawResult)
        expect(JSON.stringify(allMessages)).toBe(original)
        fireEvent.click(search)
        expect(search).toHaveAttribute("aria-expanded", "false")
        expect(FileServiceClient.openFileRelativePath).not.toHaveBeenCalled()
    })

    it("still expands search results rather than opening the abbreviated directory", () => {
        renderTool({
            tool: "searchFiles",
            path: "src/core/tools",
            regex: "needle",
            count: 1,
            files: 1,
            content: "search result content",
        })
        const row = screen.getByRole("button")
        fireEvent.click(row)
        expect(row).toHaveAttribute("aria-expanded", "true")
        expect(screen.getByText("search result content")).toBeVisible()
        fireEvent.click(row)
        expect(row).toHaveAttribute("aria-expanded", "false")
        expect(screen.queryByText("search result content")).toBeNull()
        expect(FileServiceClient.openFileRelativePath).not.toHaveBeenCalled()
    })
})

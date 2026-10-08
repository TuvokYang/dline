import type { UiMessage, UiSayTool } from "@shared/ExtensionMessage"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
	it("labels a reference lookup with its symbol, file and scale", () => {
		renderTool({
			tool: "findReferences",
			path: "src/core/task/ToolExecutor.ts",
			symbolName: "ToolExecutor",
			count: 12,
			files: 3,
		})

		const row = screen.getByRole("button", { name: '"ToolExecutor" in src/core/task/ToolExecutor.ts (12 refs · 3 files)' })
		expect(row.querySelector('[data-tool-part="path"]')).toHaveTextContent("src/core/task/ToolExecutor.ts")
		expect(row.querySelector('[data-tool-part="suffix"]')).toHaveTextContent("(12 refs · 3 files)")
	})

	it("still labels a reference lookup when the symbol could not be resolved", () => {
		renderTool({ tool: "findReferences", path: "src/a.ts", count: 2, files: 1 })

		expect(screen.getByRole("button", { name: "references in src/a.ts (2 refs · 1 file)" })).toBeInTheDocument()
	})

	it("keeps the search terms and shows the match scale", () => {
		renderTool({
			tool: "searchFiles",
			path: "src/core/prompts",
			regex: "describe|it|expect|vi|beforeEach",
			filePattern: "*.test.ts",
			count: 300,
			files: 42,
			truncated: true,
		})

		const row = screen.getByRole("button")
		expect(row.querySelector('[data-tool-part="prefix"]')).toHaveTextContent('"describe | it | expect +2" in')
		expect(row.querySelector('[data-tool-part="suffix"]')).toHaveTextContent("(*.test.ts) (300+ matches · 42 files)")
	})

	it("resizes reversibly with independent suffixes, full tooltip text and the original open target", async () => {
		const path = "src/core/task/tools/handlers/ReadFileToolHandler.ts"
		renderTool({ tool: "readFile", path, readLineStart: 125, readLineEnd: 416 })
		const row = screen.getByRole("button", { name: `${path} · lines 125-416` })
		expect(row.querySelector('[data-tool-part="path"]')).toHaveTextContent(path)
		await setRowWidth(350)
		expect(row.querySelector('[data-tool-part="path"]')?.textContent).toMatch(/^…\//)
		expect(row.querySelector('[data-tool-part="suffix"]')).toHaveTextContent("lines 125-416")
		await setRowWidth(100)
		expect(row.querySelector('[data-tool-part="path"]')).toBeNull()
		expect(row.querySelector('[data-tool-part="prefix"]')).toBeNull()
		expect(row.querySelector("svg")).toBeNull()
		expect(within(row).getByText("lines 125-416")).toBeInTheDocument()

		fireEvent.focus(row)
		expect(await screen.findByRole("tooltip")).toHaveTextContent(`${path} · lines 125-416`)
		fireEvent.click(row)
		expect(FileServiceClient.openFileRelativePath).toHaveBeenCalledWith(expect.objectContaining({ value: `${path}:125` }))
		await setRowWidth(1000)
		expect(row.querySelector('[data-tool-part="path"]')).toHaveTextContent(path)
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
		expect(row.querySelector('[data-tool-part="suffix"]')).toHaveTextContent("lines 125-416")
		fireEvent.click(row)
		expect(FileServiceClient.openFileRelativePath).not.toHaveBeenCalled()
		fireEvent.focus(row)
		expect(await screen.findByRole("tooltip")).toHaveTextContent("Reading src/a.ts (lines 125-416)")
		await setRowWidth(1000)
		expect(row.querySelector('[data-tool-part="path"]')).toHaveTextContent("src/a.ts")
		unmount()
		expect(disconnect).toHaveBeenCalled()
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

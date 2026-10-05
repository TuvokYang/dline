import { describe, expect, it, vi } from "vitest"
import { ClineDefaultTool } from "@/shared/tools"
import { StatusUpdateHandler } from "../StatusUpdateHandler"

const IMAGE_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const PDF_DATA = "JVBERi0xLjQKJSVFT0YK"
const pdfDocument = {
	type: "attached_document",
	path: "/work/ack.pdf",
	media_type: "application/pdf",
	data: PDF_DATA,
	byte_length: 16,
	page_count: 1,
	fallback_text: "Hello PDF",
}

// The extractor is the file-system boundary; the handler only depends on its split result.
vi.mock("@integrations/misc/extract-text", () => ({
	processFilesForToolResult: async (files?: string[]) =>
		files?.length
			? {
					text: "Files attached by the user:\n\n(The attached PDFs follow this tool result as documents.)",
					documents: [pdfDocument],
				}
			: { text: "", documents: [] },
}))

function textOf(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content.map((block) => (block?.type === "text" ? block.text : "")).join("\n")
}

/**
 * Create a minimal task config for status update handler tests.
 * @param askResult Result returned by the mocked ask callback.
 * @returns TaskConfig-compatible test double.
 */
function createConfig(askResult: {
	response: "yesButtonClicked" | "noButtonClicked"
	text?: string
	images?: string[]
	files?: string[]
}) {
	const open = vi.fn(async () => ({
		actionId: askResult.response === "noButtonClicked" ? ("stop" as const) : ("acknowledge" as const),
		draft: {
			text: askResult.text ?? "",
			images: askResult.images ?? [],
			files: askResult.files ?? [],
		},
	}))
	return {
		taskState: {
			consecutiveMistakeCount: 0,
			lastToolName: "read_file",
			userMessageContent: [] as unknown[],
		},
		interactions: {
			open,
			complete: open,
			say: vi.fn(async () => undefined),
		},
		callbacks: {
			ask: vi.fn(async () => askResult),
			say: vi.fn(async () => undefined),
			sayAndCreateMissingParamError: vi.fn(async () => "missing response"),
		},
	} as any
}

describe("StatusUpdateHandler", () => {
	const handler = new StatusUpdateHandler()

	it("uses noButtonClicked as stop response for acknowledged status update", async () => {
		const config = createConfig({ response: "noButtonClicked", text: "先停止，我要调整方向" })

		const result = await handler.execute(config, {
			name: ClineDefaultTool.STATUS_UPDATE,
			dline_tid: "tid-status-stop",
			params: { response: "请确认", requires_acknowledgment: "true" },
		} as any)

		expect(result).toContain("User chose to stop")
		expect(result).toContain("<feedback>\n先停止，我要调整方向\n</feedback>")
	})

	it("includes acknowledge input in tool result with attachments as native blocks", async () => {
		const config = createConfig({
			response: "yesButtonClicked",
			text: "我知道了，下一步先检查配置",
			images: [`data:image/png;base64,${IMAGE_DATA}`],
			files: ["/work/ack.pdf"],
		})

		const result = await handler.execute(config, {
			name: ClineDefaultTool.STATUS_UPDATE,
			dline_tid: "tid-status-acknowledge",
			params: { response: "请确认", requires_acknowledgment: "true" },
		} as any)

		const text = textOf(result)
		expect(text).toContain("User acknowledged")
		expect(text).toContain("<feedback>\n我知道了，下一步先检查配置\n</feedback>")
		expect(text).toContain("follow this tool result as documents")
		expect(text).not.toContain("data:image")
		expect(text).not.toContain(IMAGE_DATA)
		expect(text).not.toContain(PDF_DATA)
		expect(result).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "image",
					source: expect.objectContaining({ type: "base64", media_type: "image/png", data: IMAGE_DATA }),
				}),
			]),
		)
		expect(config.taskState.userMessageContent).toEqual([pdfDocument])
	})
})

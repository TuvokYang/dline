import { describe, expect, it, vi } from "vitest"
import { DlineDefaultTool } from "@/shared/tools"
import { normalizeToolExecutionResult } from "../../ToolExecutionResult"
import { PhaseReportHandler } from "../PhaseReportHandler"

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
 * Create a minimal task config for phase report handler tests.
 * @param askResult Result returned by the mocked ask callback.
 * @param lastToolName The previous tool the task recorded.
 * @returns TaskConfig-compatible test double.
 */
function createConfig(
    askResult: {
        response: "yesButtonClicked" | "noButtonClicked"
        text?: string
        images?: string[]
        files?: string[]
    },
    lastToolName = "read_file",
) {
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
            lastToolName,
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

describe("PhaseReportHandler", () => {
    const handler = new PhaseReportHandler()

    it("streams a non-blocking report with the same tool row shape as its final presentation", async () => {
        const say = vi.fn(async () => undefined)

        await handler.handlePartialBlock(
            {
                name: DlineDefaultTool.PHASE_REPORT,
                ts: 101,
                params: { response: "Still working", requires_acknowledgment: "false" },
            } as any,
            { removeClosingTag: () => "Still working", say } as any,
        )

        expect(say).toHaveBeenCalledWith(
            "tool",
            JSON.stringify({ tool: "statusUpdate", content: "Still working" }),
            undefined,
            undefined,
            true,
            101,
        )
    })

    it("keeps an acknowledged report as text until the interaction owns its final row", async () => {
        const say = vi.fn(async () => undefined)

        await handler.handlePartialBlock(
            {
                name: DlineDefaultTool.PHASE_REPORT,
                ts: 102,
                params: { response: "Please confirm", requires_acknowledgment: "true" },
            } as any,
            { removeClosingTag: () => "Please confirm", say } as any,
        )

        expect(say).toHaveBeenCalledWith("text", "Please confirm", undefined, undefined, true, 102)
    })

    it("uses noButtonClicked as stop response for an acknowledged report", async () => {
        const config = createConfig({ response: "noButtonClicked", text: "先停止，我要调整方向" })

        const result = await handler.execute(config, {
            name: DlineDefaultTool.PHASE_REPORT,
            dline_tid: "tid-status-stop",
            params: { response: "请确认", requires_acknowledgment: "true" },
        } as any)

        expect(result).toContain("[PHASE_REPORT] User chose to stop")
        expect(result).toContain("<feedback>\n先停止，我要调整方向\n</feedback>")
    })

    it("includes acknowledge input in tool result with attachments as native blocks", async () => {
        const config = createConfig({
            response: "yesButtonClicked",
            text: "我知道了，下一步先检查配置",
            images: [`data:image/png;base64,${IMAGE_DATA}`],
            files: ["/work/ack.pdf"],
        })

        const { response: result, documents } = normalizeToolExecutionResult(
            await handler.execute(config, {
                name: DlineDefaultTool.PHASE_REPORT,
                dline_tid: "tid-status-acknowledge",
                params: { response: "请确认", requires_acknowledgment: "true" },
            } as any),
        )

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
        // The PDF returns with the result, so the journal records it beside the result;
        // nothing is left in a buffer the runtime never drains.
        expect(documents).toEqual([pdfDocument])
        expect(config.taskState.userMessageContent).toEqual([])
    })

    it.each([
        DlineDefaultTool.PHASE_REPORT,
        DlineDefaultTool.LEGACY_STATUS_UPDATE,
    ])("blocks a report that directly follows %s", async (previous) => {
        const config = createConfig({ response: "yesButtonClicked" }, previous)

        const result = await handler.execute(config, {
            name: DlineDefaultTool.PHASE_REPORT,
            params: { response: "Again", requires_acknowledgment: "false" },
        } as any)

        expect(String(result)).toContain("[BLOCKED]")
        expect(config.interactions.say).not.toHaveBeenCalled()
    })
})

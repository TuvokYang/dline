import type { ToolUse } from "@core/assistant-message"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DlineDefaultTool } from "@/shared/tools"
import type { TaskConfig } from "../../types/TaskConfig"
import { ReportBugHandler } from "../ReportBugHandler"

const reporting = vi.hoisted(() => ({
    collect: vi.fn(async () => ({
        providerAndModel: "openai / model-1",
        operatingSystem: "test-os",
        systemInfo: "test-system",
        dlineVersion: "test-version",
    })),
    open: vi.fn(async () => undefined),
}))

const responses = vi.hoisted(() => ({
    reportBugOpened: vi.fn((hasAttachments: boolean) => (hasAttachments ? "opened-with-attachment-notice" : "opened")),
}))

vi.mock("@core/api", () => ({ resolveProvider: vi.fn(() => "openai") }))
vi.mock("@core/reporting/ReportBugIssue", async () => {
    const actual = await vi.importActual<typeof import("@core/reporting/ReportBugIssue")>("@core/reporting/ReportBugIssue")
    return {
        ...actual,
        collectReportBugEnvironment: reporting.collect,
        openReportBugIssue: reporting.open,
    }
})
vi.mock("@core/prompts/responses", () => ({ formatResponse: responses }))

function block(): ToolUse {
    return {
        type: "tool_use",
        name: DlineDefaultTool.REPORT_BUG,
        ts: 100,
        params: {
            title: "Generated title",
            what_happened: "Generated description",
            steps_to_reproduce: "Generated steps",
            api_request_output: "Generated request output",
            additional_context: "AI context",
        },
    } as ToolUse
}

function config(draft: { text: string; images?: string[]; files?: string[] }): TaskConfig {
    return {
        mode: "act",
        taskState: { consecutiveMistakeCount: 0 },
        api: { getModel: () => ({ id: "model-1" }) },
        services: { stateManager: { getApiConfiguration: () => ({}) } },
        callbacks: {
            say: vi.fn(async () => undefined),
            sayAndCreateMissingParamError: vi.fn(async () => "missing"),
        },
        admissionOutcome: {
            source: "manual",
            actionId: "confirm_utility",
            draft: { text: draft.text, images: draft.images ?? [], files: draft.files ?? [] },
        },
    } as unknown as TaskConfig
}

describe("ReportBugHandler", () => {
    beforeEach(() => vi.clearAllMocks())

    it("appends the user's confirmation text to the AI-authored report before opening the issue form", async () => {
        const taskConfig = config({ text: "User-observed timing details" })

        const result = await new ReportBugHandler().execute(taskConfig, block())

        expect(reporting.open).toHaveBeenCalledWith(
            expect.objectContaining({
                title: "Generated title",
                additionalContext: "AI context\n\nUser supplement:\nUser-observed timing details",
            }),
            expect.objectContaining({ providerAndModel: "openai / model-1" }),
        )
        expect(responses.reportBugOpened).toHaveBeenCalledWith(false)
        expect(result).toBe("opened")
    })

    it("opens the form without uploading confirmation attachments and tells the user to add them there", async () => {
        const taskConfig = config({ text: "More context", images: ["image-data"], files: ["trace.log"] })

        const result = await new ReportBugHandler().execute(taskConfig, block())

        expect(reporting.open).toHaveBeenCalledOnce()
        expect(reporting.open).toHaveBeenCalledWith(
            expect.objectContaining({ additionalContext: "AI context\n\nUser supplement:\nMore context" }),
            expect.any(Object),
        )
        expect(responses.reportBugOpened).toHaveBeenCalledWith(true)
        expect(result).toBe("opened-with-attachment-notice")
    })
})

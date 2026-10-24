import type { ToolUse } from "@core/assistant-message"
import { createReportBugDraft, reportBugDraftSelection } from "@shared/report-bug"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DlineDefaultTool } from "@/shared/tools"
import type { TaskConfig } from "../../types/TaskConfig"
import { ReportBugHandler } from "../ReportBugHandler"

const environment = {
    providerAndModel: "openai / model-1",
    operatingSystem: "test-os",
    systemInfo: "test-system",
    dlineVersion: "test-version",
}

const reporting = vi.hoisted(() => ({ collect: vi.fn(async () => environment), open: vi.fn(async () => undefined) }))
const support = vi.hoisted(() => ({ create: vi.fn(async () => undefined) }))
const responses = vi.hoisted(() => ({
    reportBugOpened: vi.fn(() => "opened"),
    reportBugCancelled: vi.fn(() => "cancelled"),
    toolError: vi.fn((message: string) => `error:${message}`),
}))

vi.mock("@core/api", () => ({ resolveProvider: vi.fn(() => "openai") }))
vi.mock("@core/reporting/ReportBugIssue", async () => {
    const actual = await vi.importActual<typeof import("@core/reporting/ReportBugIssue")>("@core/reporting/ReportBugIssue")
    return { ...actual, collectReportBugEnvironment: reporting.collect, openReportBugIssue: reporting.open }
})
vi.mock("@/services/support/SupportTelemetryService", () => ({
    getSupportTelemetryService: () => ({ createAuthorizationAndOpenIssue: support.create }),
}))
vi.mock("@core/prompts/responses", () => ({ formatResponse: responses }))

function block(): ToolUse {
    return {
        type: "tool_use",
        name: DlineDefaultTool.REPORT_BUG,
        ts: 100,
        dline_tid: "report-1",
        params: {
            title: "Generated title",
            what_happened: "Generated description",
            steps_to_reproduce: "Generated steps",
            api_request_output: "Generated request output",
            additional_context: "AI context",
        },
    } as ToolUse
}

function config(actionId: "approve" | "reject", consent = false): TaskConfig {
    const draft = createReportBugDraft(
        {
            title: "Edited title",
            whatHappened: "Edited description",
            stepsToReproduce: "Edited steps",
            apiRequestOutput: "Edited output",
            additionalContext: "Edited context",
        },
        environment,
        consent,
    )
    return {
        mode: "act",
        taskState: { consecutiveMistakeCount: 0 },
        api: { getModel: () => ({ id: "model-1" }) },
        services: { stateManager: { getApiConfiguration: () => ({}) } },
        interactions: {
            open: vi.fn(async () => ({
                actionId,
                ...(actionId === "approve" ? { selection: { values: reportBugDraftSelection(draft) } } : {}),
            })),
        },
        callbacks: { sayAndCreateMissingParamError: vi.fn(async () => "missing") },
    } as unknown as TaskConfig
}

describe("ReportBugHandler", () => {
    beforeEach(() => vi.clearAllMocks())

    it("uses the edited canonical preview for an ordinary issue", async () => {
        const taskConfig = config("approve")
        const result = await new ReportBugHandler().execute(taskConfig, block())

        expect(taskConfig.interactions.open).toHaveBeenCalledWith({
            turnId: "turn:report-1",
            interactionId: "report-1",
            kind: "report_bug",
            presentation: expect.any(String),
            existingTs: 100,
        })
        expect(reporting.open).toHaveBeenCalledWith(
            expect.objectContaining({ title: "Edited title", additionalContext: "Edited context" }),
            environment,
        )
        expect(support.create).not.toHaveBeenCalled()
        expect(result).toBe("opened")
    })

    it("cancels without external side effects", async () => {
        const result = await new ReportBugHandler().execute(config("reject"), block())

        expect(reporting.open).not.toHaveBeenCalled()
        expect(support.create).not.toHaveBeenCalled()
        expect(result).toBe("cancelled")
    })

    it("routes consent only through the support service", async () => {
        const result = await new ReportBugHandler().execute(config("approve", true), block())

        expect(support.create).toHaveBeenCalledWith(expect.objectContaining({ temporaryTelemetryConsent: true }))
        expect(reporting.open).not.toHaveBeenCalled()
        expect(result).toBe("opened")
    })
})

import { StringRequest } from "@shared/proto/dline/common"
import { createReportBugDraft, parseReportBugDraft, reportBugDraftSelection } from "@shared/report-bug"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { reportBug } from "./reportBug"

const environment = {
    providerAndModel: "unavailable / unavailable",
    operatingSystem: "test",
    systemInfo: "test",
    dlineVersion: "test",
}
const reporting = vi.hoisted(() => ({
    collect: vi.fn(async () => environment),
    open: vi.fn(async () => undefined),
    recent: vi.fn((error: string | undefined) => error && `safe:${error}`),
}))
const support = vi.hoisted(() => ({ create: vi.fn(async () => undefined) }))

vi.mock("@core/reporting/ReportBugIssue", async () => {
    const actual = await vi.importActual<typeof import("@core/reporting/ReportBugIssue")>("@core/reporting/ReportBugIssue")
    return {
        ...actual,
        collectReportBugEnvironment: reporting.collect,
        openReportBugIssue: reporting.open,
        recentReportBugError: reporting.recent,
    }
})
vi.mock("@/services/support/SupportTelemetryService", () => ({
    getSupportTelemetryService: () => ({ createAuthorizationAndOpenIssue: support.create }),
}))

function controller(error: string, consent = false) {
    const draft = createReportBugDraft(
        {
            title: "Edited local title",
            whatHappened: "Edited local details",
            stepsToReproduce: "Edited steps",
            apiRequestOutput: `safe:${error}`,
            additionalContext: "Edited local context",
        },
        environment,
        consent,
    )
    const open = vi.fn(async (_request: { presentation: string }) => ({
        actionId: "approve",
        selection: { values: reportBugDraftSelection(draft) },
    }))
    return {
        open,
        value: {
            stateManager: { getGlobalSettingsKey: () => "act", getApiConfiguration: () => ({}) },
            task: {
                state: () => ({ flow: { error } }),
                owners: { interactions: { open } },
            },
        },
    }
}

describe("reportBug local fallback", () => {
    beforeEach(() => vi.clearAllMocks())

    it("opens the durable preview before an ordinary local issue", async () => {
        const test = controller("profile parse failed")

        await reportBug(test.value as never, StringRequest.create({ value: "cannot select profile" }))

        expect(reporting.recent).toHaveBeenCalledWith("profile parse failed")
        expect(test.open).toHaveBeenCalledWith(
            expect.objectContaining({ kind: "report_bug", placement: "interrupt", presentation: expect.any(String) }),
        )
        expect(reporting.open).toHaveBeenCalledWith(
            expect.objectContaining({ title: "Edited local title", whatHappened: "Edited local details" }),
            environment,
        )
        expect(support.create).not.toHaveBeenCalled()
    })

    it("routes local consent through support without opening the ordinary issue path", async () => {
        const test = controller("provider execution failed", true)

        await reportBug(test.value as never, StringRequest.create({ value: "provider failed" }))

        expect(support.create).toHaveBeenCalledWith(expect.objectContaining({ temporaryTelemetryConsent: true }))
        expect(reporting.open).not.toHaveBeenCalled()
    })

    it("creates an empty durable task owner before opening a no-profile preview", async () => {
        const draft = createReportBugDraft(
            {
                title: "Edited no-profile title",
                whatHappened: "No profile was available",
                stepsToReproduce: "Open Dline and submit /reportbug",
                apiRequestOutput: "No recent task error was available.",
                additionalContext: "Edited before confirmation",
            },
            environment,
            false,
        )
        const open = vi.fn(async () => ({ actionId: "approve", selection: { values: reportBugDraftSelection(draft) } }))
        const value = {
            stateManager: { getGlobalSettingsKey: () => "act", getApiConfiguration: () => ({}) },
            task: undefined as unknown,
            initTask: vi.fn(async function (this: { task: unknown }) {
                this.task = {
                    state: () => ({ flow: {} }),
                    owners: { interactions: { open } },
                }
                return "report-bug-task"
            }),
        }

        await reportBug(value as never, StringRequest.create({ value: "no profile" }))

        expect(value.initTask).toHaveBeenCalledWith()
        expect(open).toHaveBeenCalledWith(expect.objectContaining({ kind: "report_bug", placement: "interrupt" }))
        expect(reporting.open).toHaveBeenCalledWith(expect.objectContaining({ title: "Edited no-profile title" }), environment)
    })

    // The composer already removed the command node; text that merely looks like
    // a command spelling is the user's description and must reach the preview.
    it("previews the sent details without re-parsing a command spelling", async () => {
        const test = controller("failure")

        await reportBug(test.value as never, StringRequest.create({ value: "  /reportbug is what I typed first  " }))

        const presentation = test.open.mock.calls[0]?.[0].presentation
        expect(parseReportBugDraft(presentation)?.content.whatHappened).toBe("/reportbug is what I typed first")
    })

    it("asks for a description when no details were sent", async () => {
        const test = controller("failure")

        await reportBug(test.value as never, StringRequest.create({ value: "   " }))

        const presentation = test.open.mock.calls[0]?.[0].presentation
        expect(parseReportBugDraft(presentation)?.content.whatHappened).toBe("Please describe what happened.")
    })
})

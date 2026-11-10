import { StringRequest } from "@shared/proto/dline/common"
import { parseReportBugDraft } from "@shared/report-bug"
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
const support = vi.hoisted(() => ({
    issue: vi.fn(async () => "SUP-ABCD-1234"),
    open: vi.fn(async () => undefined),
    discard: vi.fn(async () => undefined),
}))

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
    getSupportTelemetryService: () => ({
        issueAuthorization: support.issue,
        openAuthorizedIssue: support.open,
        discardAuthorization: support.discard,
    }),
}))

function controller(error: string) {
    const admit = vi.fn(async (_request: { presentation: string }) => undefined)
    const open = vi.fn()
    return {
        admit,
        open,
        value: {
            stateManager: { getGlobalSettingsKey: () => "act", getApiConfiguration: () => ({}) },
            task: {
                state: () => ({ flow: { error } }),
                owners: { interactions: { admit, open } },
            },
        },
    }
}

describe("reportBug local fallback", () => {
    beforeEach(() => vi.clearAllMocks())

    it("admits the durable preview even when authorization fails, without waiting for an answer", async () => {
        support.issue.mockRejectedValueOnce(new Error("production_token_stopped"))
        const test = controller("profile parse failed")
        await reportBug(test.value as never, StringRequest.create({ value: "cannot select profile" }))
        expect(reporting.recent).toHaveBeenCalledWith("profile parse failed")
        expect(test.admit).toHaveBeenCalledWith(
            expect.objectContaining({ kind: "report_bug", placement: "interrupt", presentation: expect.any(String) }),
        )
        expect(parseReportBugDraft(test.admit.mock.calls[0][0].presentation)?.supportCode).toBeUndefined()
        expect(test.open).not.toHaveBeenCalled()
        expect(reporting.open).not.toHaveBeenCalled()
        expect(support.open).not.toHaveBeenCalled()
    })

    it("prepares local consent before admission but does not execute the outcome in the unary", async () => {
        const test = controller("provider execution failed")
        await reportBug(test.value as never, StringRequest.create({ value: "provider failed" }))
        expect(support.issue).toHaveBeenCalledOnce()
        expect(parseReportBugDraft(test.admit.mock.calls[0][0].presentation)).toMatchObject({
            supportCode: "SUP-ABCD-1234",
            temporaryTelemetryConsent: true,
        })
        expect(support.open).not.toHaveBeenCalled()
        expect(reporting.open).not.toHaveBeenCalled()
    })

    it("creates an empty durable task owner before admitting a no-profile preview", async () => {
        const admit = vi.fn(async () => undefined)
        const value = {
            stateManager: { getGlobalSettingsKey: () => "act", getApiConfiguration: () => ({}) },
            task: undefined as unknown,
            initTask: vi.fn(async function (this: { task: unknown }) {
                this.task = {
                    state: () => ({ flow: {} }),
                    owners: { interactions: { admit } },
                }
                return "report-bug-task"
            }),
        }

        await reportBug(value as never, StringRequest.create({ value: "no profile" }))

        expect(value.initTask).toHaveBeenCalledWith()
        expect(admit).toHaveBeenCalledWith(expect.objectContaining({ kind: "report_bug", placement: "interrupt" }))
        expect(reporting.open).not.toHaveBeenCalled()
    })

    // The composer already removed the command node; text that merely looks like
    // a command spelling is the user's description and must reach the preview.
    it("previews the sent details without re-parsing a command spelling", async () => {
        const test = controller("failure")

        await reportBug(test.value as never, StringRequest.create({ value: "  /reportbug is what I typed first  " }))

        const presentation = test.admit.mock.calls[0]?.[0].presentation
        expect(parseReportBugDraft(presentation)?.content.whatHappened).toBe("/reportbug is what I typed first")
    })

    it("asks for a description when no details were sent", async () => {
        const test = controller("failure")

        await reportBug(test.value as never, StringRequest.create({ value: "   " }))

        const presentation = test.admit.mock.calls[0]?.[0].presentation
        expect(parseReportBugDraft(presentation)?.content.whatHappened).toBe("Please describe what happened.")
    })
})

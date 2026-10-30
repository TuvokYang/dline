import { describe, expect, it } from "vitest"
import {
    appendReportBugSupplement,
    createReportBugDraft,
    parseReportBugDraft,
    type ReportBugContent,
    reportBugDraftFromSelection,
    reportBugDraftSelection,
    reportBugSupplement,
    serializeReportBugDraft,
} from "./report-bug"

const environment = {
    providerAndModel: "test / model",
    operatingSystem: "test-os",
    systemInfo: "test-system",
    dlineVersion: "1.2.3",
}

const prepared: ReportBugContent = {
    title: "Bug",
    whatHappened: "It failed",
    stepsToReproduce: "Run it",
    apiRequestOutput: "failure",
    additionalContext: "AI context\n",
}

describe("ReportBug authorization draft", () => {
    it("round-trips the issued public code with consent checked by default", () => {
        const draft = createReportBugDraft(prepared, environment, "  SUP-ABCD-1234  ")

        expect(parseReportBugDraft(serializeReportBugDraft(draft))).toEqual({
            schemaVersion: 1,
            content: prepared,
            environment,
            supportCode: "SUP-ABCD-1234",
            temporaryTelemetryConsent: true,
        })
    })

    it("preserves an explicit opt-out across an interaction selection", () => {
        const draft = {
            ...createReportBugDraft(prepared, environment, "SUP-ABCD-1234"),
            temporaryTelemetryConsent: false,
        }

        expect(reportBugDraftFromSelection(reportBugDraftSelection(draft))).toEqual(draft)
    })

    it.each([undefined, "", "   "])("never authorizes telemetry without a support code (%s)", (supportCode) => {
        const draft = createReportBugDraft(prepared, environment, supportCode)

        expect(draft.supportCode).toBeUndefined()
        expect(draft.temporaryTelemetryConsent).toBe(false)
        expect(parseReportBugDraft({ ...draft, supportCode, temporaryTelemetryConsent: true })).toEqual(draft)
    })

    it("reads a restored pre-authorization draft without re-enabling consent", () => {
        const draft = {
            schemaVersion: 1,
            content: prepared,
            environment,
            temporaryTelemetryConsent: true,
        }

        expect(parseReportBugDraft(draft)).toEqual({ ...draft, temporaryTelemetryConsent: false })
    })
})

describe("ReportBug supplement", () => {
    it("appends trimmed user text after the AI-authored context and leaves other fields alone", () => {
        expect(appendReportBugSupplement(prepared, "  user details \n")).toEqual({
            ...prepared,
            additionalContext: "AI context\n\nUser supplement:\nuser details",
        })
    })

    it("starts Additional context with the supplement when the AI left it empty", () => {
        expect(appendReportBugSupplement({ ...prepared, additionalContext: "  " }, "user details").additionalContext).toBe(
            "User supplement:\nuser details",
        )
    })

    it("returns the prepared content unchanged for blank text", () => {
        expect(appendReportBugSupplement(prepared, " \n ")).toBe(prepared)
    })

    it.each([
        ["after AI context", prepared],
        ["without AI context", { ...prepared, additionalContext: "" }],
    ])("reads back the supplement it appended %s", (_case, content) => {
        expect(reportBugSupplement(content, appendReportBugSupplement(content, "line one\nline two"))).toBe("line one\nline two")
    })

    it("reads no supplement from a draft that carries none", () => {
        expect(reportBugSupplement(prepared, prepared)).toBe("")
        expect(reportBugSupplement(prepared, { ...prepared, additionalContext: "Rewritten context" })).toBe("")
    })
})

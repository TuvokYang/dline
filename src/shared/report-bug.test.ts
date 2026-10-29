import { describe, expect, it } from "vitest"
import { appendReportBugSupplement, type ReportBugContent, reportBugSupplement } from "./report-bug"

const prepared: ReportBugContent = {
    title: "Bug",
    whatHappened: "It failed",
    stepsToReproduce: "Run it",
    apiRequestOutput: "failure",
    additionalContext: "AI context\n",
}

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

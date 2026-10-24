import { StringRequest } from "@shared/proto/dline/common"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { reportBug } from "./reportBug"

const reporting = vi.hoisted(() => ({
    collect: vi.fn(async () => ({
        providerAndModel: "unavailable / unavailable",
        operatingSystem: "test",
        systemInfo: "test",
        dlineVersion: "test",
    })),
    open: vi.fn(async () => undefined),
    recent: vi.fn((error: string | undefined) => error && `safe:${error}`),
}))

vi.mock("@core/reporting/ReportBugIssue", () => ({
    collectReportBugEnvironment: reporting.collect,
    openReportBugIssue: reporting.open,
    recentReportBugError: reporting.recent,
}))

describe("reportBug local fallback", () => {
    beforeEach(() => vi.clearAllMocks())

    it("opens an editable local issue draft with command details and a recent kernel error", async () => {
        const controller = {
            stateManager: {
                getGlobalSettingsKey: () => "act",
                getApiConfiguration: () => ({}),
            },
            task: { state: () => ({ flow: { error: "profile parse failed" } }) },
        }

        await reportBug(controller as never, StringRequest.create({ value: "/cmd:reportbug cannot select profile" }))

        expect(reporting.recent).toHaveBeenCalledWith("profile parse failed")
        expect(reporting.open).toHaveBeenCalledWith(
            expect.objectContaining({
                whatHappened: "cannot select profile",
                apiRequestOutput: "safe:profile parse failed",
                additionalContext:
                    "Opened by Dline's local report fallback because no usable Provider request was available. Images and files selected in Dline are not uploaded; add them manually in this GitHub form.",
            }),
            expect.any(Object),
        )
    })

    it("prefers the current provider failure presentation over the generic executor summary", async () => {
        const presentation = '{"message":"401 rejected key","status":401,"code":"invalid_api_key"}'
        const controller = {
            stateManager: {
                getGlobalSettingsKey: () => "act",
                getApiConfiguration: () => ({}),
            },
            task: {
                state: () => ({
                    flow: { error: "provider execution failed (Error)" },
                    dialog: { primary: { kind: "profile_failure", presentationRef: presentation } },
                }),
            },
        }

        await reportBug(controller as never, StringRequest.create({ value: "/cmd:reportbug credentials failed" }))

        expect(reporting.recent).toHaveBeenCalledWith(presentation)
        expect(reporting.open).toHaveBeenCalledWith(
            expect.objectContaining({ apiRequestOutput: `safe:${presentation}` }),
            expect.any(Object),
        )
    })
})

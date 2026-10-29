import { createReportBugDraft, reportBugDraftSelection } from "@shared/report-bug"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { executeReportBugOutcome, openReportBugPreview } from "./ReportBugWorkflow"

const effects = vi.hoisted(() => ({
    openIssue: vi.fn(async () => undefined),
    createSupport: vi.fn(async () => ({ publicCode: "SUP-ABCD-1234" })),
}))

vi.mock("./ReportBugIssue", async () => {
    const actual = await vi.importActual<typeof import("./ReportBugIssue")>("./ReportBugIssue")
    return { ...actual, openReportBugIssue: effects.openIssue }
})

vi.mock("@/services/support/SupportTelemetryService", () => ({
    getSupportTelemetryService: () => ({ createAuthorizationAndOpenIssue: effects.createSupport }),
}))

const content = {
    title: "Provider failed",
    whatHappened: "The request failed.",
    stepsToReproduce: "Send the request.",
    apiRequestOutput: "safe output",
    additionalContext: "context",
}
const environment = {
    providerAndModel: "test / model",
    operatingSystem: "test",
    systemInfo: "test",
    dlineVersion: "1.2.3",
}

function outcome(actionId: "approve" | "reject", consent: boolean) {
    return {
        actionId,
        selection: { values: reportBugDraftSelection(createReportBugDraft(content, environment, consent)) },
    }
}

describe("ReportBugWorkflow", () => {
    beforeEach(() => {
        effects.openIssue.mockClear()
        effects.createSupport.mockClear()
    })

    it("does nothing external until the durable preview resolves", async () => {
        let resolve!: (value: ReturnType<typeof outcome>) => void
        const open = vi.fn(
            () =>
                new Promise<ReturnType<typeof outcome>>((done) => {
                    resolve = done
                }),
        )

        const pending = openReportBugPreview({
            interactions: { open } as never,
            turnId: "turn-1",
            interactionId: "report-1",
            content,
            environment,
        })

        expect(open).toHaveBeenCalledWith(expect.objectContaining({ kind: "report_bug" }))
        expect(effects.openIssue).not.toHaveBeenCalled()
        expect(effects.createSupport).not.toHaveBeenCalled()
        resolve(outcome("reject", false))
        await expect(pending).resolves.toBe("cancelled")
        expect(effects.openIssue).not.toHaveBeenCalled()
        expect(effects.createSupport).not.toHaveBeenCalled()
    })

    it("opens only the ordinary Issue when confirmed without telemetry consent", async () => {
        await expect(executeReportBugOutcome(outcome("approve", false) as never)).resolves.toBe("opened")

        expect(effects.openIssue).toHaveBeenCalledWith(content, environment)
        expect(effects.createSupport).not.toHaveBeenCalled()
    })

    it("delegates a consented confirmation only to SupportTelemetryService", async () => {
        const draft = createReportBugDraft(content, environment, true)

        await expect(executeReportBugOutcome(outcome("approve", true) as never)).resolves.toBe("opened")

        expect(effects.createSupport).toHaveBeenCalledWith(draft)
        expect(effects.openIssue).not.toHaveBeenCalled()
    })

    it("rejects a confirmed outcome without a canonical draft", async () => {
        await expect(executeReportBugOutcome({ actionId: "approve" } as never)).resolves.toBe("invalid")
        expect(effects.openIssue).not.toHaveBeenCalled()
        expect(effects.createSupport).not.toHaveBeenCalled()
    })
})

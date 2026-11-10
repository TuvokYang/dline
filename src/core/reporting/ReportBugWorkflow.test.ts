import type { InteractionOutcome } from "@core/task/interaction/InteractionProtocol"
import { createReportBugDraft, parseReportBugDraft, reportBugDraftSelection, serializeReportBugDraft } from "@shared/report-bug"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { executeReportBugOutcome, openReportBugPreview } from "./ReportBugWorkflow"

const effects = vi.hoisted(() => ({
    openIssue: vi.fn(async () => undefined),
    issue: vi.fn(async () => "SUP-ABCD-1234"),
    openAuthorized: vi.fn(async () => undefined),
    discard: vi.fn(async (): Promise<void> => undefined),
    logError: vi.fn(),
}))

vi.mock("./ReportBugIssue", async () => {
    const actual = await vi.importActual<typeof import("./ReportBugIssue")>("./ReportBugIssue")
    return { ...actual, openReportBugIssue: effects.openIssue }
})

vi.mock("@/services/support/SupportTelemetryService", () => ({
    getSupportTelemetryService: () => ({
        issueAuthorization: effects.issue,
        openAuthorizedIssue: effects.openAuthorized,
        discardAuthorization: effects.discard,
    }),
}))

vi.mock("@shared/services/Logger", () => ({ Logger: { error: effects.logError, warn: vi.fn() } }))

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

function approve(draft = createReportBugDraft(content, environment)): InteractionOutcome {
    return { actionId: "approve", selection: { values: reportBugDraftSelection(draft) } }
}

/** Open a preview whose interaction resolves with `answer`, returning the presented draft. */
async function preview(answer: (presented: string) => InteractionOutcome) {
    let presented = ""
    const open = vi.fn(async (request: { presentation: string }) => {
        presented = request.presentation
        return answer(request.presentation)
    })
    const outcome = await openReportBugPreview({
        interactions: { open },
        turnId: "turn-1",
        interactionId: "report-1",
        content,
        environment,
    })
    return { outcome, draft: parseReportBugDraft(presented) }
}

describe("ReportBugWorkflow", () => {
    beforeEach(() => {
        for (const effect of Object.values(effects)) effect.mockClear()
        effects.issue.mockImplementation(async () => "SUP-ABCD-1234")
    })

    it("does not render or open a browser while authorization is pending", async () => {
        let issueTicket!: (code: string) => void
        effects.issue.mockReturnValueOnce(
            new Promise<string>((resolve) => {
                issueTicket = resolve
            }),
        )
        const open = vi.fn(async (request: { presentation: string }) => {
            const draft = parseReportBugDraft(request.presentation)
            expect(draft).toMatchObject({ supportCode: "SUP-ABCD-1234", temporaryTelemetryConsent: true })
            return { actionId: "reject" as const }
        })

        const pending = openReportBugPreview({
            interactions: { open },
            turnId: "turn-1",
            interactionId: "report-1",
            content,
            environment,
        })

        expect(effects.issue).toHaveBeenCalledOnce()
        expect(open).not.toHaveBeenCalled()
        expect(effects.openIssue).not.toHaveBeenCalled()
        expect(effects.openAuthorized).not.toHaveBeenCalled()
        issueTicket("SUP-ABCD-1234")
        await expect(pending).resolves.toBe("cancelled")
        expect(open).toHaveBeenCalledOnce()
    })

    it("issues the authorization before rendering and presents it checked", async () => {
        const { outcome, draft } = await preview((presented) => ({
            actionId: "approve",
            selection: { values: [`report_bug_draft:${presented}`] },
        }))

        expect(effects.issue).toHaveBeenCalledOnce()
        expect(draft).toMatchObject({ supportCode: "SUP-ABCD-1234", temporaryTelemetryConsent: true })
        expect(outcome).toBe("opened")
        expect(effects.openAuthorized).toHaveBeenCalledWith(draft)
        expect(effects.discard).not.toHaveBeenCalled()
    })

    it("renders no telemetry choice and logs an error when issuance fails", async () => {
        effects.issue.mockRejectedValueOnce(new Error("production_token_stopped"))

        const { outcome, draft } = await preview((presented) => ({
            actionId: "approve",
            selection: { values: [`report_bug_draft:${presented}`] },
        }))

        expect(draft?.supportCode).toBeUndefined()
        expect(draft?.temporaryTelemetryConsent).toBe(false)
        expect(effects.logError).toHaveBeenCalledWith(expect.any(String), expect.any(Error))
        expect(outcome).toBe("opened")
        expect(effects.openIssue).toHaveBeenCalledWith(content, environment)
        expect(effects.openAuthorized).not.toHaveBeenCalled()
    })

    it("discards the issued authorization when the preview is cancelled", async () => {
        const { outcome } = await preview(() => ({ actionId: "reject" }))

        expect(outcome).toBe("cancelled")
        expect(effects.discard).toHaveBeenCalledWith("SUP-ABCD-1234")
        expect(effects.openIssue).not.toHaveBeenCalled()
        expect(effects.openAuthorized).not.toHaveBeenCalled()
    })

    it("discards a restored preview's authorization when Cancel carries no selection", async () => {
        const presented = serializeReportBugDraft(createReportBugDraft(content, environment, "SUP-ABCD-1234"))

        await expect(executeReportBugOutcome({ actionId: "reject" }, presented)).resolves.toBe("cancelled")

        expect(effects.discard).toHaveBeenCalledWith("SUP-ABCD-1234")
        expect(effects.issue).not.toHaveBeenCalled()
        expect(effects.openIssue).not.toHaveBeenCalled()
        expect(effects.openAuthorized).not.toHaveBeenCalled()
    })

    it("discards an unchecked authorization and still opens the issue", async () => {
        const unchecked = { ...createReportBugDraft(content, environment, "SUP-ABCD-1234"), temporaryTelemetryConsent: false }

        await expect(executeReportBugOutcome(approve(unchecked))).resolves.toBe("opened")

        expect(effects.discard).toHaveBeenCalledWith("SUP-ABCD-1234")
        expect(effects.openAuthorized).toHaveBeenCalledWith(unchecked)
    })

    it("opens the ordinary issue for a draft without an authorization and never issues one on confirm", async () => {
        await expect(executeReportBugOutcome(approve())).resolves.toBe("opened")

        expect(effects.openIssue).toHaveBeenCalledWith(content, environment)
        expect(effects.issue).not.toHaveBeenCalled()
        expect(effects.openAuthorized).not.toHaveBeenCalled()
    })

    it("discards the pre-issued ticket if opening the preview fails", async () => {
        const error = new Error("interaction unavailable")
        const open = vi.fn(async () => {
            throw error
        })

        await expect(
            openReportBugPreview({
                interactions: { open },
                turnId: "turn-1",
                interactionId: "report-1",
                content,
                environment,
            }),
        ).rejects.toBe(error)

        expect(effects.discard).toHaveBeenCalledWith("SUP-ABCD-1234")
        expect(effects.openIssue).not.toHaveBeenCalled()
        expect(effects.openAuthorized).not.toHaveBeenCalled()
    })

    it("opens the issue despite local cleanup failure after an opt-out", async () => {
        effects.discard.mockRejectedValueOnce(new Error("local cleanup failed"))
        const unchecked = { ...createReportBugDraft(content, environment, "SUP-ABCD-1234"), temporaryTelemetryConsent: false }

        await expect(executeReportBugOutcome(approve(unchecked))).resolves.toBe("opened")

        expect(effects.openAuthorized).toHaveBeenCalledWith(unchecked)
        expect(effects.issue).not.toHaveBeenCalled()
    })

    it("keeps the tool-open contract blocked until its receiver actually answers", async () => {
        let answer!: (outcome: InteractionOutcome) => void
        const open = vi.fn(
            () =>
                new Promise<InteractionOutcome>((resolve) => {
                    answer = resolve
                }),
        )
        let finished = false
        const pending = openReportBugPreview({
            interactions: { open },
            turnId: "tool-turn",
            interactionId: "tool-block",
            content,
            environment,
        }).then((outcome) => {
            finished = true
            return outcome
        })
        await vi.waitFor(() => expect(open).toHaveBeenCalledOnce())
        expect(finished).toBe(false)
        expect(effects.openIssue).not.toHaveBeenCalled()
        answer({ actionId: "reject" })
        await expect(pending).resolves.toBe("cancelled")
    })

    it("does not start the authorized effect if the task is fenced while opt-out cleanup awaits", async () => {
        let release!: () => void
        let current = true
        effects.discard.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve
                }),
        )
        const unchecked = { ...createReportBugDraft(content, environment, "SUP-ABCD-1234"), temporaryTelemetryConsent: false }
        const pending = executeReportBugOutcome(approve(unchecked), undefined, () => current)
        expect(effects.discard).toHaveBeenCalledOnce()
        current = false
        release()
        await expect(pending).resolves.toBe("invalid")
        expect(effects.openAuthorized).not.toHaveBeenCalled()
        expect(effects.openIssue).not.toHaveBeenCalled()
    })

    it("rejects a confirmed outcome without a canonical draft", async () => {
        await expect(executeReportBugOutcome({ actionId: "approve" })).resolves.toBe("invalid")
        expect(effects.openIssue).not.toHaveBeenCalled()
        expect(effects.openAuthorized).not.toHaveBeenCalled()
    })
})

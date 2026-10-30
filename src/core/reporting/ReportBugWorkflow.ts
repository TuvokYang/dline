import type { InteractionOutcome } from "@core/task/interaction/InteractionProtocol"
import type { TaskInteractionPorts } from "@core/task/tools/types/TaskConfig"
import {
    createReportBugDraft,
    parseReportBugDraft,
    type ReportBugDraft,
    reportBugDraftFromSelection,
    serializeReportBugDraft,
} from "@shared/report-bug"
import { Logger } from "@shared/services/Logger"
import { getSupportTelemetryService } from "@/services/support/SupportTelemetryService"
import { openReportBugIssue, type ReportBugContent, type ReportBugEnvironment } from "./ReportBugIssue"

export type ReportBugWorkflowOutcome = "opened" | "cancelled" | "invalid"

export interface OpenReportBugPreviewInput {
    readonly interactions: Pick<TaskInteractionPorts, "open">
    readonly turnId: string
    readonly interactionId: string
    readonly content: ReportBugContent
    readonly environment: ReportBugEnvironment
    readonly existingTs?: number
    readonly placement?: "interrupt"
}

/**
 * The draft a preview renders, with its temporary telemetry authorization issued first.
 *
 * Issuance happens before rendering so the Issue Form button never waits on the
 * network. A failed issuance is diagnostics only: the draft carries no support
 * code, and the preview then offers no telemetry choice.
 */
export async function prepareReportBugDraft(
    content: ReportBugContent,
    environment: ReportBugEnvironment,
): Promise<ReportBugDraft> {
    const support = getSupportTelemetryService()
    if (!support) return createReportBugDraft(content, environment)
    try {
        return createReportBugDraft(content, environment, await support.issueAuthorization())
    } catch (error) {
        Logger.error("ReportBug telemetry authorization failed; the preview offers no telemetry choice", error)
        return createReportBugDraft(content, environment)
    }
}

/** Best-effort local delete of an authorization the user will not submit. */
async function discardAuthorization(supportCode: string | undefined): Promise<void> {
    const support = getSupportTelemetryService()
    if (!supportCode || !support) return
    try {
        await support.discardAuthorization(supportCode)
    } catch (error) {
        Logger.warn("Could not discard an unused ReportBug telemetry authorization", error)
    }
}

/** Execute live or restored answers without issuing a ticket. Cancellation reads the persisted preview, not user selection. */
export async function executeReportBugOutcome(
    outcome: InteractionOutcome,
    presentation?: string,
): Promise<ReportBugWorkflowOutcome> {
    if (outcome.actionId !== "approve") {
        await discardAuthorization(parseReportBugDraft(presentation)?.supportCode)
        return "cancelled"
    }
    const draft = reportBugDraftFromSelection(outcome.selection?.values)
    if (!draft) return "invalid"
    const support = getSupportTelemetryService()
    if (!draft.supportCode || !support) {
        await openReportBugIssue(draft.content, draft.environment)
        return "opened"
    }
    if (!draft.temporaryTelemetryConsent) await discardAuthorization(draft.supportCode)
    await support.openAuthorizedIssue(draft)
    return "opened"
}

/** Open the canonical editable preview; nothing opens in the browser before its Confirm action. */
export async function openReportBugPreview(input: OpenReportBugPreviewInput): Promise<ReportBugWorkflowOutcome> {
    const draft = await prepareReportBugDraft(input.content, input.environment)
    const presentation = serializeReportBugDraft(draft)
    let outcome: InteractionOutcome
    try {
        outcome = await input.interactions.open({
            turnId: input.turnId,
            interactionId: input.interactionId,
            kind: "report_bug",
            presentation,
            ...(input.existingTs === undefined ? {} : { existingTs: input.existingTs }),
            ...(input.placement === undefined ? {} : { placement: input.placement }),
        })
    } catch (error) {
        await discardAuthorization(draft.supportCode)
        throw error
    }
    return executeReportBugOutcome(outcome, presentation)
}

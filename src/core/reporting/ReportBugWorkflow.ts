import type { InteractionOutcome } from "@core/task/interaction/InteractionProtocol"
import type { TaskInteractionPorts } from "@core/task/tools/types/TaskConfig"
import { reportBugDraftFromSelection } from "@shared/report-bug"
import { getSupportTelemetryService } from "@/services/support/SupportTelemetryService"
import { openReportBugIssue, type ReportBugContent, type ReportBugEnvironment, reportBugPresentation } from "./ReportBugIssue"

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

/** Execute the one external-effect boundary shared by live and restored previews. */
export async function executeReportBugOutcome(outcome: InteractionOutcome): Promise<ReportBugWorkflowOutcome> {
    if (outcome.actionId !== "approve") return "cancelled"
    const draft = reportBugDraftFromSelection(outcome.selection?.values)
    if (!draft) return "invalid"
    if (draft.temporaryTelemetryConsent) {
        const support = getSupportTelemetryService()
        if (!support) throw new Error("Temporary support telemetry is unavailable")
        await support.createAuthorizationAndOpenIssue(draft)
    } else {
        await openReportBugIssue(draft.content, draft.environment)
    }
    return "opened"
}

/** Open the canonical editable preview; nothing external happens before its Confirm action. */
export async function openReportBugPreview(input: OpenReportBugPreviewInput): Promise<ReportBugWorkflowOutcome> {
    const outcome = await input.interactions.open({
        turnId: input.turnId,
        interactionId: input.interactionId,
        kind: "report_bug",
        presentation: reportBugPresentation(input.content, input.environment),
        ...(input.existingTs === undefined ? {} : { existingTs: input.existingTs }),
        ...(input.placement === undefined ? {} : { placement: input.placement }),
    })
    return executeReportBugOutcome(outcome)
}

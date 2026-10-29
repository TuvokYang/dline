import { randomUUID } from "node:crypto"
import { resolveProvider } from "@core/api"
import { collectReportBugEnvironment, type ReportBugContent, recentReportBugError } from "@core/reporting/ReportBugIssue"
import { openReportBugPreview } from "@core/reporting/ReportBugWorkflow"
import { Empty, StringRequest } from "@shared/proto/dline/common"
import { Controller } from ".."

/** Prefer the user-visible provider failure over the kernel's generic executor summary. */
function recentTaskError(controller: Controller): string | undefined {
    const state = controller.task?.state()
    const failure = state?.dialog?.primary
    if (failure?.kind === "profile_failure" || failure?.kind === "error_retry") {
        return failure.presentationRef
    }
    return state?.flow.error
}

/**
 * Open the same durable preview locally when no usable Provider request can carry the command.
 *
 * `request.value` carries only the details the user wrote around the command:
 * the composer removes the command node from its semantic document, so this
 * handler never re-parses a command spelling out of raw text.
 */
export async function reportBug(controller: Controller, request: StringRequest): Promise<Empty> {
    const mode = controller.stateManager.getGlobalSettingsKey("mode") ?? "act"
    const provider = resolveProvider(controller.stateManager.getApiConfiguration(), mode) ?? "unavailable"
    const details = request.value.trim()
    const recentError = recentReportBugError(recentTaskError(controller))
    const content: ReportBugContent = {
        title: "Dline bug report",
        whatHappened: details || "Please describe what happened.",
        stepsToReproduce: "Please add the steps needed to reproduce the problem.",
        apiRequestOutput: recentError ?? "No recent task error was available.",
        additionalContext:
            "Opened by Dline's local report fallback because no usable Provider request was available. Images and files selected in Dline are not uploaded; add them manually in this GitHub form.",
    }
    const environment = await collectReportBugEnvironment(`${provider} / unavailable`)
    if (!controller.task) {
        // An empty task creates the canonical durable interaction owner without
        // admitting user text or starting a Provider request.
        await controller.initTask()
    }
    const task = controller.task
    if (!task) throw new Error("ReportBug preview requires an active task interaction owner")
    const operationId = randomUUID()
    await openReportBugPreview({
        interactions: task.owners.interactions,
        turnId: `report-bug-local:${operationId}`,
        interactionId: `report-bug-local:${operationId}`,
        content,
        environment,
        placement: "interrupt",
    })
    return Empty.create()
}

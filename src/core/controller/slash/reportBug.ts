import { resolveProvider } from "@core/api"
import {
    collectReportBugEnvironment,
    openReportBugIssue,
    type ReportBugContent,
    recentReportBugError,
} from "@core/reporting/ReportBugIssue"
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

/** Open an editable local issue form when no usable Provider request can carry the command. */
export async function reportBug(controller: Controller, request: StringRequest): Promise<Empty> {
    const mode = controller.stateManager.getGlobalSettingsKey("mode") ?? "act"
    const provider = resolveProvider(controller.stateManager.getApiConfiguration(), mode) ?? "unavailable"
    const details = request.value.replace(/^\s*\/(?:cmd:)?reportbug\b\s*/i, "").trim()
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
    await openReportBugIssue(content, environment)
    return Empty.create()
}

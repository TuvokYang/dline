import { getFileMentionFromPath } from "@/core/mentions"
import { singleFileDiagnosticsToProblemsString } from "@/integrations/diagnostics"
import { telemetryService } from "@/services/telemetry"
import { CommandContext, Empty } from "@/shared/proto/dline"
import { AskResponseRequest } from "@/shared/proto/dline/task"
import { Logger } from "@/shared/services/Logger"
import { Controller } from "../index"
import { askResponse } from "../task/askResponse"
import { sendAddToInputEvent } from "../ui/subscribeToAddToInput"

interface AddToClineOptions {
    startTask?: boolean
}

// 'Add to Dline' context menu in editor and code action
// Inserts the selected code into the chat or starts an isolated panel task.
export async function addToCline(
    controller: Controller,
    request: CommandContext,
    notebookContext?: string,
    options: AddToClineOptions = {},
): Promise<Empty> {
    if (!request.selectedText?.trim() && !notebookContext) {
        Logger.log("No text selected and no notebook context - returning early")
        return {}
    }

    const filePath = request.filePath || ""
    const fileMention = await getFileMentionFromPath(filePath)

    // Everything after the mention is the selection block: the composer keeps it
    // as one literal, so code that happens to read like a command never runs.
    let selection = `\n\`\`\`\n${request.selectedText}\n\`\`\``

    // Add notebook context if provided (includes cell JSON)
    if (notebookContext) {
        Logger.log("Adding notebook context for enhanced editing")
        selection += `\n${notebookContext}`
    }

    if (request.diagnostics.length) {
        const problemsString = await singleFileDiagnosticsToProblemsString(filePath, request.diagnostics)
        selection += `\nProblems:\n${problemsString}`
    }
    const input = `${fileMention}${selection}`

    // Notebooks send immediately. Busy-sidebar editor commands start a task
    // on their isolated panel Controller; idle-sidebar adds keep the draft workflow.
    if (notebookContext && controller.task) {
        await askResponse(controller, AskResponseRequest.create({ responseType: "messageResponse", text: input }))
    } else if (notebookContext || options.startTask) {
        await controller.initTask(input)
    } else {
        await sendAddToInputEvent(controller, {
            text: input,
            ...(filePath ? { mentionReference: mentionReferenceOf(fileMention) } : {}),
            selection,
        })
    }

    Logger.log("addToCline", request.selectedText, filePath, request.language)
    telemetryService.captureButtonClick("codeAction_addToChat", controller.task?.owners.identity.taskIncarnationId)

    return {}
}

/** The reference a file mention names, with the separators the shared mention grammar reads. */
function mentionReferenceOf(fileMention: string): string {
    return fileMention.replace(/^@/, "").replaceAll("\\", "/")
}

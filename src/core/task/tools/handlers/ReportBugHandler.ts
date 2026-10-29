import { resolveProvider } from "@core/api"
import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { collectReportBugEnvironment, type ReportBugContent } from "@core/reporting/ReportBugIssue"
import { openReportBugPreview } from "@core/reporting/ReportBugWorkflow"
import { Logger } from "@/shared/services/Logger"
import { DlineDefaultTool } from "@/shared/tools"
import type { IInteractionOwningToolHandler, IPartialBlockHandler, IToolHandler } from "../ToolExecutorCoordinator"
import type { ToolResponse } from "../ToolResponse"
import { interactionId, interactionTurnId, type TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"

export class ReportBugHandler implements IToolHandler, IPartialBlockHandler, IInteractionOwningToolHandler {
    readonly name = DlineDefaultTool.REPORT_BUG
    readonly ownsInteractionConfirmation = true as const

    getDescription(block: ToolUse): string {
        return `[${block.name}]`
    }

    async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
        const partialMessage = JSON.stringify({
            title: uiHelpers.removeClosingTag(block, "title", block.params.title),
            what_happened: uiHelpers.removeClosingTag(block, "what_happened", block.params.what_happened),
            steps_to_reproduce: uiHelpers.removeClosingTag(block, "steps_to_reproduce", block.params.steps_to_reproduce),
            api_request_output: uiHelpers.removeClosingTag(block, "api_request_output", block.params.api_request_output),
            additional_context: uiHelpers.removeClosingTag(block, "additional_context", block.params.additional_context),
        })

        await uiHelpers.say("tool", partialMessage, undefined, undefined, true, block.ts)
    }

    async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
        const content: ReportBugContent = {
            title: block.params.title ?? "",
            whatHappened: block.params.what_happened ?? "",
            stepsToReproduce: block.params.steps_to_reproduce ?? "",
            apiRequestOutput: block.params.api_request_output ?? "",
            additionalContext: block.params.additional_context ?? "",
        }
        const required = [
            ["title", content.title],
            ["what_happened", content.whatHappened],
            ["steps_to_reproduce", content.stepsToReproduce],
            ["api_request_output", content.apiRequestOutput],
            ["additional_context", content.additionalContext],
        ] as const
        const missing = required.find(([, value]) => !value)
        if (missing) {
            config.taskState.consecutiveMistakeCount++
            return await config.callbacks.sayAndCreateMissingParamError(block.name, missing[0], undefined, block.ts)
        }
        config.taskState.consecutiveMistakeCount = 0

        const apiConfig = config.services.stateManager.getApiConfiguration()
        const apiProvider = resolveProvider(apiConfig, config.mode) ?? "unknown"
        const environment = await collectReportBugEnvironment(`${apiProvider} / ${config.api.getModel().id}`)
        try {
            const outcome = await openReportBugPreview({
                interactions: config.interactions,
                turnId: interactionTurnId(block),
                interactionId: interactionId(block),
                content,
                environment,
                existingTs: block.ts,
            })
            if (outcome === "cancelled") return formatResponse.reportBugCancelled()
            if (outcome === "invalid") return formatResponse.toolError("The confirmed bug report draft could not be read.")
        } catch (error) {
            Logger.error(`An error occurred while attempting to report the bug: ${error}`)
            return formatResponse.toolError("The GitHub issue form could not be opened.")
        }
        return formatResponse.reportBugOpened(false)
    }
}

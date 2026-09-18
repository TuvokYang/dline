import { resolveProvider } from "@core/api"
import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { createAndOpenGitHubIssue } from "@utils/github-url-utils"
import * as os from "os"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo } from "@/registry"
import { Logger } from "@/shared/services/Logger"
import { ClineDefaultTool } from "@/shared/tools"
import type { ToolResponse } from "../../index"
import type { IPartialBlockHandler, IToolHandler } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { sayFeedbackOnce } from "../utils/UserFeedbackUtils"

export class ReportBugHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = ClineDefaultTool.REPORT_BUG

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
		const title = block.params.title
		const what_happened = block.params.what_happened
		const steps_to_reproduce = block.params.steps_to_reproduce
		const api_request_output = block.params.api_request_output
		const additional_context = block.params.additional_context

		// Validate required parameters
		if (!title) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "title", undefined, block.ts)
		}
		if (!what_happened) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "what_happened", undefined, block.ts)
		}
		if (!steps_to_reproduce) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "steps_to_reproduce", undefined, block.ts)
		}
		if (!api_request_output) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "api_request_output", undefined, block.ts)
		}
		if (!additional_context) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "additional_context", undefined, block.ts)
		}

		config.taskState.consecutiveMistakeCount = 0

		// Derive system information values algorithmically
		const operatingSystem = `${os.platform()} ${os.release()}`
		const currentMode = config.mode
		const clineVersion = ExtensionRegistryInfo.version
		const host = await HostProvider.env.getHostVersion({})
		const systemInfo = `${host.platform}: ${host.version}, Node.js: ${process.version}, Architecture: ${os.arch()}`
		const apiConfig = config.services.stateManager.getApiConfiguration()
		const apiProvider = resolveProvider(apiConfig, currentMode)
		const providerAndModel = `${apiProvider} / ${config.api.getModel().id}`

		// Ask user for confirmation
		const bugReportData = JSON.stringify({
			title,
			what_happened,
			steps_to_reproduce,
			api_request_output,
			additional_context,
			// Include derived values in the JSON for display purposes
			provider_and_model: providerAndModel,
			operating_system: operatingSystem,
			system_info: systemInfo,
			cline_version: clineVersion,
		})

		const outcome = block.dline_tid ? config.admissionOutcomes?.get(block.dline_tid) : undefined
		await config.callbacks.say("tool", bugReportData, undefined, undefined, false, block.ts)
		const text = outcome?.draft?.text
		const images = outcome?.draft?.images
		const reportBugFiles = outcome?.draft?.files

		// If the user provided a response, treat it as feedback
		if (text || (images && images.length > 0) || (reportBugFiles && reportBugFiles.length > 0)) {
			let fileContentString = ""
			if (reportBugFiles && reportBugFiles.length > 0) {
				fileContentString = await processFilesIntoText(reportBugFiles)
			}

			await sayFeedbackOnce(config, "messageResponse", text, images, reportBugFiles)
			return formatResponse.toolResult(
				`The user did not submit the bug, and provided feedback on the Github issue generated instead:\n<feedback>\n${text}\n</feedback>`,
				images,
				fileContentString,
			)
		}
		// If no response, the user accepted the bug report
		try {
			// Create a Map of parameters for the GitHub issue
			const params = new Map<string, string>()
			params.set("title", title)
			params.set("operating-system", operatingSystem)
			params.set("cline-version", clineVersion)
			params.set("system-info", systemInfo)
			params.set("additional-context", additional_context)
			params.set("what-happened", what_happened)
			params.set("steps", steps_to_reproduce)
			params.set("provider-model", providerAndModel)
			params.set("logs", api_request_output)

			// Use our utility function to create and open the GitHub issue URL
			// This bypasses VS Code's URI handling issues with special characters
			await createAndOpenGitHubIssue("TuvokYang", "dline", "bug_report.yml", params)
		} catch (error) {
			Logger.error(`An error occurred while attempting to report the bug: ${error}`)
		}

		return formatResponse.toolResult(`The user accepted the creation of the Github issue.`)
	}
}

import { resolveProvider } from "@core/api"
import type { ToolUse } from "@core/assistant-message"
import { resolveWorkspacePath } from "@core/workspace"
import { parseSourceCodeForDefinitionsTopLevel } from "@services/tree-sitter"
import { getReadablePath, isLocatedInWorkspace } from "@utils/path"
import { formatResponse } from "@/core/prompts/responses"
import { telemetryService } from "@/services/telemetry"
import { ClineDefaultTool } from "@/shared/tools"
import type { ToolResponse } from "../../index"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"

export class ListCodeDefinitionNamesToolHandler implements IFullyManagedTool {
	readonly name = ClineDefaultTool.LIST_CODE_DEF

	constructor(private validator: ToolValidator) {}

	getDescription(block: ToolUse): string {
		return `[${block.name} for '${block.params.path}']`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const relPath = block.params.path

		const config = uiHelpers.getConfig()
		if (config.isSubagentExecution) {
			return
		}

		// Create and show partial UI message
		const sharedMessageProps = {
			tool: "listCodeDefinitionNames",
			path: getReadablePath(config.cwd, uiHelpers.removeClosingTag(block, "path", relPath)),
			content: "",
			operationIsLocatedInWorkspace: await isLocatedInWorkspace(relPath),
		}

		const partialMessage = JSON.stringify(sharedMessageProps)

		await uiHelpers.say("tool", partialMessage, undefined, undefined, true, block.ts)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const relDirPath: string | undefined = block.params.path

		// Extract provider using the proven pattern from ReportBugHandler
		const apiConfig = config.services.stateManager.getApiConfiguration()
		const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
		const provider = resolveProvider(apiConfig, currentMode)

		// Validate required parameters
		const pathValidation = this.validator.assertRequiredParams(block, "path")
		if (!pathValidation.ok) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(this.name, "path", undefined, block.ts)
		}
		if (!relDirPath) throw new Error("Validated list-code-definitions path is missing")

		// Run PreToolUse before the first target parse.
		try {
			const { ToolHookUtils } = await import("../utils/ToolHookUtils")
			await ToolHookUtils.runPreToolUseIfEnabled(config, block)
		} catch (error) {
			const { PreToolUseHookCancellationError } = await import("@core/hooks/PreToolUseHookCancellationError")
			if (error instanceof PreToolUseHookCancellationError) return formatResponse.toolDenied()
			throw error
		}

		// Resolve the path and execute the parse operation inside a single
		// try/catch so that failures in either step (e.g. bad workspace hint,
		// non-existent directory) return a graceful tool error instead of
		// crashing the task.
		let absolutePath: string
		let displayPath: string
		let result: string
		try {
			const pathResult = resolveWorkspacePath(config, relDirPath, "ListCodeDefinitionNamesToolHandler.execute")
			;({ absolutePath, displayPath } =
				typeof pathResult === "string" ? { absolutePath: pathResult, displayPath: relDirPath } : pathResult)
			result = await parseSourceCodeForDefinitionsTopLevel(absolutePath, config.services.ignoreController)
		} catch (error) {
			config.taskState.consecutiveMistakeCount++
			const errorMessage = error instanceof Error ? error.message : String(error)
			return formatResponse.toolError(`Error listing code definitions: ${errorMessage}`)
		}

		// parseSourceCodeForDefinitionsTopLevel returns error strings for file paths
		// and non-existent directories rather than throwing. Check for these error
		// conditions and increment the counter so repeated failures accumulate.
		const isErrorResult =
			result.includes("provided path is a file, not a directory") ||
			result.includes("does not exist or you do not have permission")

		if (isErrorResult) {
			config.taskState.consecutiveMistakeCount++
			return formatResponse.toolError(result)
		}

		// Only reset after a successful operation so repeated failures
		// accumulate toward the yolo-mode mistake limit.
		config.taskState.consecutiveMistakeCount = 0

		// Handle approval flow
		const sharedMessageProps = {
			tool: "listCodeDefinitionNames",
			path: getReadablePath(config.cwd, displayPath),
			content: result,
			operationIsLocatedInWorkspace: await isLocatedInWorkspace(relDirPath),
		}

		const completeMessage = JSON.stringify(sharedMessageProps)

		if (!config.isSubagentExecution) {
			await config.callbacks.say("tool", completeMessage, undefined, undefined, false, block.ts)
		}
		telemetryService.captureToolUsage(
			config.ulid ?? "",
			block.name,
			config.api.getModel().id,
			provider ?? "",
			!block.dline_tid || !config.admissionOutcomes?.has(block.dline_tid),
			true,
			undefined,
			block.isNativeToolCall,
		)
		return result
	}
}

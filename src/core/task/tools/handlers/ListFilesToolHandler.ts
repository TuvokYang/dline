import path from "node:path"
import { resolveProvider } from "@core/api"
import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { resolveWorkspacePath } from "@core/workspace"
import { listFiles } from "@services/glob/list-files"
import { arePathsEqual, getReadablePath, isLocatedInWorkspace } from "@utils/path"
import { telemetryService } from "@/services/telemetry"
import { ClineDefaultTool } from "@/shared/tools"
import type { ToolResponse } from "../../index"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"

export class ListFilesToolHandler implements IFullyManagedTool {
	readonly name = ClineDefaultTool.LIST_FILES

	constructor(private validator: ToolValidator) {}

	getDescription(block: ToolUse): string {
		return `[${block.name} for '${block.params.path}']`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const relPath = block.params.path

		// Get config access for services
		const config = uiHelpers.getConfig()
		if (config.isSubagentExecution) {
			return
		}

		// Create and show partial UI message
		const recursiveRaw = block.params.recursive
		const recursive = recursiveRaw?.toLowerCase() === "true"
		const sharedMessageProps = {
			tool: recursive ? "listFilesRecursive" : "listFilesTopLevel",
			path: getReadablePath(config.cwd, uiHelpers.removeClosingTag(block, "path", relPath)),
			content: "",
			operationIsLocatedInWorkspace: await isLocatedInWorkspace(relPath),
		}

		const partialMessage = JSON.stringify(sharedMessageProps)

		await uiHelpers.say("tool", partialMessage, undefined, undefined, true, block.ts)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const relDirPath: string | undefined = block.params.path
		const recursiveRaw: string | undefined = block.params.recursive
		const recursive = recursiveRaw?.toLowerCase() === "true"

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
		if (!relDirPath) throw new Error("Validated list-files path is missing")

		// Check clineignore access before performing any IO.
		// Increment the counter so repeated attempts at blocked paths
		// accumulate toward the yolo-mode mistake limit.
		const accessValidation = this.validator.checkClineIgnorePath(relDirPath)
		if (!accessValidation.ok) {
			config.taskState.consecutiveMistakeCount++
			if (!config.isSubagentExecution) {
				await config.callbacks.say("clineignore_error", relDirPath)
			}
			return formatResponse.toolError(formatResponse.clineIgnoreError(relDirPath))
		}

		let absolutePath: string
		let displayPath: string
		let usedWorkspaceHint: boolean
		try {
			const pathResult = resolveWorkspacePath(config, relDirPath, "ListFilesToolHandler.execute")
			;({ absolutePath, displayPath } =
				typeof pathResult === "string" ? { absolutePath: pathResult, displayPath: relDirPath } : pathResult)
			usedWorkspaceHint = typeof pathResult !== "string"
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			return formatResponse.toolError(`Error listing files: ${errorMessage}`)
		}

		// Determine workspace context for telemetry
		const fallbackAbsolutePath = path.resolve(config.cwd, relDirPath ?? "")
		const workspaceContext = {
			isMultiRootEnabled: config.isMultiRootEnabled || false,
			usedWorkspaceHint,
			resolvedToNonPrimary: !arePathsEqual(absolutePath, fallbackAbsolutePath),
			resolutionMethod: (usedWorkspaceHint ? "hint" : "primary_fallback") as "hint" | "primary_fallback",
		}

		const operationIsLocatedInWorkspace = await isLocatedInWorkspace(relDirPath)
		const createToolMessage = (content: string) =>
			JSON.stringify({
				tool: recursive ? "listFilesRecursive" : "listFilesTopLevel",
				path: getReadablePath(config.cwd, displayPath),
				content,
				operationIsLocatedInWorkspace,
			})

		const wasAutoApproved = !block.dline_tid || !config.admissionOutcomes?.has(block.dline_tid)

		// Run PreToolUse hook after approval but before execution
		try {
			const { ToolHookUtils } = await import("../utils/ToolHookUtils")
			await ToolHookUtils.runPreToolUseIfEnabled(config, block)
		} catch (error) {
			const { PreToolUseHookCancellationError } = await import("@core/hooks/PreToolUseHookCancellationError")
			if (error instanceof PreToolUseHookCancellationError) {
				return formatResponse.toolDenied()
			}
			throw error
		}

		let fileInfos: import("@services/glob/list-files").FileInfo[]
		let didHitLimit: boolean
		try {
			;[fileInfos, didHitLimit] = await listFiles(absolutePath, recursive, 200, {
				ignoreController: config.services.ignoreController,
			})
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			return formatResponse.toolError(`Error listing files: ${errorMessage}`)
		}

		const result = formatResponse.formatFilesList(absolutePath, fileInfos, didHitLimit, config.services.ignoreController)
		config.taskState.consecutiveMistakeCount = 0

		if (!config.isSubagentExecution) {
			await config.callbacks.say("tool", createToolMessage(result), undefined, undefined, false, block.ts)
		}

		telemetryService.captureToolUsage(
			config.ulid ?? "",
			block.name,
			config.api.getModel().id,
			provider ?? "",
			wasAutoApproved,
			true,
			workspaceContext,
			block.isNativeToolCall,
		)

		return result
	}
}

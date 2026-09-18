import { getPrompt } from "@core/prompts/i18n"
import { ClineSayTool } from "@shared/ExtensionMessage"
import { ClineDefaultTool } from "@shared/tools"
import { telemetryService } from "@/services/telemetry"
import { BrowserWebFetchProvider, type LocalWebFetchProvider } from "@/services/web-fetch/LocalWebFetchProvider"
import { ToolUse } from "../../../assistant-message"
import { formatResponse } from "../../../prompts/responses"
import { ToolResponse } from "../.."
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { NO_TOOL_RESULT } from "../utils/ToolResultUtils"

function cancellationError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Web fetch operation was cancelled")
}

function throwIfCancelled(signal: AbortSignal): void {
	if (signal.aborted) {
		throw cancellationError(signal)
	}
}

export class WebFetchToolHandler implements IFullyManagedTool {
	readonly name = ClineDefaultTool.WEB_FETCH

	constructor(private readonly provider: LocalWebFetchProvider = new BrowserWebFetchProvider()) {}

	getDescription(block: ToolUse): string {
		return `[${block.name} for '${block.params.url}']`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const url = block.params.url || ""
		const normalizedUrl = uiHelpers.removeClosingTag(block, "url", url)
		if (!normalizedUrl.trim()) return
		const sharedMessageProps: ClineSayTool = {
			tool: "webFetch",
			path: normalizedUrl,
			content: `Fetching URL: ${normalizedUrl}`,
			operationIsLocatedInWorkspace: false, // web_fetch is always external
			webFetch: {
				schemaVersion: 1,
				status: "running",
				url: normalizedUrl,
			},
		} satisfies ClineSayTool

		const partialMessage = JSON.stringify(sharedMessageProps)

		await uiHelpers.say("tool", partialMessage, undefined, undefined, true, block.ts)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const operationSignal = config.taskState.operationSignal
		let terminalMessage: ClineSayTool | undefined
		let failureWritten = false
		const writeFailure = async (message: string): Promise<void> => {
			if (operationSignal.aborted || failureWritten || !terminalMessage?.webFetch) return
			const failedMessage: ClineSayTool = {
				...terminalMessage,
				content: `Web fetch failed: ${message}`,
				webFetch: {
					...terminalMessage.webFetch,
					status: "failed",
					error: message,
				},
			}
			await config.callbacks.say("tool", JSON.stringify(failedMessage), undefined, undefined, false, block.ts)
			failureWritten = true
		}

		try {
			const url: string | undefined = block.params.url
			const prompt: string | undefined = block.params.prompt

			const provider = config.api.getProviderId?.()

			// Web Fetch follows the request-frozen global Web Tools switch. A restored
			// approval from before request scopes existed falls back to the live setting.
			const webToolsEnabled =
				config.webToolsEnabled ?? config.services.stateManager.getGlobalSettingsKey("clineWebToolsEnabled") === true
			if (!webToolsEnabled) {
				return formatResponse.toolError(getPrompt("toolHandlers", "webToolsDisabled"))
			}

			// Validate required parameters
			if (!url) {
				config.taskState.consecutiveMistakeCount++
				return await config.callbacks.sayAndCreateMissingParamError(this.name, "url", undefined, block.ts)
			}
			if (!prompt) {
				config.taskState.consecutiveMistakeCount++
				return await config.callbacks.sayAndCreateMissingParamError(this.name, "prompt", undefined, block.ts)
			}
			config.taskState.consecutiveMistakeCount = 0

			// Create message for approval
			const sharedMessageProps: ClineSayTool = {
				tool: "webFetch",
				path: url,
				content: `Fetching URL: ${url}`,
				operationIsLocatedInWorkspace: false,
				webFetch: {
					schemaVersion: 1,
					status: "running",
					url,
					prompt,
				},
			}
			terminalMessage = sharedMessageProps
			const completeMessage = JSON.stringify(sharedMessageProps)

			await config.callbacks.say("tool", completeMessage, undefined, undefined, false, block.ts)
			telemetryService.captureToolUsage(
				config.ulid ?? "",
				"web_fetch",
				config.api.getModel().id,
				provider ?? "",
				!block.dline_tid || !config.admissionOutcomes?.has(block.dline_tid),
				true,
				undefined,
				block.isNativeToolCall,
			)

			// Run PreToolUse hook after approval but before execution
			try {
				const { ToolHookUtils } = await import("../utils/ToolHookUtils")
				await ToolHookUtils.runPreToolUseIfEnabled(config, block, { beforeTaskCancellation: writeFailure })
			} catch (error) {
				const { PreToolUseHookCancellationError } = await import("@core/hooks/PreToolUseHookCancellationError")
				if (error instanceof PreToolUseHookCancellationError) {
					await writeFailure(error.message)
					return formatResponse.toolDenied()
				}
				throw error
			}

			throwIfCancelled(operationSignal)
			const result = await this.provider.fetch({ url, prompt, signal: operationSignal })
			throwIfCancelled(operationSignal)
			const completedMessage: ClineSayTool = {
				...sharedMessageProps,
				content: `Fetched URL: ${result.url}`,
				webFetch: {
					schemaVersion: 1,
					status: "completed",
					source: result.source,
					url: result.url,
					prompt: result.prompt,
					content: result.content,
				},
			}
			await config.callbacks.say("tool", JSON.stringify(completedMessage), undefined, undefined, false, block.ts)
			return formatResponse.toolResult(
				JSON.stringify({
					url: result.url,
					prompt: result.prompt,
					source: result.source,
					content: result.content,
				}),
			)
		} catch (error) {
			if (operationSignal.aborted) {
				return NO_TOOL_RESULT
			}
			const message = error instanceof Error ? error.message : String(error)
			await writeFailure(message)
			return `Error fetching web content: ${message}`
		}
	}
}

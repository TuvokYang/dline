import { resolveProvider } from "@core/api"
import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { UiAskUseMcpServer, UiSayMcpServerResponse } from "@shared/ExtensionMessage"
import { telemetryService } from "@/services/telemetry"
import { truncateContent } from "@/shared/content-limits"
import { Logger } from "@/shared/services/Logger"
import { ClineDefaultTool } from "@/shared/tools"
import type { ToolHandlerResult } from "../ToolExecutionResult"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { ToolResponse } from "../ToolResponse"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"

function failed(
	response: ToolResponse,
	stage: "validation" | "authorization" | "execution" | "remote",
	code: string,
): ToolHandlerResult {
	return { response, failure: { stage, code } }
}

export class UseMcpToolHandler implements IFullyManagedTool {
	readonly name = ClineDefaultTool.MCP_USE

	getDescription(block: ToolUse): string {
		return `[${block.name} for '${block.params.server_name}']`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const server_name = block.params.server_name
		const tool_name = block.params.tool_name
		const mcp_arguments = block.params.arguments

		const partialMessage = JSON.stringify({
			type: "use_mcp_tool",
			serverName: uiHelpers.removeClosingTag(block, "server_name", server_name),
			toolName: uiHelpers.removeClosingTag(block, "tool_name", tool_name),
			arguments: uiHelpers.removeClosingTag(block, "arguments", mcp_arguments),
		} satisfies UiAskUseMcpServer)

		await uiHelpers.say("use_mcp_server", partialMessage, undefined, undefined, true, block.ts)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolHandlerResult> {
		const server_name: string | undefined = block.params.server_name
		const tool_name: string | undefined = block.params.tool_name
		const mcp_arguments: string | undefined = block.params.arguments

		// Extract provider information for telemetry
		const apiConfig = config.services.stateManager.getApiConfiguration()
		const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
		const provider = resolveProvider(apiConfig, currentMode)

		// Validate required parameters
		if (!server_name) {
			config.taskState.consecutiveMistakeCount++
			return failed(
				await config.callbacks.sayAndCreateMissingParamError(block.name, "server_name", undefined, block.ts),
				"validation",
				"missing_server_name",
			)
		}

		if (!tool_name) {
			config.taskState.consecutiveMistakeCount++
			return failed(
				await config.callbacks.sayAndCreateMissingParamError(block.name, "tool_name", undefined, block.ts),
				"validation",
				"missing_tool_name",
			)
		}

		if (config.capabilityToggles.mcpServers[server_name] !== true) {
			config.taskState.consecutiveMistakeCount++
			return failed(
				formatResponse.toolError(`MCP server '${server_name}' is not enabled for this task.`),
				"authorization",
				"server_disabled_for_task",
			)
		}

		// Parse and validate arguments if provided
		let parsedArguments: Record<string, unknown> | undefined
		if (mcp_arguments) {
			try {
				parsedArguments = JSON.parse(mcp_arguments)
			} catch (_error) {
				config.taskState.consecutiveMistakeCount++
				await config.callbacks.say("error", `Dline tried to use ${tool_name} with an invalid JSON argument. Retrying...`)
				return failed(
					formatResponse.toolError(formatResponse.invalidMcpToolArgumentError(server_name, tool_name)),
					"validation",
					"invalid_arguments_json",
				)
			}
		}

		config.taskState.consecutiveMistakeCount = 0

		const completeMessage = JSON.stringify({
			type: "use_mcp_tool",
			serverName: server_name,
			toolName: tool_name,
			arguments: mcp_arguments,
		} satisfies UiAskUseMcpServer)

		const requestTs =
			(await config.callbacks.say("use_mcp_server", completeMessage, undefined, undefined, false, block.ts)) ?? block.ts
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

		// Run PreToolUse hook after admission but before execution
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

		// Show MCP request started message
		await config.callbacks.say("mcp_server_request_started")

		try {
			// Check for any pending notifications before the tool call
			const notificationsBefore = config.services.mcpHub.getPendingNotifications()
			for (const notification of notificationsBefore) {
				await config.callbacks.say("mcp_notification", `[${notification.serverName}] ${notification.message}`)
			}

			// Execute the MCP tool
			const toolResult = await config.services.mcpHub.callTool(server_name, tool_name, parsedArguments, config.ulid ?? "")

			// Check for any pending notifications after the tool call
			const notificationsAfter = config.services.mcpHub.getPendingNotifications()
			for (const notification of notificationsAfter) {
				await config.callbacks.say("mcp_notification", `[${notification.serverName}] ${notification.message}`)
			}

			// Keep every MCP content item as one durable response group. The Webview
			// renders the group as one collapsible card attached to this request.
			const responseItems =
				toolResult?.content
					.map((item) => {
						if (item.type === "text") return item.text
						if (item.type === "image") return `data:${item.mimeType};base64,${item.data}`
						if (item.type === "resource") {
							const { blob: _blob, ...rest } = item.resource
							return JSON.stringify(rest, null, 2)
						}
						return ""
					})
					.filter(Boolean) ?? []
			if (responseItems.length === 0) responseItems.push("(No response)")
			if (toolResult?.isError) responseItems[0] = `Error:\n${responseItems[0]}`

			const responsePresentation = JSON.stringify({
				type: "mcp_server_response",
				requestTs,
				responses: responseItems,
			} satisfies UiSayMcpServerResponse)
			await config.callbacks.say("mcp_server_response", responsePresentation)

			const toolResultImages = responseItems.filter((item) => item.startsWith("data:image/"))
			let toolResultText = responseItems.filter((item) => !item.startsWith("data:image/")).join("\n\n")

			// Handle model image support
			const supportsImages = config.api.getModel().info.capabilities?.supportsImages ?? false
			if (toolResultImages.length > 0 && !supportsImages) {
				toolResultText += `\n\n[${toolResultImages.length} images were provided in the response, and while they are displayed to the user, you do not have the ability to view them.]`
			}

			// Truncate response if it exceeds 400KB to prevent context overflow
			toolResultText = truncateContent(toolResultText)

			// Return formatted result (only pass images if model supports them)
			const response = formatResponse.toolResult(toolResultText, supportsImages ? toolResultImages : undefined)
			return toolResult?.isError ? failed(response, "remote", "remote_tool_error") : response
		} catch (error) {
			config.taskState.consecutiveMistakeCount++
			Logger.error(`[UseMcpToolHandler] ${server_name}/${tool_name} failed`, error instanceof Error ? error : undefined)
			const safeMessage = `MCP tool '${tool_name}' on server '${server_name}' failed. Check the MCP server logs for details.`
			await config.callbacks.say(
				"mcp_server_response",
				JSON.stringify({
					type: "mcp_server_response",
					requestTs,
					responses: [safeMessage],
				} satisfies UiSayMcpServerResponse),
			)
			return failed(formatResponse.toolError(safeMessage), "execution", "mcp_call_failed")
		}
	}
}

import { resolveProvider } from "@core/api"
import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { ClineAskUseMcpServer } from "@shared/ExtensionMessage"
import { telemetryService } from "@/services/telemetry"
import { truncateContent } from "@/shared/content-limits"
import { ClineDefaultTool } from "@/shared/tools"
import type { ToolResponse } from "../../index"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"

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
		} satisfies ClineAskUseMcpServer)

		await uiHelpers.say("use_mcp_server", partialMessage, undefined, undefined, true, block.ts)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
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
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "server_name", undefined, block.ts)
		}

		if (!tool_name) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "tool_name", undefined, block.ts)
		}

		if (config.capabilityToggles.mcpServers[server_name] !== true) {
			config.taskState.consecutiveMistakeCount++
			return formatResponse.toolError(`MCP server '${server_name}' is not enabled for this task.`)
		}

		// Parse and validate arguments if provided
		let parsedArguments: Record<string, unknown> | undefined
		if (mcp_arguments) {
			try {
				parsedArguments = JSON.parse(mcp_arguments)
			} catch (_error) {
				config.taskState.consecutiveMistakeCount++
				await config.callbacks.say("error", `Dline tried to use ${tool_name} with an invalid JSON argument. Retrying...`)
				return formatResponse.toolError(formatResponse.invalidMcpToolArgumentError(server_name, tool_name))
			}
		}

		config.taskState.consecutiveMistakeCount = 0

		const completeMessage = JSON.stringify({
			type: "use_mcp_tool",
			serverName: server_name,
			toolName: tool_name,
			arguments: mcp_arguments,
		} satisfies ClineAskUseMcpServer)

		await config.callbacks.say("use_mcp_server", completeMessage, undefined, undefined, false, block.ts)
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

			// Process tool result
			const toolResultImages =
				toolResult?.content.flatMap((item) =>
					item.type === "image" ? [`data:${item.mimeType};base64,${item.data}`] : [],
				) ?? []

			let toolResultText =
				(toolResult?.isError ? "Error:\n" : "") +
					toolResult?.content
						.map((item) => {
							if (item.type === "text") {
								return item.text
							}
							if (item.type === "resource") {
								const { blob: _blob, ...rest } = item.resource
								return JSON.stringify(rest, null, 2)
							}
							return ""
						})
						.filter(Boolean)
						.join("\n\n") || "(No response)"

			// webview extracts images from the text response to display in the UI
			const toolResultToDisplay = toolResultText + toolResultImages.map((image) => `\n\n${image}`).join("")
			await config.callbacks.say("mcp_server_response", toolResultToDisplay)

			// Handle model image support
			const supportsImages = config.api.getModel().info.capabilities?.supportsImages ?? false
			if (toolResultImages.length > 0 && !supportsImages) {
				toolResultText += `\n\n[${toolResultImages.length} images were provided in the response, and while they are displayed to the user, you do not have the ability to view them.]`
			}

			// Truncate response if it exceeds 400KB to prevent context overflow
			toolResultText = truncateContent(toolResultText)

			// Return formatted result (only pass images if model supports them)
			return formatResponse.toolResult(toolResultText, supportsImages ? toolResultImages : undefined)
		} catch (error) {
			return `Error executing MCP tool: ${(error as Error)?.message}`
		}
	}
}

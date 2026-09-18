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

export class AccessMcpResourceHandler implements IFullyManagedTool {
	readonly name = ClineDefaultTool.MCP_ACCESS

	getDescription(block: ToolUse): string {
		return `[${block.name} for '${block.params.server_name}']`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const server_name = block.params.server_name
		const uri = block.params.uri

		const partialMessage = JSON.stringify({
			type: this.name,
			serverName: uiHelpers.removeClosingTag(block, "server_name", server_name),
			toolName: undefined,
			uri: uiHelpers.removeClosingTag(block, "uri", uri),
			arguments: undefined,
		} satisfies ClineAskUseMcpServer)

		await uiHelpers.say("use_mcp_server", partialMessage, undefined, undefined, true, block.ts)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const server_name: string | undefined = block.params.server_name
		const uri: string | undefined = block.params.uri

		// Extract provider using the proven pattern from ReportBugHandler
		const apiConfig = config.services.stateManager.getApiConfiguration()
		const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
		const provider = resolveProvider(apiConfig, currentMode)

		// Validate required parameters
		if (!server_name) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(
				ClineDefaultTool.MCP_ACCESS,
				"server_name",
				undefined,
				block.ts,
			)
		}

		if (!uri) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(ClineDefaultTool.MCP_ACCESS, "uri", undefined, block.ts)
		}

		if (config.capabilityToggles.mcpServers[server_name] !== true) {
			config.taskState.consecutiveMistakeCount++
			return formatResponse.toolError(`MCP server '${server_name}' is not enabled for this task.`)
		}

		config.taskState.consecutiveMistakeCount = 0

		// Handle approval flow
		const completeMessage = JSON.stringify({
			type: "access_mcp_resource",
			serverName: server_name,
			toolName: undefined,
			uri: uri,
			arguments: undefined,
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

		await config.callbacks.say("mcp_server_request_started")

		// Execute the MCP resource access
		const resourceResult = await config.services.mcpHub.readResource(server_name, uri)

		// Process the resource result
		const resourceResultPretty =
			resourceResult?.contents
				.map((item) => {
					if (item.text) {
						return item.text
					}
					return ""
				})
				.filter(Boolean)
				.join("\n\n") || "(Empty response)"

		// Display result to user
		await config.callbacks.say("mcp_server_response", resourceResultPretty)

		// Truncate response if it exceeds 400KB to prevent context overflow
		const truncatedResult = truncateContent(resourceResultPretty)

		// Return formatted result
		return formatResponse.toolResult(truncatedResult)
	}
}

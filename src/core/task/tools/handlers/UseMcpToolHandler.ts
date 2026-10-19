import { resolveProvider } from "@core/api"
import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { UiAskUseMcpServer, UiSayMcpServerResponse } from "@shared/ExtensionMessage"
import { telemetryService } from "@/services/telemetry"
import { boundToolText } from "@/shared/content-limits"
import { Logger } from "@/shared/services/Logger"
import { DlineDefaultTool } from "@/shared/tools"
import type { ToolApprovalPresentation } from "../../executors/tool/ToolPreflight"
import type { ToolHandlerResult } from "../ToolExecutionResult"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { ToolResponse } from "../ToolResponse"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { resolveSelfBoundResultBytes } from "../utils/tool-result-budget"

function failed(
    response: ToolResponse,
    stage: "validation" | "authorization" | "execution" | "remote",
    code: string,
): ToolHandlerResult {
    return { response, failure: { stage, code } }
}

/**
 * The `use_mcp_server` row body for a tool call. The partial row, the approval
 * ask and the executed row all carry this one shape, which is what the chat and
 * the approval card parse.
 */
function useMcpToolMessage(serverName?: string, toolName?: string, mcpArguments?: string): string {
    return JSON.stringify({
        type: "use_mcp_tool",
        serverName: serverName ?? "",
        toolName,
        arguments: mcpArguments,
    } satisfies UiAskUseMcpServer)
}

export class UseMcpToolHandler implements IFullyManagedTool {
    readonly name = DlineDefaultTool.MCP_USE

    getDescription(block: ToolUse): string {
        return `[${block.name} for '${block.params.server_name}']`
    }

    /** The approval shows the typed MCP request, not the raw tool-call parameters. */
    getApprovalPresentation(block: ToolUse, notify: boolean): ToolApprovalPresentation {
        return {
            ask: "use_mcp_server",
            body: useMcpToolMessage(block.params.server_name, block.params.tool_name, block.params.arguments),
            notify,
        }
    }

    async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
        const partialMessage = useMcpToolMessage(
            uiHelpers.removeClosingTag(block, "server_name", block.params.server_name),
            uiHelpers.removeClosingTag(block, "tool_name", block.params.tool_name),
            uiHelpers.removeClosingTag(block, "arguments", block.params.arguments),
        )

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

        const completeMessage = useMcpToolMessage(server_name, tool_name, mcp_arguments)

        const requestTs =
            (await config.callbacks.say("use_mcp_server", completeMessage, undefined, undefined, false, block.ts)) ?? block.ts
        telemetryService.captureToolUsage(
            config.ulid ?? "",
            block.name,
            config.api.getModel().id,
            provider ?? "",
            config.admissionOutcome === undefined,
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
            const supportsImages = config.api.getModel().info.capabilities?.supportsImages ?? false
            const hiddenImageNotice =
                toolResultImages.length > 0 && !supportsImages
                    ? `\n[${toolResultImages.length} images were provided in the response, and while they are displayed to the user, you do not have the ability to view them.]`
                    : undefined
            // Keep both ends of a long payload: servers often close with a summary or an error.
            const toolResultText = boundToolText(
                {
                    body: responseItems.filter((item) => !item.startsWith("data:image/")).join("\n\n"),
                    trailer: hiddenImageNotice,
                },
                { strategy: "headTail", maxBytes: resolveSelfBoundResultBytes(config.contextBudget) },
            )

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

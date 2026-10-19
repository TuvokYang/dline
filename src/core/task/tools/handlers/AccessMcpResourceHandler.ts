import { resolveProvider } from "@core/api"
import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { UiAskUseMcpServer, UiSayMcpServerResponse } from "@shared/ExtensionMessage"
import { telemetryService } from "@/services/telemetry"
import { boundToolText } from "@/shared/content-limits"
import { DlineDefaultTool } from "@/shared/tools"
import type { ToolApprovalPresentation } from "../../executors/tool/ToolPreflight"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { ToolResponse } from "../ToolResponse"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { resolveSelfBoundResultBytes } from "../utils/tool-result-budget"

/**
 * The `use_mcp_server` row body for a resource read; the partial row, the
 * approval ask and the executed row all carry this one shape.
 */
function accessMcpResourceMessage(serverName?: string, uri?: string): string {
    return JSON.stringify({
        type: "access_mcp_resource",
        serverName: serverName ?? "",
        toolName: undefined,
        uri,
        arguments: undefined,
    } satisfies UiAskUseMcpServer)
}

export class AccessMcpResourceHandler implements IFullyManagedTool {
    readonly name = DlineDefaultTool.MCP_ACCESS

    getDescription(block: ToolUse): string {
        return `[${block.name} for '${block.params.server_name}']`
    }

    /** The approval shows the typed MCP request, not the raw tool-call parameters. */
    getApprovalPresentation(block: ToolUse, notify: boolean): ToolApprovalPresentation {
        return {
            ask: "use_mcp_server",
            body: accessMcpResourceMessage(block.params.server_name, block.params.uri),
            notify,
        }
    }

    async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
        const partialMessage = accessMcpResourceMessage(
            uiHelpers.removeClosingTag(block, "server_name", block.params.server_name),
            uiHelpers.removeClosingTag(block, "uri", block.params.uri),
        )

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
                DlineDefaultTool.MCP_ACCESS,
                "server_name",
                undefined,
                block.ts,
            )
        }

        if (!uri) {
            config.taskState.consecutiveMistakeCount++
            return await config.callbacks.sayAndCreateMissingParamError(DlineDefaultTool.MCP_ACCESS, "uri", undefined, block.ts)
        }

        if (config.capabilityToggles.mcpServers[server_name] !== true) {
            config.taskState.consecutiveMistakeCount++
            return formatResponse.toolError(`MCP server '${server_name}' is not enabled for this task.`)
        }

        config.taskState.consecutiveMistakeCount = 0

        // Handle approval flow
        const completeMessage = accessMcpResourceMessage(server_name, uri)

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

        // Preserve the result items as one response group so the Webview can
        // present them in one collapsible card attached to this request.
        const responseItems = resourceResult?.contents.map((item) => item.text || "").filter(Boolean) ?? []
        if (responseItems.length === 0) responseItems.push("(Empty response)")
        const resourceResultPretty = responseItems.join("\n\n")

        await config.callbacks.say(
            "mcp_server_response",
            JSON.stringify({
                type: "mcp_server_response",
                requestTs,
                responses: responseItems,
            } satisfies UiSayMcpServerResponse),
        )

        const truncatedResult = boundToolText(
            { body: resourceResultPretty },
            { strategy: "headTail", maxBytes: resolveSelfBoundResultBytes(config.contextBudget) },
        )

        // Return formatted result
        return formatResponse.toolResult(truncatedResult)
    }
}

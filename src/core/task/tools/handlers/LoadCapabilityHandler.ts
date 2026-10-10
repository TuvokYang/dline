import type { ToolUse } from "@core/assistant-message"
import {
    buildLoadToolName,
    createLoadingPayload,
    type LoadCapabilityKind,
    type LoadCapabilityPayload,
} from "@shared/load-capabilities"
import type { ClineToolResponseContent } from "@shared/messages/content"
import { ClineDefaultTool } from "@/shared/tools"
import { LoadCapabilityService } from "../load-capabilities/LoadCapabilityService"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"

/**
 * Fully managed handler for stable read-only load_xxx capability tools.
 */
export class LoadCapabilityHandler {
    private readonly service: LoadCapabilityService

    /**
     * Create a handler for one stable load capability tool.
     *
     * @param name Stable Cline tool identifier.
     * @param kind Capability family loaded by this handler.
     * @param service Optional service override for tests.
     */
    constructor(
        readonly name: ClineDefaultTool,
        private readonly kind: LoadCapabilityKind,
        service = new LoadCapabilityService(),
    ) {
        this.service = service
    }

    /**
     * Describe this tool call in execution summaries.
     *
     * @param block Parsed tool use block.
     * @returns Short human-readable description.
     */
    getDescription(block: ToolUse): string {
        return `[${block.name} for '${block.params.name ?? ""}']`
    }

    /**
     * Render a loading row while the model streams the tool call.
     *
     * @param block Parsed partial tool use block.
     * @param uiHelpers UI helper facade.
     */
    async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
        if (uiHelpers.getConfig().isSubagentExecution) {
            return
        }
        const payload = createLoadingPayload(this.kind, block.params.name ?? "")
        await uiHelpers.say("tool", JSON.stringify(payload), undefined, undefined, true, block.ts)
    }

    /**
     * Execute the read-only load operation and publish a structured Webview payload.
     *
     * @param config Runtime task configuration.
     * @param block Parsed tool use block.
     * @returns Textual tool result for the model.
     */
    async execute(config: TaskConfig, block: ToolUse): Promise<ClineToolResponseContent> {
        const requestedName = block.params.name?.trim()
        if (!requestedName) {
            config.taskState.consecutiveMistakeCount++
            return await config.callbacks.sayAndCreateMissingParamError(block.name, "name", undefined, block.ts)
        }

        const payload = await this.service.load(this.kind, requestedName, config)
        if (!config.isSubagentExecution) {
            await config.callbacks.say("tool", JSON.stringify(payload), undefined, undefined, false, block.ts)
        }

        if (payload.status === "failed") {
            config.taskState.consecutiveMistakeCount++
        } else {
            config.taskState.consecutiveMistakeCount = 0
        }

        return this.formatResult(payload)
    }

    /**
     * Format a structured payload into model-facing text.
     *
     * @param payload Structured load result payload.
     * @returns Markdown text for the tool result.
     */
    private formatResult(payload: LoadCapabilityPayload): string {
        if (payload.status === "failed") {
            return `Error: ${payload.error ?? `Unable to load ${buildLoadToolName(payload.kind)} '${payload.name}'.`}`
        }

        const detailLines = (payload.details ?? []).map((detail) => {
            const value = typeof detail.value === "string" ? detail.value : JSON.stringify(detail.value, null, 2)
            return `- ${detail.label}: ${value}`
        })
        const sections = [
            `# Loaded ${payload.kind}: ${payload.name}`,
            payload.summary ?? "No summary provided.",
            detailLines.join("\n"),
        ].filter(Boolean)

        if (payload.body) {
            sections.push(payload.kind === "workflow" ? `## Procedure\n${payload.body}` : `## Instructions\n${payload.body}`)
        }
        if (payload.kind === "skill") {
            sections.push(
                `Follow these instructions directly for the current task. Do not call load_skill again for '${payload.name}'.`,
            )
        } else if (payload.kind === "workflow") {
            sections.push(`Follow these steps in order. Do not call load_workflow again for '${payload.name}'.`)
        } else {
            sections.push("This metadata load did not execute the MCP tool. Use use_mcp_tool if execution is required.")
        }

        return sections.join("\n\n")
    }
}

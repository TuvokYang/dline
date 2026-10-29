export interface McpToolApprovalConfig {
    autoApprove?: string[]
    disabledAutoApprove?: string[]
}

export interface McpToolApprovalDecision {
    forceApprove: boolean
    globalEnabled: boolean
    toolEnabled: boolean
}

/** Resolve the final MCP approval decision from override, category, and tool gates. */
export function isMcpToolAutoApproved(decision: McpToolApprovalDecision): boolean {
    return decision.forceApprove || (decision.globalEnabled && decision.toolEnabled)
}

/** Project persisted MCP approval settings into one tool's Configure state. */
export function resolveMcpToolAutoApprove(config: McpToolApprovalConfig, toolName: string): boolean {
    if (config.disabledAutoApprove) {
        return !config.disabledAutoApprove.includes(toolName)
    }
    if (config.autoApprove) {
        return config.autoApprove.includes(toolName)
    }
    return true
}

/** Update per-tool approval state while migrating legacy allowlists to the deny-list model. */
export function updateMcpToolAutoApproveConfig(
    config: McpToolApprovalConfig,
    toolNames: readonly string[],
    shouldAllow: boolean,
    availableToolNames: readonly string[],
): McpToolApprovalConfig {
    const disabled = new Set(
        config.disabledAutoApprove ??
            (config.autoApprove ? availableToolNames.filter((toolName) => !config.autoApprove?.includes(toolName)) : []),
    )

    for (const toolName of toolNames) {
        if (shouldAllow) {
            disabled.delete(toolName)
        } else {
            disabled.add(toolName)
        }
    }

    return { disabledAutoApprove: [...disabled].sort() }
}

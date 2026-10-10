import { ClineDefaultTool } from "@shared/tools"
import type { ExplicitInstructionPolicy, ExplicitInstructionType } from "./types"

const POLICIES: Readonly<Record<ExplicitInstructionType, ExplicitInstructionPolicy>> = Object.freeze({
    summarize_task: {
        type: "summarize_task",
        authorizesTool: true,
        targetTool: ClineDefaultTool.SUMMARIZE_TASK,
        allowRetry: true,
        allowPartialPresentation: true,
    },
    new_task: {
        type: "new_task",
        authorizesTool: true,
        targetTool: ClineDefaultTool.NEW_TASK,
        allowRetry: false,
        allowPartialPresentation: true,
    },
    new_rule: {
        type: "new_rule",
        authorizesTool: true,
        targetTool: ClineDefaultTool.NEW_RULE,
        allowRetry: false,
        allowPartialPresentation: true,
    },
    report_bug: {
        type: "report_bug",
        authorizesTool: true,
        targetTool: ClineDefaultTool.REPORT_BUG,
        allowRetry: false,
        allowPartialPresentation: true,
    },
    explain_changes: {
        type: "explain_changes",
        authorizesTool: true,
        targetTool: ClineDefaultTool.GENERATE_EXPLANATION,
        allowRetry: false,
        allowPartialPresentation: true,
    },
    "deep-planning": {
        type: "deep-planning",
        authorizesTool: true,
        targetTool: ClineDefaultTool.NEW_TASK,
        allowRetry: false,
        allowPartialPresentation: true,
    },
    skill: {
        type: "skill",
        authorizesTool: false,
        allowRetry: false,
        allowPartialPresentation: false,
    },
    workflow: {
        type: "workflow",
        authorizesTool: false,
        allowRetry: false,
        allowPartialPresentation: false,
    },
    continuation: {
        type: "continuation",
        authorizesTool: false,
        allowRetry: false,
        allowPartialPresentation: false,
    },
})

export function getExplicitInstructionPolicy(type: ExplicitInstructionType): ExplicitInstructionPolicy {
    return POLICIES[type]
}

export function isExplicitOnlyTool(tool: ClineDefaultTool): boolean {
    return Object.values(POLICIES).some((policy) => policy.authorizesTool && policy.targetTool === tool)
}

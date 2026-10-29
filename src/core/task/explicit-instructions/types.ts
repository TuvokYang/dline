import type { DlineDefaultTool } from "@shared/tools"

export type ExplicitInstructionType =
    | "summarize_task"
    | "new_task"
    | "new_rule"
    | "report_bug"
    | "explain_changes"
    | "deep-planning"
    | "skill"
    | "workflow"
    | "continuation"

export type ExplicitInstructionSource =
    | "auto_compaction"
    | "manual_compact_command"
    | "task_header"
    | "profile_switch"
    | "mode_switch"
    | "slash_command"
    | "skill_injection"
    | "workflow_injection"
    | "internal_continuation"

export type ExplicitInstructionState = "pending" | "consumed" | "expired" | "cancelled"

export interface ExplicitInstructionAuthorization {
    readonly instructionId: string
    readonly requestId: string
    readonly attemptId: string
    readonly operationId?: string
    readonly type: ExplicitInstructionType
    readonly source: ExplicitInstructionSource
    readonly targetTool?: DlineDefaultTool
    readonly metadata?: Readonly<Record<string, string>>
    readonly state: ExplicitInstructionState
}

export interface ExplicitInstructionDeclaration {
    readonly type: ExplicitInstructionType
    readonly source: ExplicitInstructionSource
    readonly targetTool?: DlineDefaultTool
    readonly operationId?: string
    readonly metadata?: Readonly<Record<string, string>>
}

export interface ExplicitInstructionRequestIdentity {
    readonly requestId: string
    readonly attemptId: string
}

export interface RegisterExplicitInstructionInput {
    readonly requestId: string
    readonly attemptId: string
    readonly operationId?: string
    readonly type: ExplicitInstructionType
    readonly source: ExplicitInstructionSource
    readonly targetTool?: DlineDefaultTool
    readonly metadata?: Readonly<Record<string, string>>
}

export interface ConsumeExplicitToolInput extends ExplicitInstructionRequestIdentity {
    readonly targetTool: DlineDefaultTool
}

export interface ExplicitInstructionConsumePort {
    readonly identity: ExplicitInstructionRequestIdentity
    getPendingToolAuthorization(targetTool: DlineDefaultTool): ExplicitInstructionAuthorization | undefined
    consumeTool(targetTool: DlineDefaultTool): ConsumeExplicitInstructionResult
}

export interface ConsumeExplicitInstructionInput {
    readonly instructionId: string
    readonly requestId: string
    readonly attemptId: string
    readonly type: ExplicitInstructionType
    readonly source: ExplicitInstructionSource
    readonly targetTool: DlineDefaultTool
}

export type ExplicitInstructionFailureCode =
    | "explicit_instruction_retired"
    | "explicit_instruction_missing"
    | "explicit_instruction_type_mismatch"
    | "explicit_instruction_source_mismatch"
    | "explicit_instruction_tool_mismatch"
    | "explicit_instruction_request_mismatch"
    | "explicit_instruction_attempt_mismatch"
    | "explicit_instruction_already_consumed"
    | "explicit_instruction_expired"
    | "explicit_instruction_cancelled"

export type ConsumeExplicitInstructionResult =
    | { readonly ok: true; readonly authorization: ExplicitInstructionAuthorization }
    | { readonly ok: false; readonly code: ExplicitInstructionFailureCode }

export interface ExplicitInstructionPolicy {
    readonly type: ExplicitInstructionType
    readonly authorizesTool: boolean
    readonly targetTool?: DlineDefaultTool
    readonly allowRetry: boolean
    readonly allowPartialPresentation: boolean
}

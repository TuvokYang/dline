import type { Mode } from "./storage/types"

/** Backend phases projected for one explicit task-local Profile transition. */
export type ProfileSwitchPhase = "idle" | "preflighting" | "awaiting_confirmation" | "compacting" | "committing" | "failed"

/** Immediate result statuses returned by Profile transition operations. */
export type ProfileSwitchRequestStatus = "switched" | "confirmation_required" | "in_progress" | "rejected"

/** Read-only Profile transaction state; never contains credentials or a live handler. */
export interface ProfileSwitchSnapshot {
    phase: ProfileSwitchPhase
    operationId?: string
    taskId?: string
    activeMode?: Mode
    targetModes?: Mode[]
    sourceProfile?: string
    targetProfile?: string
    /** Whether the target binding was durably adopted before a later compaction failure. */
    targetAdopted?: boolean
    /** Model id used by the frozen target handler for any required compaction. */
    compactionModel?: string
    currentTokens?: number
    targetContextWindow?: number
    fittingExitTarget?: number
    error?: string
}

/** Typed outcome returned when requesting, confirming, or cancelling a Profile switch. */
export interface ProfileSwitchRequestResult {
    status: ProfileSwitchRequestStatus
    operationId?: string
    error?: string
    /** Set on a switch that carried a draft: whether the awaiting dialog took it as its reply. */
    draftDelivered?: boolean
}

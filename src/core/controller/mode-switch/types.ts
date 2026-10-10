import type { ApiHandler } from "@core/api"
import type { ChatContent } from "@shared/ChatContent"
import type { Mode } from "@shared/storage/types"

export type { ContextPressureReader, TaskCompactionPort } from "@core/controller/context-transition/types"

/** Effective task-local profile information for one mode. */
export interface ResolvedModeProfile {
    mode: Mode
    profileId: string
    profile: string
    contextWindow: number
    /** Exact projected-usage boundary where target-profile compaction starts. */
    triggerTokens: number
    /** Strict fitting exit target resolved from the same target scope as the actual compaction. */
    fittingExitTarget: number
    /** In-memory handler frozen for a pending target transition; never persisted. */
    executionApi?: ApiHandler
}

/** Resolve effective source and target profiles without Webview dependencies. */
export interface ModeProfileResolver {
    getSource(): ResolvedModeProfile | undefined
    resolve(mode: Mode): ResolvedModeProfile | undefined
}

/** Validate and atomically commit one task-local target mode. */
export interface ModeCommitPort {
    validate(operation: ModeSwitchOperation): boolean
    commit(operation: ModeSwitchOperation): Promise<void>
}

/** User request to switch one task to a target mode. */
export interface ModeSwitchRequest {
    taskId: string
    targetMode: Mode
    chatContent?: ChatContent
}

/** Immutable internal transaction data retained across confirmation. */
export interface ModeSwitchOperation {
    operationId: string
    taskId: string
    source: ResolvedModeProfile
    target: ResolvedModeProfile & { executionApi: ApiHandler }
    /** Complete target-candidate projection retained for confirmation UI. */
    currentTokens: number
    triggerTokens: number
    chatContent?: ChatContent
}

import type { ApiHandler } from "@core/api"
import type { ChatContent } from "@shared/ChatContent"
import type { Mode } from "@shared/storage/types"

/** Frozen target Profile handler and effective window for the active task mode. */
export interface ResolvedProfileTarget {
    profileId: string
    profile: string
    mode: Mode
    contextWindow: number
    /** Exact projected-usage boundary where target-profile compaction starts. */
    triggerTokens: number
    /** Strict fitting exit target resolved from the same target scope as the actual compaction. */
    fittingExitTarget: number
    executionApi: ApiHandler
}

/**
 * Report the context window the live indicator already attributes to this task.
 *
 * Selecting a Profile only rebinds which handler the task uses, so the advisory
 * window check must stay a pure comparison against an already-maintained number.
 * Rebuilding a full target request here would turn an optional hint into a
 * mandatory, throwing precondition that blocks the switch outright.
 */
export interface OccupiedContextWindowReader {
    getOccupiedTokens(): number
}

/** Resolve task-local source bindings and a detached target handler. */
export interface ProfileBindingResolver {
    getCurrentMode(): Mode
    getBinding(mode: Mode): string | undefined
    resolveTarget(profileId: string, profileName: string, mode: Mode): ResolvedProfileTarget | undefined
}

/** Validate and atomically commit one or both task-local Profile bindings. */
export interface ProfileCommitPort {
    validate(operation: ProfileSwitchOperation): boolean
    commit(operation: ProfileSwitchOperation): Promise<void>
}

/** User request to change one or both task-local Profile bindings. */
export interface ProfileSwitchRequest {
    taskId: string
    targetProfileId: string
    targetProfile: string
    targetModes: Mode[]
    chatContent?: ChatContent
}

/** Immutable transaction data retained through the advisory confirmation. */
export interface ProfileSwitchOperation {
    operationId: string
    taskId: string
    activeMode: Mode
    sourceBindings: Partial<Record<Mode, string>>
    targetProfileId: string
    targetProfile: string
    targetModes: Mode[]
    activeTarget?: ResolvedProfileTarget
    currentTokens?: number
    chatContent?: ChatContent
}

/** Narrow dependencies required by the Profile transaction state machine. */
export interface ProfileSwitchDependencies {
    bindings: ProfileBindingResolver
    occupied: OccupiedContextWindowReader
    commit: ProfileCommitPort
    lease: import("@core/controller/context-transition/ContextTransitionLease").ContextTransitionLease
    postState: () => Promise<void>
    createId: () => string
    getTaskId: () => string | undefined
}

import type {
    OccupiedContextWindowReader,
    ProfileBindingResolver,
    ProfileCommitPort,
    ProfileSwitchOperation,
    ProfileSwitchRequest,
} from "@core/controller/profile-switch/types"
import type { ProfileSwitchSnapshot } from "@shared/profile-switch"
import type { Mode } from "@shared/storage/types"
import type {
    ContextTransitionPhase,
    ContextTransitionPolicy,
    ContextTransitionPreparation,
    ContextTransitionSnapshotContext,
} from "../ContextTransitionEngine"

export interface ProfileTransitionPolicyDeps {
    bindings: ProfileBindingResolver
    occupied: OccupiedContextWindowReader
    commit: ProfileCommitPort
    getTaskId: () => string | undefined
}

/**
 * Rebind task-local Profile handlers with at most one advisory window notice.
 *
 * A Profile switch never compacts and never runs a target projection: it only
 * compares the already-occupied context window against the target window so the
 * user can acknowledge a tight fit. Every unresolved detail degrades to a direct
 * switch, because nothing in this policy may block the rebind.
 */
export class ProfileTransitionPolicy
    implements ContextTransitionPolicy<ProfileSwitchRequest, ProfileSwitchOperation, ProfileSwitchSnapshot>
{
    readonly kind = "profile" as const
    readonly confirmationOrder = "commit_then_compact" as const

    constructor(private readonly deps: ProfileTransitionPolicyDeps) {}

    async prepare(
        input: ProfileSwitchRequest,
        operationId: string,
    ): Promise<ContextTransitionPreparation<ProfileSwitchOperation>> {
        if (this.deps.getTaskId() !== input.taskId) {
            return { kind: "rejected", error: "Active task changed before Profile switch request." }
        }
        const targetModes = normalizeTargetModes(input.targetModes)
        if (!input.targetProfileId || !input.targetProfile || targetModes.length === 0) {
            return { kind: "rejected", error: "Profile switch requires a resolved target Profile and at least one target mode." }
        }
        const activeMode = this.deps.bindings.getCurrentMode()
        const operation: ProfileSwitchOperation = {
            operationId,
            taskId: input.taskId,
            activeMode,
            sourceBindings: collectSourceBindings(targetModes, this.deps.bindings.getBinding),
            targetProfileId: input.targetProfileId,
            targetProfile: input.targetProfile,
            targetModes,
            chatContent: input.chatContent,
        }
        if (!targetModes.includes(activeMode)) return { kind: "direct", operation }

        const target = this.deps.bindings.resolveTarget(input.targetProfileId, input.targetProfile, activeMode)
        if (!target || target.contextWindow <= 0) return { kind: "direct", operation }
        operation.activeTarget = target
        operation.currentTokens = this.deps.occupied.getOccupiedTokens()
        const doesNotFit = operation.currentTokens >= target.contextWindow
        return doesNotFit ? { kind: "confirm", operation } : { kind: "direct", operation }
    }

    validate(operation: ProfileSwitchOperation): boolean {
        return this.deps.getTaskId() === operation.taskId && this.deps.commit.validate(operation)
    }

    commit(operation: ProfileSwitchOperation): Promise<void> {
        return this.deps.commit.commit(operation)
    }

    createSnapshot(
        operation: ProfileSwitchOperation,
        phase: ContextTransitionPhase,
        error?: string,
        context?: ContextTransitionSnapshotContext,
    ): ProfileSwitchSnapshot {
        const target = operation.activeTarget
        return {
            phase,
            operationId: operation.operationId,
            taskId: operation.taskId,
            activeMode: operation.activeMode,
            targetModes: [...operation.targetModes],
            sourceProfile: operation.sourceBindings[operation.activeMode],
            targetProfile: operation.targetProfile,
            targetAdopted: context?.targetAdopted,
            compactionModel: target?.executionApi?.getModel?.()?.id,
            currentTokens: operation.currentTokens,
            targetContextWindow: target?.contextWindow,
            fittingExitTarget: target?.fittingExitTarget,
            ...(error ? { error } : {}),
        }
    }

    cancelledError(): string {
        return "Profile switch cancelled."
    }

    staleConfirmationError(): string {
        return "Profile switch confirmation is stale."
    }

    staleCancellationError(): string {
        return "Profile switch cancellation is stale."
    }

    stateChangedError(): string {
        return "Profile switch state changed before commit."
    }
}

function normalizeTargetModes(modes: readonly Mode[]): Mode[] {
    return [...new Set(modes)]
}

function collectSourceBindings(
    modes: readonly Mode[],
    getBinding: (mode: Mode) => string | undefined,
): Partial<Record<Mode, string>> {
    const bindings: Partial<Record<Mode, string>> = {}
    for (const mode of modes) {
        const binding = getBinding(mode)
        if (binding !== undefined) bindings[mode] = binding
    }
    return bindings
}

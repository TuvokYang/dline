import { decideContextTransition } from "@core/context/context-management/context-transition-preflight"
import type {
    ContextPressureReader,
    ModeCommitPort,
    ModeProfileResolver,
    ModeSwitchOperation,
    ModeSwitchRequest,
} from "@core/controller/mode-switch/types"
import type { ModeSwitchSnapshot } from "@shared/mode-switch"
import type {
    ContextTransitionCompactionRequest,
    ContextTransitionPhase,
    ContextTransitionPolicy,
    ContextTransitionPreparation,
    ContextTransitionSnapshotContext,
} from "../ContextTransitionEngine"

export interface ModeTransitionPolicyDeps {
    profiles: ModeProfileResolver
    pressure: ContextPressureReader
    commit: ModeCommitPort
    getTaskId: () => string | undefined
}

/** Express Mode-specific target resolution and final adoption only. */
export class ModeTransitionPolicy implements ContextTransitionPolicy<ModeSwitchRequest, ModeSwitchOperation, ModeSwitchSnapshot> {
    readonly kind = "mode" as const
    readonly confirmationOrder = "compact_then_commit" as const

    constructor(private readonly deps: ModeTransitionPolicyDeps) {}

    /** Resolve same-Profile split modes without acquiring the shared transition lease or projecting context pressure. */
    prepareWithoutLease(input: ModeSwitchRequest, operationId: string): ModeSwitchOperation | undefined {
        if (this.deps.getTaskId() !== input.taskId) {
            throw new Error("Active task changed before mode switch request.")
        }
        const source = this.deps.profiles.getSource()
        const target = this.deps.profiles.resolve(input.targetMode)
        const executionApi = target?.executionApi
        if (!source || !target || !executionApi || source.profileId !== target.profileId) return undefined
        return {
            operationId,
            taskId: input.taskId,
            source,
            target: { ...target, executionApi },
            currentTokens: 0,
            triggerTokens: target.triggerTokens,
            chatContent: input.chatContent,
        }
    }

    async prepare(input: ModeSwitchRequest, operationId: string): Promise<ContextTransitionPreparation<ModeSwitchOperation>> {
        if (this.deps.getTaskId() !== input.taskId) {
            return { kind: "rejected", error: "Active task changed before mode switch request." }
        }
        const source = this.deps.profiles.getSource()
        const target = this.deps.profiles.resolve(input.targetMode)
        const executionApi = target?.executionApi
        if (!source || !target || !executionApi || source.contextWindow <= 0 || target.contextWindow <= 0) {
            return { kind: "rejected", error: "Unable to resolve effective mode profiles, target handler, and context windows." }
        }
        const operation: ModeSwitchOperation = {
            operationId,
            taskId: input.taskId,
            source,
            target: { ...target, executionApi },
            currentTokens: await this.deps.pressure.read(executionApi, target.mode, input.chatContent),
            triggerTokens: target.triggerTokens,
            chatContent: input.chatContent,
        }
        if (this.deps.getTaskId() !== input.taskId) {
            return { kind: "rejected", error: "Active task changed during target projection." }
        }
        const decision = decideContextTransition({
            projectedUsageTokens: operation.currentTokens,
            targetContextWindow: target.triggerTokens,
        })
        return decision.kind === "confirm" ? { kind: "confirm", operation } : { kind: "direct", operation }
    }

    validate(operation: ModeSwitchOperation): boolean {
        return this.deps.getTaskId() === operation.taskId && this.deps.commit.validate(operation)
    }

    createCompactionRequest(operation: ModeSwitchOperation): ContextTransitionCompactionRequest {
        return {
            operationId: operation.operationId,
            targetApi: operation.target.executionApi,
            targetMode: operation.target.mode,
            chatContent: operation.chatContent,
            transition: {
                kind: "mode_switch",
                operationId: operation.operationId,
                phase: "compacting",
                source: {
                    mode: operation.source.mode,
                    profile: operation.source.profile,
                    contextWindow: operation.source.contextWindow,
                },
                target: {
                    mode: operation.target.mode,
                    profile: operation.target.profile,
                    contextWindow: operation.target.contextWindow,
                },
                // A copy of the whole draft, its document included, so the transition
                // record never describes a draft other than the one being carried.
                chatContent: operation.chatContent
                    ? {
                          ...operation.chatContent,
                          images: [...(operation.chatContent.images ?? [])],
                          files: [...(operation.chatContent.files ?? [])],
                      }
                    : undefined,
            },
        }
    }

    commit(operation: ModeSwitchOperation): Promise<void> {
        return this.deps.commit.commit(operation)
    }

    createSnapshot(
        operation: ModeSwitchOperation,
        phase: ContextTransitionPhase,
        error?: string,
        _context?: ContextTransitionSnapshotContext,
    ): ModeSwitchSnapshot {
        return {
            phase,
            operationId: operation.operationId,
            taskId: operation.taskId,
            sourceMode: operation.source.mode,
            targetMode: operation.target.mode,
            sourceProfile: operation.source.profile,
            targetProfile: operation.target.profile,
            compactionModel: operation.target.executionApi.getModel?.()?.id,
            sourceContextWindow: operation.source.contextWindow,
            targetContextWindow: operation.target.contextWindow,
            fittingExitTarget: operation.target.fittingExitTarget,
            currentTokens: operation.currentTokens,
            triggerTokens: operation.triggerTokens,
            ...(error ? { error } : {}),
        }
    }

    cancelledError(): string {
        return "Mode switch cancelled."
    }

    compactionError(result: "cancelled" | "failed"): string {
        return result === "cancelled" ? "Mode switch compaction cancelled." : "Mode switch compaction failed."
    }

    staleConfirmationError(): string {
        return "Mode switch confirmation is stale."
    }

    staleCancellationError(): string {
        return "Mode switch cancellation is stale."
    }

    stateChangedError(): string {
        return "Mode switch state changed before commit."
    }
}

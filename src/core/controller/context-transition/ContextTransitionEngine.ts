import type { ApiHandler } from "@core/api"
import type { TaskCompactionPort } from "@core/controller/context-transition/types"
import type { ContextCompactionTransitionState } from "@core/task/ContextCompactionSession"
import type { ChatContent } from "@shared/ChatContent"
import type { Mode } from "@shared/storage/types"
import type { ContextTransitionKind, ContextTransitionLease } from "./ContextTransitionLease"

export type ContextTransitionPhase = "idle" | "preflighting" | "awaiting_confirmation" | "compacting" | "committing" | "failed"
export type ContextTransitionRequestStatus = "switched" | "confirmation_required" | "in_progress" | "rejected"
export type ContextTransitionCompactionResult = "completed" | "cancelled" | "failed"
export type ContextTransitionConfirmationOrder = "compact_then_commit" | "commit_then_compact"

export interface ContextTransitionSnapshotContext {
    targetAdopted: boolean
}

export interface ContextTransitionRequest {
    taskId: string
}

export interface ContextTransitionOperation {
    operationId: string
    taskId: string
}

export interface ContextTransitionSnapshot {
    phase: ContextTransitionPhase
    operationId?: string
    taskId?: string
    error?: string
}

export interface ContextTransitionRequestResult {
    status: ContextTransitionRequestStatus
    operationId?: string
    error?: string
}

export interface ContextTransitionCompactionRequest {
    operationId: string
    targetApi: ApiHandler
    targetMode: Mode
    chatContent?: ChatContent
    transition: ContextCompactionTransitionState
}

export type ContextTransitionPreparation<Operation extends ContextTransitionOperation> =
    | { kind: "rejected"; error: string }
    | { kind: "direct"; operation: Operation }
    | { kind: "confirm"; operation: Operation }

export interface ContextTransitionPolicy<
    Request extends ContextTransitionRequest,
    Operation extends ContextTransitionOperation,
    Snapshot extends ContextTransitionSnapshot,
> {
    readonly kind: ContextTransitionKind
    readonly confirmationOrder: ContextTransitionConfirmationOrder
    prepareWithoutLease?(request: Request, operationId: string): Operation | undefined
    prepare(request: Request, operationId: string): Promise<ContextTransitionPreparation<Operation>>
    validate(operation: Operation): boolean
    /**
     * Describe the compaction this transition must run after confirmation.
     *
     * Policies that only need an advisory confirmation omit this member: the
     * engine then commits directly, so an acknowledged notice can never pull the
     * transition into a compaction it did not ask for.
     */
    createCompactionRequest?(operation: Operation): ContextTransitionCompactionRequest
    commit(operation: Operation): Promise<void>
    createSnapshot(
        operation: Operation,
        phase: ContextTransitionPhase,
        error?: string,
        context?: ContextTransitionSnapshotContext,
    ): Snapshot
    cancelledError(): string
    compactionError?(result: Exclude<ContextTransitionCompactionResult, "completed">): string
    staleConfirmationError(): string
    staleCancellationError(): string
    stateChangedError(): string
}

interface ActiveTransition {
    kind: ContextTransitionKind
    operationId: string
    taskId: string
    phase: Exclude<ContextTransitionPhase, "idle" | "failed">
    operation?: ContextTransitionOperation
    policy: ContextTransitionPolicy<ContextTransitionRequest, ContextTransitionOperation, ContextTransitionSnapshot>
    compactionStarted: boolean
    compactionCompleted: boolean
    targetAdopted: boolean
}

export interface ContextTransitionEngineDeps {
    lease: ContextTransitionLease
    compaction: TaskCompactionPort
    postState: () => Promise<void>
    createId: () => string
}

/** Own the only Profile/Mode transition operation and phase state. */
export class ContextTransitionEngine {
    private active: ActiveTransition | undefined
    private directCommit: { operationId: string; taskId: string } | undefined
    private readonly snapshots: Record<ContextTransitionKind, ContextTransitionSnapshot> = {
        mode: { phase: "idle" },
        profile: { phase: "idle" },
    }

    constructor(private readonly deps: ContextTransitionEngineDeps) {}

    async request<
        Request extends ContextTransitionRequest,
        Operation extends ContextTransitionOperation,
        Snapshot extends ContextTransitionSnapshot,
    >(policy: ContextTransitionPolicy<Request, Operation, Snapshot>, request: Request): Promise<ContextTransitionRequestResult> {
        if (this.snapshots[policy.kind].phase === "failed") {
            await this.publish(policy.kind, { phase: "idle" })
        }
        if (this.active) {
            return { status: "in_progress", operationId: this.active.operationId }
        }
        if (this.directCommit) {
            return { status: "in_progress", operationId: this.directCommit.operationId }
        }
        const leaseOwner = this.deps.lease.getActive()
        if (leaseOwner) {
            return { status: "in_progress", operationId: leaseOwner.operationId }
        }

        const operationId = this.deps.createId()
        if (policy.prepareWithoutLease) {
            try {
                const directOperation = policy.prepareWithoutLease(request, operationId)
                if (directOperation) {
                    if (!policy.validate(directOperation)) {
                        return { status: "rejected", operationId, error: policy.stateChangedError() }
                    }
                    this.directCommit = { operationId, taskId: request.taskId }
                    try {
                        await policy.commit(directOperation)
                        return { status: "switched", operationId }
                    } finally {
                        if (this.directCommit?.operationId === operationId) this.directCommit = undefined
                    }
                }
            } catch (error) {
                const reason = error instanceof Error ? error.message : "Context transition direct commit failed."
                return { status: "rejected", operationId, error: reason }
            }
        }
        if (!this.deps.lease.acquire({ kind: policy.kind, operationId, taskId: request.taskId })) {
            return { status: "in_progress", operationId: this.deps.lease.getActive()?.operationId }
        }
        const erasedPolicy = policy as unknown as ContextTransitionPolicy<
            ContextTransitionRequest,
            ContextTransitionOperation,
            ContextTransitionSnapshot
        >
        this.active = {
            kind: policy.kind,
            operationId,
            taskId: request.taskId,
            phase: "preflighting",
            policy: erasedPolicy,
            compactionStarted: false,
            compactionCompleted: false,
            targetAdopted: false,
        }
        await this.publish(policy.kind, {
            phase: "preflighting",
            operationId,
            taskId: request.taskId,
        })

        let preparation: ContextTransitionPreparation<Operation>
        try {
            preparation = await policy.prepare(request, operationId)
        } catch (error) {
            return this.failPreparation(policy.kind, operationId, request.taskId, error)
        }
        if (!this.isActive(operationId, policy.kind)) {
            // Preflight awaits an expensive context projection. Returning without discarding
            // the stale transition kept `active` and the shared lease pinned forever, so every
            // later request reported `in_progress` and the selector stayed disabled.
            await this.discardTransition(operationId, policy.kind)
            return { status: "rejected", operationId, error: "Context transition became stale during preflight." }
        }
        if (preparation.kind === "rejected") {
            return this.failPreparation(policy.kind, operationId, request.taskId, new Error(preparation.error))
        }

        this.active.operation = preparation.operation
        if (preparation.kind === "confirm") {
            this.active.phase = "awaiting_confirmation"
            await this.publish(
                policy.kind,
                policy.createSnapshot(preparation.operation, "awaiting_confirmation", undefined, {
                    targetAdopted: this.active.targetAdopted,
                }),
            )
            return { status: "confirmation_required", operationId }
        }
        return this.commitActive(policy, preparation.operation, false)
    }

    async confirm(operationId: string): Promise<ContextTransitionRequestResult> {
        const active = this.active
        if (!active || active.operationId !== operationId || active.phase !== "awaiting_confirmation" || !active.operation) {
            const policy = active?.policy
            return {
                status: "rejected",
                operationId,
                error: policy?.staleConfirmationError() ?? "Context transition confirmation is stale.",
            }
        }
        if (!this.deps.lease.owns(operationId) || !active.policy.validate(active.operation)) {
            return this.failActive(active.policy.stateChangedError(), false)
        }

        try {
            const createCompactionRequest = active.policy.createCompactionRequest?.bind(active.policy)
            if (active.policy.confirmationOrder === "commit_then_compact") {
                active.phase = "committing"
                await this.publish(
                    active.kind,
                    active.policy.createSnapshot(active.operation, "committing", undefined, {
                        targetAdopted: active.targetAdopted,
                    }),
                )
                await active.policy.commit(active.operation)
                active.targetAdopted = true
                if (!createCompactionRequest) {
                    await this.clearActive(active.operationId)
                    return { status: "switched", operationId: active.operationId }
                }
            }
            if (!createCompactionRequest) {
                return this.commitActive(active.policy, active.operation, false)
            }

            active.phase = "compacting"
            active.compactionStarted = true
            await this.publish(
                active.kind,
                active.policy.createSnapshot(active.operation, "compacting", undefined, {
                    targetAdopted: active.targetAdopted,
                }),
            )
            const compaction = createCompactionRequest(active.operation)
            const compactResult = await this.deps.compaction.compact({
                trigger: active.kind === "profile" ? "profile_switch" : "mode_switch",
                ...compaction,
            })
            if (compactResult !== "completed") {
                return this.failActive(
                    active.policy.compactionError?.(compactResult) ?? "Context transition compaction failed.",
                    true,
                )
            }
            active.compactionCompleted = true
            if (active.policy.confirmationOrder === "commit_then_compact") {
                await this.deps.compaction.complete(active.operationId)
                await this.clearActive(active.operationId)
                return { status: "switched", operationId: active.operationId }
            }
            return this.commitActive(active.policy, active.operation, true)
        } catch (error) {
            const reason = error instanceof Error ? error.message : "Context transition compaction failed."
            return this.failActive(reason, active.compactionStarted)
        }
    }

    async cancel(operationId: string): Promise<ContextTransitionRequestResult> {
        const active = this.active
        if (!active || active.operationId !== operationId || active.phase !== "awaiting_confirmation") {
            return {
                status: "rejected",
                operationId,
                error: active?.policy.staleCancellationError() ?? "Context transition cancellation is stale.",
            }
        }
        const error = active.policy.cancelledError()
        await this.clearActive(operationId)
        return { status: "rejected", operationId, error }
    }

    getSnapshot<Snapshot extends ContextTransitionSnapshot>(kind: ContextTransitionKind): Snapshot {
        return { ...this.snapshots[kind] } as Snapshot
    }

    async reset(reason = "Context transition reset."): Promise<void> {
        const active = this.active
        if (active?.operation) {
            await this.cleanupCompaction(active.operationId, reason)
        }
        if (active) {
            await this.clearActive(active.operationId)
            return
        }
        await Promise.all([this.publish("mode", { phase: "idle" }), this.publish("profile", { phase: "idle" })])
    }

    private async commitActive<Operation extends ContextTransitionOperation, Snapshot extends ContextTransitionSnapshot>(
        policy: ContextTransitionPolicy<ContextTransitionRequest, Operation, Snapshot>,
        operation: Operation,
        releaseBarrier: boolean,
    ): Promise<ContextTransitionRequestResult> {
        if (!this.isActive(operation.operationId, policy.kind) || !policy.validate(operation)) {
            return this.failActive(policy.stateChangedError(), releaseBarrier)
        }
        if (!this.active) {
            return { status: "rejected", operationId: operation.operationId, error: policy.stateChangedError() }
        }
        this.active.phase = "committing"
        await this.publish(policy.kind, policy.createSnapshot(operation, "committing"))
        try {
            await policy.commit(operation)
            if (releaseBarrier) await this.deps.compaction.complete(operation.operationId)
            await this.clearActive(operation.operationId)
            return { status: "switched", operationId: operation.operationId }
        } catch (error) {
            const reason = error instanceof Error ? error.message : "Context transition commit failed."
            const reportedReason = this.active?.compactionCompleted
                ? `Context compaction completed, but the ${policy.kind === "mode" ? "Mode" : "Profile"} transition commit failed: ${reason}`
                : reason
            return this.failActive(reportedReason, releaseBarrier)
        }
    }

    /**
     * Release a transition whose preflight threw, and keep the failure visible.
     *
     * Publishing `idle` here erased the reason from the shared snapshot, so a
     * rejected switch looked exactly like no request at all and the real cause
     * stayed invisible across several investigations.
     */
    private async failPreparation(
        kind: ContextTransitionKind,
        operationId: string,
        taskId: string,
        error: unknown,
    ): Promise<ContextTransitionRequestResult> {
        const reason = error instanceof Error ? error.message : "Context transition preflight failed."
        if (this.active?.operationId === operationId) this.active = undefined
        this.deps.lease.release(operationId)
        await this.publish(kind, { phase: "failed", operationId, taskId, error: reason })
        return { status: "rejected", operationId, error: reason }
    }

    private async failActive(reason: string, releaseBarrier: boolean): Promise<ContextTransitionRequestResult> {
        const active = this.active
        if (!active) {
            return { status: "rejected", error: reason }
        }
        if (!active.operation) {
            // A transition can fail validation before any operation is recorded. It still owns
            // the lease, so it must be discarded instead of leaving the engine permanently busy.
            await this.discardTransition(active.operationId, active.kind)
            return { status: "rejected", operationId: active.operationId, error: reason }
        }
        let reportedReason = reason
        try {
            if (releaseBarrier || active.compactionStarted) {
                const cleanupError = await this.cleanupCompaction(active.operationId, reason, active.compactionCompleted)
                if (cleanupError) reportedReason = `${reason} ${cleanupError}`
            }
        } finally {
            this.deps.lease.release(active.operationId)
            if (this.active === active) this.active = undefined
        }
        try {
            await this.publish(
                active.kind,
                active.policy.createSnapshot(active.operation, "failed", reportedReason, {
                    targetAdopted: active.targetAdopted,
                }),
            )
        } catch {
            // The transaction is already released; a later state publication can recover the view.
        }
        return { status: "rejected", operationId: active.operationId, error: reportedReason }
    }

    /** Best-effort compaction cleanup without allowing cleanup errors to retain the shared lease. */
    private async cleanupCompaction(operationId: string, reason: string, completed = false): Promise<string | undefined> {
        const failures: string[] = []
        if (!completed) {
            try {
                await this.deps.compaction.abort(operationId, reason)
            } catch (error) {
                failures.push(`Compaction abort failed: ${error instanceof Error ? error.message : String(error)}.`)
            }
        }
        try {
            await this.deps.compaction.complete(operationId)
        } catch (error) {
            failures.push(`Compaction completion failed: ${error instanceof Error ? error.message : String(error)}.`)
        }
        return failures.length ? failures.join(" ") : undefined
    }

    private isActive(operationId: string, kind: ContextTransitionKind): boolean {
        return this.active?.operationId === operationId && this.active.kind === kind && this.deps.lease.owns(operationId)
    }

    /**
     * Discard a transition that can no longer complete, whether or not it still owns the lease.
     *
     * `clearActive` intentionally ignores an operation that lost ownership, so a stale
     * transition needs this unconditional teardown to return the engine to idle.
     *
     * @param operationId The transition being discarded.
     * @param kind The transition kind whose published snapshot must return to idle.
     */
    private async discardTransition(operationId: string, kind: ContextTransitionKind): Promise<void> {
        if (this.active?.operationId === operationId) this.active = undefined
        this.deps.lease.release(operationId)
        await this.publish(kind, { phase: "idle" })
    }

    private async clearActive(operationId: string): Promise<void> {
        const active = this.active
        if (!active || active.operationId !== operationId) return
        this.active = undefined
        this.deps.lease.release(operationId)
        await this.publish(active.kind, { phase: "idle" })
    }

    private async publish(kind: ContextTransitionKind, snapshot: ContextTransitionSnapshot): Promise<void> {
        this.snapshots[kind] = { ...snapshot }
        await this.deps.postState()
    }
}

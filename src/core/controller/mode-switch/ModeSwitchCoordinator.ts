import { ContextTransitionEngine } from "@core/controller/context-transition/ContextTransitionEngine"
import type { ContextTransitionLease } from "@core/controller/context-transition/ContextTransitionLease"
import { ModeTransitionPolicy } from "@core/controller/context-transition/policies/ModeTransitionPolicy"
import type { ModeSwitchRequestResult, ModeSwitchSnapshot } from "@shared/mode-switch"
import type { ContextPressureReader, ModeCommitPort, ModeProfileResolver, ModeSwitchRequest, TaskCompactionPort } from "./types"

interface ModeSwitchDeps {
    profiles: ModeProfileResolver
    pressure: ContextPressureReader
    compaction: TaskCompactionPort
    commit: ModeCommitPort
    lease: ContextTransitionLease
    postState: () => Promise<void>
    createId: () => string
    getTaskId: () => string | undefined
}

export interface ModeSwitchAdapterDeps {
    engine: ContextTransitionEngine
    policy: ModeTransitionPolicy
}

/** Preserve the Mode RPC surface while delegating all transaction state to the shared engine. */
export class ModeSwitchCoordinator {
    private readonly engine: ContextTransitionEngine
    private readonly policy: ModeTransitionPolicy

    constructor(deps: ModeSwitchDeps | ModeSwitchAdapterDeps) {
        if ("engine" in deps) {
            this.engine = deps.engine
            this.policy = deps.policy
            return
        }
        this.engine = new ContextTransitionEngine({
            lease: deps.lease,
            compaction: deps.compaction,
            postState: deps.postState,
            createId: deps.createId,
        })
        this.policy = new ModeTransitionPolicy({
            profiles: deps.profiles,
            pressure: deps.pressure,
            commit: deps.commit,
            getTaskId: deps.getTaskId,
        })
    }

    /**
     * Request a direct or confirmation-gated mode switch.
     *
     * @param input Target mode, task identity, and pending draft content.
     * @returns Typed request status and operation identity.
     */
    async request(input: ModeSwitchRequest): Promise<ModeSwitchRequestResult> {
        return this.engine.request(this.policy, input)
    }

    /**
     * Confirm the active operation and compact before target-mode commit.
     *
     * @param operationId Operation identity returned by the original request.
     * @returns Typed terminal or rejected result.
     */
    async confirm(operationId: string): Promise<ModeSwitchRequestResult> {
        return this.engine.confirm(operationId)
    }

    /**
     * Cancel the active awaiting-confirmation operation.
     *
     * @param operationId Operation identity returned by the original request.
     * @returns Rejected cancellation result or stale-operation rejection.
     */
    async cancel(operationId: string): Promise<ModeSwitchRequestResult> {
        return this.engine.cancel(operationId)
    }

    /**
     * Return a detached read-only transaction snapshot.
     *
     * @returns Current task-local mode-switch state.
     */
    getSnapshot(): ModeSwitchSnapshot {
        return this.engine.getSnapshot<ModeSwitchSnapshot>("mode")
    }

    /**
     * Release resources and clear the active operation during task lifecycle cleanup.
     *
     * @param reason Optional internal reset reason.
     * @returns A promise that resolves after idle state is published.
     */
    async reset(reason = "Mode switch reset."): Promise<void> {
        await this.engine.reset(reason)
    }
}

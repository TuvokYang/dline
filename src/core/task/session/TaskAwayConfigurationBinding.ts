import { type AwayConfiguration, awayConfigurationEnabled } from "@shared/away"
import { isAway } from "../kernel/away"
import type { AwayConfigurationFact } from "../kernel/types"
import type { TaskRuntime } from "../runtime/TaskRuntime"

export interface AwayConfigurationSource {
    read(): AwayConfiguration
    subscribe(listener: (configuration: AwayConfiguration) => void): () => void
    reconcile(): Promise<AwayConfiguration>
}

/** Explicit host-to-kernel conversion; the kernel has no shared/host dependency. */
export function awayConfigurationFact(configuration: AwayConfiguration): AwayConfigurationFact {
    return {
        enabled: awayConfigurationEnabled(configuration),
        automatic: configuration.autoAwayModeEnabled,
        modeRevocation: configuration.revocations.mode,
        automaticRevocation: configuration.revocations.automatic,
    }
}

/** Subscription and permission fence only. TaskRuntime remains the sole mode/deadline writer. */
export class TaskAwayConfigurationBinding {
    private runtime?: TaskRuntime
    private closed = false
    private queue: Promise<void> = Promise.resolve()
    private readonly unsubscribe: () => void

    constructor(
        private readonly source: AwayConfigurationSource,
        private readonly report: (error: unknown) => void,
    ) {
        // Subscribe before the first snapshot, including read-only openings.
        this.unsubscribe = source.subscribe((configuration) => {
            if (this.closed) return
            this.runtime?.setAutomationPermissionFence(() => this.deadlinesPermitted())
            void this.enqueue(configuration).catch(this.report)
        })
    }

    bind(runtime: TaskRuntime): void {
        if (this.runtime) throw new Error("Away configuration is already bound")
        this.runtime = runtime
        runtime.setAutomationPermissionFence(() => this.deadlinesPermitted())
    }

    async reconcile(): Promise<void> {
        if (this.closed) return
        let configuration: AwayConfiguration
        try {
            configuration = await this.source.reconcile()
        } catch (error) {
            this.report(error)
            configuration = { ...this.source.read(), available: false }
        }
        await this.enqueue(configuration)
    }

    async activate(): Promise<void> {
        await this.reconcile()
        if (!this.closed && this.runtime?.isWritable()) this.runtime.allowRestoredCommands()
    }

    isActive(): boolean {
        const state = this.runtime?.getState()
        const current = this.source.read()
        return (
            !this.closed &&
            state !== undefined &&
            isAway(state) &&
            awayConfigurationEnabled(current) &&
            state.away?.mode?.modeRevocation === current.revocations.mode
        )
    }

    beginClose(): void {
        if (this.closed) return
        this.closed = true
        this.unsubscribe()
        this.runtime?.beginClose()
    }

    async release(): Promise<void> {
        this.beginClose()
        await this.queue
        await this.runtime?.disposeDeadlines()
    }

    private deadlinesPermitted(): boolean {
        const current = this.source.read()
        const committed = this.runtime?.getState().away?.configuration
        return (
            !this.closed &&
            awayConfigurationEnabled(current) &&
            committed !== undefined &&
            committed.modeRevocation === current.revocations.mode &&
            committed.automaticRevocation === current.revocations.automatic
        )
    }

    private enqueue(configuration: AwayConfiguration): Promise<void> {
        const operation = this.queue.then(async () => {
            const runtime = this.runtime
            if (this.closed || !runtime?.isWritable()) return
            const fact = awayConfigurationFact(configuration)
            const previous = runtime.getState().away?.configuration
            if (
                previous &&
                previous.enabled === fact.enabled &&
                previous.automatic === fact.automatic &&
                previous.modeRevocation === fact.modeRevocation &&
                previous.automaticRevocation === fact.automaticRevocation
            ) {
                await runtime.waitForDurable(runtime.getState().revision)
                return
            }
            const result = await runtime.submit({
                type: "away.configured",
                generation: runtime.getState().generation,
                configuration: fact,
            })
            if (result.kind === "rejected") throw new Error(`Away configuration rejected: ${result.diagnostic.code}`)
            await result.receipt.durable
        })
        this.queue = operation.catch(this.report)
        return operation
    }
}

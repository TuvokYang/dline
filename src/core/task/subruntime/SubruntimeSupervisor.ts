import type { ResourceBroker, ResourceKind, ResourceLease } from "../resources"

export interface SubruntimeInput {
    readonly subruntimeId: string
    readonly inputRef: string
    readonly resourceKinds: readonly ResourceKind[]
}

export interface SubruntimePort {
    run(input: {
        readonly subruntimeId: string
        readonly inputRef: string
        readonly resources: ResourceLease
        readonly signal: AbortSignal
    }): Promise<{ readonly resultRef: string }>
}

export interface SubruntimeHandle {
    readonly subruntimeId: string
    readonly completion: Promise<{ readonly resultRef: string }>
    cancel(reason?: string): boolean
}

interface ActiveSubruntime {
    readonly controller: AbortController
    readonly completion: Promise<{ readonly resultRef: string }>
}

export class SubruntimeSupervisor {
    private readonly active = new Map<string, ActiveSubruntime>()
    private fenced = false

    constructor(
        private readonly taskId: string,
        private readonly broker: ResourceBroker,
        private readonly port: SubruntimePort,
    ) {}

    async start(input: SubruntimeInput): Promise<SubruntimeHandle> {
        if (this.fenced) throw new Error("SubruntimeSupervisorFenced")
        if (this.active.has(input.subruntimeId)) throw new Error(`SubruntimeActive:${input.subruntimeId}`)
        const controller = new AbortController()
        const lease = await this.broker.acquire({ taskId: this.taskId, subruntimeId: input.subruntimeId }, input.resourceKinds)
        const completion = this.port
            .run({ subruntimeId: input.subruntimeId, inputRef: input.inputRef, resources: lease, signal: controller.signal })
            .finally(async () => {
                this.active.delete(input.subruntimeId)
                await lease.release()
            })
        this.active.set(input.subruntimeId, { controller, completion })
        return {
            subruntimeId: input.subruntimeId,
            completion,
            cancel: (reason = "subruntime_cancelled") => this.cancel(input.subruntimeId, reason),
        }
    }

    cancel(subruntimeId: string, reason = "subruntime_cancelled"): boolean {
        const active = this.active.get(subruntimeId)
        if (!active) return false
        active.controller.abort(reason)
        return true
    }

    fence(): void {
        this.fenced = true
    }

    stop(reason = "subruntime_stop"): void {
        for (const active of this.active.values()) active.controller.abort(reason)
    }

    async drain(): Promise<void> {
        await Promise.allSettled([...this.active.values()].map((active) => active.completion))
    }

    rearm(): void {
        if (this.active.size > 0) throw new Error("SubruntimeSupervisorNotDrained")
        this.fenced = false
    }

    get activeCount(): number {
        return this.active.size
    }
}

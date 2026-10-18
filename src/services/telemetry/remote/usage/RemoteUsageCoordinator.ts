import type { DeviceCredentialRepository } from "@/core/storage/telemetry-remote/DeviceCredentialRepository"
import type { LocalUsagePolicyInputs, RemotePolicyRepository } from "@/core/storage/telemetry-remote/RemotePolicyRepository"
import type { UsageObservationSpool } from "@/core/storage/telemetry-remote/UsageObservationSpool"
import type { UsageOutboxRepository } from "@/core/storage/telemetry-remote/UsageOutboxRepository"
import type { UsageSettlement, UsageSettlementPort } from "@/core/task/telemetry/UsageSettlement"
import { describeUsagePolicyDecision, type UsagePolicyRecord } from "../policy/usagePolicy"
import type { UsageCycleResult, UsageDeliveryWorker } from "./UsageDeliveryWorker"
import { projectUsageSettlement } from "./usageCatalog"
import { describeUsageCycle, type RemoteUsageLog, type RemoteUsageLogLevel } from "./usageCycleLog"

/** How often the lease holder seals shards and checks whether a batch or replay is due. */
export const USAGE_CYCLE_INTERVAL_MS = 30_000
/** Upper bound for each shutdown step, so a stalled disk or socket cannot hold the extension host. */
export const USAGE_SHUTDOWN_STEP_MS = 2_000

/** Timer seam; the default uses unref'd Node timers so delivery never keeps the host alive. */
export interface UsageScheduler {
    schedule(callback: () => void, delayMs: number): () => void
}

export interface RemoteUsageCoordinatorOptions {
    readonly policy: Pick<RemotePolicyRepository, "resolveUsage" | "recordServerStop">
    readonly credentials: Pick<DeviceCredentialRepository, "clearTokens">
    readonly outbox: Pick<UsageOutboxRepository, "reset">
    readonly spool: Pick<UsageObservationSpool, "append" | "purge">
    readonly worker: Pick<UsageDeliveryWorker, "runCycle" | "release">
    /** Current consent, organization, host and build inputs; read again before every decision. */
    readonly readPolicyInputs: () => Promise<LocalUsagePolicyInputs>
    readonly clock?: () => number
    readonly scheduler?: UsageScheduler
    readonly cycleIntervalMs?: number
    readonly log?: RemoteUsageLog
    /**
     * Called whenever {@link RemoteUsageCoordinator.reportingAllowed} changes, whoever
     * resolved the policy: startup, an explicit refresh, or a delivery cycle.
     * Disposal is not announced: one extension host shutting down does not
     * change whether this device may report.
     */
    readonly onReportingChanged?: (allowed: boolean) => void
}

/**
 * Lifecycle and composition of remote usage reporting in one extension host.
 *
 * It admits settled usage into this process's shard while the machine policy
 * allows it, runs the delivery cycle on a timer, turns a service refusal into a
 * persisted stop, and deletes unsent usage the moment reporting is no longer
 * allowed. Remote failures stay here: they never reach the Task or the local
 * telemetry pipeline.
 */
export class RemoteUsageCoordinator implements UsageSettlementPort {
    private readonly clock: () => number
    private readonly scheduler: UsageScheduler
    private readonly cycleIntervalMs: number
    private current: UsagePolicyRecord | undefined
    private accepting = false
    private disposed = false
    private cancelTimer: (() => void) | undefined
    private running: Promise<void> | undefined
    private cycleAbort: AbortController | undefined
    private refreshing: Promise<void> | undefined
    private readonly appends = new Set<Promise<void>>()
    /** Last steady cycle state printed, so a state that holds for hours is logged once. */
    private loggedSteadyState: string | undefined
    private ownedByNewerBuild = false

    constructor(private readonly options: RemoteUsageCoordinatorOptions) {
        this.clock = options.clock ?? Date.now
        this.scheduler = options.scheduler ?? nodeScheduler
        this.cycleIntervalMs = options.cycleIntervalMs ?? USAGE_CYCLE_INTERVAL_MS
    }

    /** Whether the current policy lets this device report usage; services that ride on that consent follow it. */
    get reportingAllowed(): boolean {
        return !this.disposed && this.current?.decision.allowed === true
    }

    /** Resolve the policy, open intake, and schedule the first cycle. */
    async start(): Promise<void> {
        await this.refresh()
        if (this.disposed) return
        this.accepting = true
        this.scheduleCycle(this.cycleIntervalMs)
    }

    /**
     * Admit one settled request. Synchronous and failure-free for the caller:
     * the append runs in the background and a lost append is only logged.
     */
    record(settlement: UsageSettlement): void {
        const current = this.current
        if (!this.accepting || !current?.decision.allowed) return
        const append = this.options.spool
            .append({
                id: settlement.observationId,
                receivedAt: this.clock(),
                policyEpoch: current.epoch,
                ...projectUsageSettlement(settlement),
            })
            .catch((error: unknown) => this.log("warn", `usage observation was not stored: ${describe(error)}`))
            .finally(() => this.appends.delete(append))
        this.appends.add(append)
    }

    /**
     * Re-read the inputs and resolve the machine policy. Call after the user or
     * an organization changes reporting; the cycle also refreshes on its own.
     */
    refresh(): Promise<void> {
        this.refreshing ??= this.resolve().finally(() => {
            this.refreshing = undefined
        })
        return this.refreshing
    }

    /**
     * Shutdown order: stop intake, stop the timer, abort and settle the running
     * cycle, flush local appends, then hand the lease back. Every step is bounded.
     */
    async dispose(): Promise<void> {
        if (this.disposed) return
        this.disposed = true
        this.accepting = false
        this.cancelTimer?.()
        this.cancelTimer = undefined
        this.cycleAbort?.abort()
        await withinBound(this.running)
        await withinBound(Promise.allSettled([...this.appends]))
        await withinBound(this.options.worker.release().catch(() => undefined))
    }

    /** Never rejects: a policy that cannot be read or stored closes intake until the next refresh. */
    private async resolve(): Promise<void> {
        let inputs: LocalUsagePolicyInputs
        try {
            inputs = await this.options.readPolicyInputs()
        } catch (error) {
            // Unknown inputs are treated as "not allowed" without persisting a decision.
            this.adopt(undefined)
            this.log("warn", `usage policy inputs unavailable: ${describe(error)}`)
            return
        }
        try {
            await this.apply(await this.options.policy.resolveUsage(inputs))
        } catch (error) {
            this.adopt(undefined)
            this.log("warn", `usage policy could not be applied: ${describe(error)}`)
        }
    }

    /** Adopt a decision; leaving the allowed state deletes everything not yet sent. */
    private async apply(next: UsagePolicyRecord | undefined): Promise<void> {
        const previous = this.current
        this.adopt(next)
        // One line per change, so the log shows whether usage is sent and, if not, why.
        if (next && previous?.epoch !== next.epoch) {
            this.log("info", `usage reporting ${describeUsagePolicyDecision(next.decision)}`)
        }
        if (!next !== this.ownedByNewerBuild) {
            this.ownedByNewerBuild = !next
            if (!next) this.log("warn", "usage reporting paused: a newer Dline build owns the policy document")
        }
        // A newer Dline owns the policy document: it also owns the data, so nothing is touched.
        if (!next || next.decision.allowed || previous?.epoch === next.epoch) return
        this.cycleAbort?.abort()
        await this.options.outbox.reset(next.epoch)
        await this.options.spool.purge()
        if (next.decision.reason === "consent_off") {
            await this.options.credentials.clearTokens()
        }
    }

    /** The only writer of the current decision, so every change of permission is announced once. */
    private adopt(next: UsagePolicyRecord | undefined): void {
        const wasAllowed = this.reportingAllowed
        this.current = next
        if (this.reportingAllowed === wasAllowed) return
        try {
            this.options.onReportingChanged?.(this.reportingAllowed)
        } catch (error) {
            this.log("warn", `reporting change listener failed: ${describe(error)}`)
        }
    }

    private scheduleCycle(delayMs: number): void {
        if (this.disposed) return
        this.cancelTimer = this.scheduler.schedule(() => {
            this.cancelTimer = undefined
            this.running = this.runCycle().finally(() => {
                this.running = undefined
                this.scheduleCycle(this.cycleIntervalMs)
            })
        }, delayMs)
    }

    private async runCycle(): Promise<void> {
        try {
            await this.refresh()
            const current = this.current
            if (this.disposed || !current?.decision.allowed) return
            const abort = new AbortController()
            this.cycleAbort = abort
            const result = await this.options.worker.runCycle(current.epoch, abort.signal)
            if (this.cycleAbort === abort) this.cycleAbort = undefined
            this.report(result)
            await this.handle(result)
        } catch (error) {
            this.log("warn", `usage delivery cycle failed: ${describe(error)}`)
        }
    }

    private async handle(result: UsageCycleResult): Promise<void> {
        if (result.kind !== "stopped") return
        await this.apply(await this.options.policy.recordServerStop({ scope: result.scope, code: result.code }))
    }

    /** Every event is printed; a steady state only when it is entered, so an idle window stays quiet. */
    private report(result: UsageCycleResult): void {
        const line = describeUsageCycle(result)
        if (line.steadyState !== undefined) {
            if (line.steadyState === this.loggedSteadyState) return
            this.loggedSteadyState = line.steadyState
        }
        this.log(line.level, line.message)
    }

    private log(level: RemoteUsageLogLevel, message: string): void {
        this.options.log?.(level, `[RemoteUsage] ${message}`)
    }
}

const nodeScheduler: UsageScheduler = {
    schedule(callback, delayMs) {
        const timer = setTimeout(callback, delayMs)
        timer.unref?.()
        return () => clearTimeout(timer)
    },
}

async function withinBound(work: Promise<unknown> | undefined): Promise<void> {
    if (!work) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const bound = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, USAGE_SHUTDOWN_STEP_MS)
        timer.unref?.()
    })
    await Promise.race([
        work.then(
            () => undefined,
            () => undefined,
        ),
        bound,
    ])
    clearTimeout(timer)
}

/** Error class and code only: messages may carry paths or server text. */
function describe(error: unknown): string {
    if (!(error instanceof Error)) return typeof error
    const code = (error as NodeJS.ErrnoException).code
    return code ? `${error.name} ${code}` : error.name
}

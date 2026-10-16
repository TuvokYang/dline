import { Logger } from "@shared/services/Logger"
import type { Command } from "../kernel"
import type { CommandPublicationStore } from "../stores/contracts"
import { type CommandRouter, domainFor } from "./CommandRouter"
import type { CommitReceipt, ExecutorDomain, RuntimeDiagnosticSink } from "./contracts"

interface PendingCommand {
    readonly command: Command
    readonly receipt: CommitReceipt
    fenced: boolean
}

interface PendingPublication {
    readonly command: Command
    readonly completion: Promise<void>
    fenced: boolean
}

function isImmediate(command: Command): boolean {
    return command.type === "dialog.prepare" || command.type === "halt.stop"
}

export function commandEffectKey(command: Command): string {
    if (command.type === "dialog.prepare") return command.prepareKey
    if (command.type === "dialog.reveal") return command.revealKey
    return command.commandId
}

/**
 * Publishes durable commands to their executors, one queue per executor domain.
 *
 * Publication is ordered within a domain and independent across domains. A
 * single shared queue deadlocks the turn-ending tools: such a tool stays running
 * until the dialog it opened has been answered, so the dialog's reveal has to
 * reach the dialog executor while the tool is still in flight. Behind one queue
 * the reveal waited for the tool and the tool waited for the reveal, leaving the
 * question rendered but permanently unanswerable.
 */
export class DurableCommandOutbox {
    private readonly pending = new Map<ExecutorDomain, PendingCommand[]>()
    private readonly drains = new Map<ExecutorDomain, Promise<void>>()
    private readonly publicationsInFlight = new Map<string, PendingPublication>()

    constructor(
        private readonly router: CommandRouter,
        private readonly publications: CommandPublicationStore,
        private readonly diagnostics?: RuntimeDiagnosticSink,
    ) {}

    persistableAfter(commands: readonly Command[]): readonly Command[] {
        const haltRevision = commands.find((command) => command.type === "halt.stop")?.originRevision
        const retained = [
            ...[...this.publicationsInFlight.values()].map((entry) => ({ command: entry.command, fenced: entry.fenced })),
            ...this.allPending(),
        ]
            .filter((entry) => !entry.fenced && (haltRevision === undefined || entry.command.originRevision >= haltRevision))
            .map((entry) => entry.command)
        const incoming = commands.filter((command) => !isImmediate(command))
        return [...retained, ...incoming]
    }

    enqueue(commands: readonly Command[], receipt: CommitReceipt): void {
        for (const command of commands) {
            if (command.type === "halt.stop") {
                this.fenceBefore(command.originRevision)
                this.dispatchImmediate(command)
                continue
            }
            if (command.type === "dialog.prepare") {
                this.dispatchImmediate(command)
                continue
            }
            this.queueFor(domainFor(command)).push({ command, receipt, fenced: false })
        }
        this.scheduleAll()
    }

    restore(commands: readonly Command[], generation?: number): void {
        const known = new Set(this.allPending().map((entry) => commandEffectKey(entry.command)))
        for (const command of commands) {
            if (generation !== undefined && command.generation !== generation) continue
            const effectKey = commandEffectKey(command)
            if (known.has(effectKey)) continue
            known.add(effectKey)
            this.queueFor(domainFor(command)).push({
                command,
                receipt: { revision: command.originRevision, durable: Promise.resolve() },
                fenced: false,
            })
        }
        this.scheduleAll()
    }

    async whenAdmitted(revision: number): Promise<void> {
        while (this.allPending().some((entry) => !entry.fenced && entry.command.originRevision === revision)) {
            this.scheduleAll()
            await this.settleActiveDrains()
        }
    }

    async whenIdle(): Promise<void> {
        while (this.drains.size > 0 || this.publicationsInFlight.size > 0) {
            await this.settleActiveDrains()
            await this.settlePublicationsThrough(Number.POSITIVE_INFINITY)
        }
    }

    get pendingCount(): number {
        return (
            this.allPending().filter((entry) => !entry.fenced).length +
            [...this.publicationsInFlight.values()].filter((entry) => !entry.fenced).length
        )
    }

    /** Every queued entry across domains, for accounting that spans the whole outbox. */
    private allPending(): readonly PendingCommand[] {
        return [...this.pending.values()].flat()
    }

    private queueFor(domain: ExecutorDomain): PendingCommand[] {
        const existing = this.pending.get(domain)
        if (existing) return existing
        const created: PendingCommand[] = []
        this.pending.set(domain, created)
        return created
    }

    /** Await the drains running now, without waiting on ones started afterwards. */
    private async settleActiveDrains(): Promise<void> {
        const active = [...this.drains.values()]
        if (active.length === 0) return
        await Promise.allSettled(active)
    }

    private async settlePublicationsThrough(revision: number): Promise<void> {
        while (true) {
            const active = [...this.publicationsInFlight.values()]
                .filter(({ command }) => command.originRevision <= revision)
                .map(({ completion }) => completion)
            if (active.length === 0) return
            await Promise.allSettled(active)
        }
    }

    private fenceBefore(revision: number): void {
        for (const entry of this.allPending()) {
            if (entry.command.originRevision < revision) entry.fenced = true
        }
        for (const entry of this.publicationsInFlight.values()) {
            if (entry.command.originRevision < revision) entry.fenced = true
        }
    }

    private dispatchImmediate(command: Command): void {
        try {
            this.router.dispatch(command)
        } catch (error) {
            this.diagnostics?.record({
                source: "outbox",
                code: "immediate_dispatch_failed",
                message: error instanceof Error ? error.message : String(error),
                revision: command.originRevision,
                commandId: command.commandId,
            })
        }
    }

    private scheduleAll(): void {
        for (const domain of this.pending.keys()) this.scheduleDrain(domain)
    }

    private scheduleDrain(domain: ExecutorDomain): void {
        const queue = this.pending.get(domain)
        if (this.drains.has(domain) || !queue || queue.length === 0) return
        const drain = Promise.resolve()
            .then(() => this.drain(queue))
            .finally(() => {
                this.drains.delete(domain)
                // Decide from the live queue, not the captured one: a command
                // published after the loop ran dry but before this settles lands
                // in the queue still registered for the domain and must be drained.
                const current = this.pending.get(domain)
                if (current && current.length > 0) this.scheduleDrain(domain)
                else if (current === queue) this.pending.delete(domain)
            })
        this.drains.set(domain, drain)
    }

    private async drain(queue: PendingCommand[]): Promise<void> {
        while (queue.length > 0) {
            const entry = queue[0]
            if (entry.fenced) {
                queue.shift()
                continue
            }
            try {
                const durabilityStartedAt = performance.now()
                await entry.receipt.durable
                const durabilityMs = Math.round(performance.now() - durabilityStartedAt)
                if (durabilityMs >= 100 && Logger.isDebugEnabled()) {
                    Logger.debug(
                        `[RuntimePerf] phase=command_durable commandType=${entry.command.type} commandId=${entry.command.commandId} durationMs=${durabilityMs}`,
                    )
                }
                if (entry.fenced) {
                    queue.shift()
                    continue
                }
                const effectKey = commandEffectKey(entry.command)
                if (!this.publicationsInFlight.has(effectKey) && !(await this.publications.has(effectKey))) {
                    const dispatch = this.router.dispatch(entry.command)
                    this.trackPublication(entry.command, effectKey, dispatch.completion)
                }
            } catch (error) {
                this.diagnostics?.record({
                    source: "outbox",
                    code: "durable_publish_failed",
                    message: error instanceof Error ? error.message : String(error),
                    revision: entry.command.originRevision,
                    commandId: entry.command.commandId,
                })
            }
            queue.shift()
        }
    }

    private trackPublication(command: Command, effectKey: string, effectCompletion: Promise<void>): void {
        const completion = effectCompletion
            .then(() => this.publications.mark(command, effectKey))
            .catch((error) => {
                this.diagnostics?.record({
                    source: "outbox",
                    code: "durable_publish_failed",
                    message: error instanceof Error ? error.message : String(error),
                    revision: command.originRevision,
                    commandId: command.commandId,
                })
            })
            .finally(() => {
                if (this.publicationsInFlight.get(effectKey)?.completion === completion)
                    this.publicationsInFlight.delete(effectKey)
            })
        this.publicationsInFlight.set(effectKey, { command, completion, fenced: false })
    }
}

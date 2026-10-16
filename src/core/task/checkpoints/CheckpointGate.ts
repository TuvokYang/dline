import { AsyncLocalStorage } from "node:async_hooks"
import type { CheckpointSource } from "@shared/ExtensionMessage"
import { Logger } from "@shared/services/Logger"

export type CheckpointRoundReason = "round_start" | "pre_compaction"
export type CheckpointRoundSource = Extract<CheckpointSource, { kind: CheckpointRoundReason }>
export type CheckpointGateReason = CheckpointRoundReason | "post_completion"
export type CheckpointGateOutcome = "created" | "covered" | "skipped" | "failed"
export type CheckpointGatePart = "file" | "row" | "bundle"

/** The workspace side of a checkpoint. Implementations own change detection and the shadow repository. */
export interface CheckpointWorkspacePort<Refs> {
    /** Whether the workspace may have changed since the last successful commit. */
    hasChanges(): boolean
    /**
     * Commit the changed workspace. Resolves undefined when this surface keeps no
     * file checkpoints; rejects when the commit itself failed.
     */
    commit(): Promise<Refs | undefined>
    /** Whether two references restore the same files. */
    sameRefs(left: Refs | undefined, right: Refs | undefined): boolean
}

/** The provider conversation a chat checkpoint returns to. */
export interface CheckpointConversationPort {
    /** Whether anything other than a checkpoint marker was journaled after `position`. */
    advancedSince(position: number): Promise<boolean>
}

/** One written `checkpoint_created` row. */
export interface CheckpointRow {
    readonly ts: number
    /** The conversation position the row restores to; undefined on a surface without a journal. */
    readonly position: number | undefined
}

/** The visible side of a checkpoint. */
export interface CheckpointRowPort<Refs> {
    /** Register one complete restore point in presentation order and resolve once it is durable. */
    write(input: { readonly source?: CheckpointSource; readonly refs?: Refs }): Promise<CheckpointRow>
}

/** The chat side of a checkpoint, stored beside the journal. */
export interface CheckpointBundlePort<Refs> {
    capture(input: { readonly row: CheckpointRow; readonly refs?: Refs; readonly anchor?: CheckpointRow }): Promise<void>
}

/** What the gate compares the next check with. */
export interface CheckpointGateState<Refs> {
    /** The latest row a round created; later rounds and edits are measured against it. */
    readonly latestChat?: CheckpointRow
    /** Producer metadata of latestChat; coverage depends on restore state, not producer identity. */
    readonly latestSource?: CheckpointRoundSource
    /** References that match the workspace as long as nothing changed since they were committed. */
    readonly latestRefs?: Refs
}

export interface CheckpointGateObservation {
    readonly reason: CheckpointGateReason
    readonly outcome: CheckpointGateOutcome
    /** The first part that failed; the checkpoint was kept without it. */
    readonly part?: CheckpointGatePart
    readonly errorName?: string
    readonly waitMs: number
    readonly holdMs: number
    readonly commitMs?: number
}

export interface CheckpointGateOptions<Refs> {
    readonly taskId: string
    readonly workspace: CheckpointWorkspacePort<Refs>
    readonly conversation: CheckpointConversationPort
    readonly rows: CheckpointRowPort<Refs>
    readonly bundles: CheckpointBundlePort<Refs>
    /** The state a reopened task continues from, read once before the first check. */
    readonly initialState?: () => CheckpointGateState<Refs>
    /** Telemetry sink; failures of the sink itself are ignored. */
    readonly observe?: (observation: CheckpointGateObservation) => void
    readonly now?: () => number
}

export interface CheckpointGateResult {
    readonly outcome: CheckpointGateOutcome
    readonly row?: CheckpointRow
}

const COVERED: CheckpointGateResult = { outcome: "covered" }
const SKIPPED: CheckpointGateResult = { outcome: "skipped" }
const FAILED: CheckpointGateResult = { outcome: "failed" }

/** Facts one gate run collects for its telemetry record. */
interface GateRun {
    failure?: { readonly part: CheckpointGatePart; readonly errorName: string }
    commitMs?: number
    fail(part: CheckpointGatePart, error: unknown): void
}

type CommitAttempt<Refs> = { readonly ok: true; readonly refs: Refs | undefined } | { readonly ok: false }

/**
 * The single owner of checkpoint creation for one task.
 *
 * Callers use it at round and completion boundaries. A checkpoint is a side
 * feature of the task, so no failure here reaches the caller; a part that could not be
 * written is logged, reported to telemetry and left out.
 *
 * Work is serialized by a private lock held only across checkpoint I/O (shadow
 * commit, row write, bundle capture). Nothing inside it waits for tools, the
 * user, the network or kernel events, so a holder always releases it. A waiter
 * can leave the queue when its caller is cancelled, and a call made while the
 * lock is held by the same chain is skipped instead of waiting on itself.
 */
export class CheckpointGate<Refs> {
    private tail: Promise<void> = Promise.resolve()
    private readonly holding = new AsyncLocalStorage<true>()
    private closed = false
    private seeded = false
    private latestChat: CheckpointRow | undefined
    private latestRefs: Refs | undefined

    constructor(private readonly options: CheckpointGateOptions<Refs>) {}

    /**
     * Before a provider request or compaction: add a checkpoint row unless the
     * latest one already covers both the conversation and the files.
     */
    ensureRound(
        reason: CheckpointRoundReason,
        sourceOrSignal?: CheckpointRoundSource | AbortSignal,
        signal?: AbortSignal,
    ): Promise<CheckpointGateResult> {
        const source = sourceOrSignal instanceof AbortSignal ? undefined : sourceOrSignal
        const operationSignal = sourceOrSignal instanceof AbortSignal ? sourceOrSignal : signal
        return this.exclusive(reason, operationSignal, async (run) => {
            const advanced = await this.conversationAdvanced()
            const changed = this.options.workspace.hasChanges()
            if (!advanced && !changed && this.latestRefs !== undefined) return COVERED

            const previousRefs = this.latestRefs
            let refs = previousRefs
            // A row always carries the workspace state at its own conversation boundary.
            // Commit when files may have changed or no reusable baseline exists; otherwise
            // reuse the latest references instead of manufacturing a chat-only checkpoint.
            if (changed || refs === undefined) {
                const committed = await this.commit(run)
                // Without a new restore point for the files there is nothing to add
                // when the conversation also stands where the latest row left it.
                if (!committed.ok && !advanced) return FAILED
                // A failed commit must not reuse the previous references: the files
                // moved on, so they would restore an older state than this row shows.
                refs = committed.ok ? committed.refs : undefined
                if (committed.ok && !advanced && this.options.workspace.sameRefs(refs, previousRefs)) return COVERED
            }

            const row = await this.writeRow(run, {
                ...(source ? { source } : {}),
                ...(refs === undefined ? {} : { refs }),
            })
            if (!row) return FAILED
            await this.captureBundle(run, { row, ...(refs === undefined ? {} : { refs }) })
            this.latestChat = row
            return { outcome: "created", row }
        })
    }

    /**
     * Commit the workspace without adding a row, for the post-state of a task
     * completion. Keeps the references later rounds reuse in step with the files.
     */
    async commitFiles(signal?: AbortSignal): Promise<Refs | undefined> {
        let refs: Refs | undefined
        await this.exclusive("post_completion", signal, async (run) => {
            if (!this.options.workspace.hasChanges() && this.latestRefs !== undefined) {
                refs = this.latestRefs
                return COVERED
            }
            const committed = await this.commit(run)
            if (!committed.ok) return FAILED
            refs = committed.refs
            return committed.refs === undefined ? SKIPPED : { outcome: "created" }
        })
        return refs
    }

    /**
     * Wait for work admitted before this call without admitting another checkpoint.
     *
     * File tools use this as a mutation barrier: the provider may reach the wire
     * while its round baseline is still being built, but no workspace mutation may
     * overtake that already-started baseline. Work admitted later is deliberately
     * excluded, so this is not a general checkpoint drain.
     */
    async waitForPendingWork(): Promise<void> {
        const pending = this.tail
        await pending
    }

    /**
     * Enter one bounded workspace mutation in the same ordering sequence as checkpoints.
     *
     * A mutation admitted after a round waits for that baseline. A later round waits
     * for the returned settlement callback, then commits the changed files and binds
     * that resulting baseline to its own row.
     */
    async beginMutation(): Promise<() => void> {
        if (this.holding.getStore()) return () => undefined
        const previous = this.tail
        let release!: () => void
        const own = new Promise<void>((resolve) => {
            release = resolve
        })
        this.tail = previous.then(() => own)
        await previous
        if (this.closed) {
            release()
            return () => undefined
        }
        let settled = false
        return () => {
            if (settled) return
            settled = true
            release()
        }
    }

    /** Refuse new work and wait for the work already admitted, so no row is left without its bundle. */
    async close(): Promise<void> {
        this.closed = true
        await this.tail
    }

    /** The conversation moved on unless the latest row's position is still its end. */
    private async conversationAdvanced(): Promise<boolean> {
        const position = this.latestChat?.position
        if (position === undefined) return true
        try {
            return await this.options.conversation.advancedSince(position)
        } catch (error) {
            // Not knowing costs one extra row at most, never a missing one.
            Logger.warn(`[CheckpointGate] Could not read the conversation of task ${this.options.taskId}:`, error)
            return true
        }
    }

    /** A successful commit always becomes the latest references: the workspace now matches them. */
    private async commit(run: GateRun): Promise<CommitAttempt<Refs>> {
        const now = this.options.now ?? Date.now
        const startedAt = now()
        try {
            const refs = await this.options.workspace.commit()
            this.latestRefs = refs
            return { ok: true, refs }
        } catch (error) {
            // The workspace moved but no trustworthy reference describes it.
            // Clearing this prevents a later row from binding a stale baseline after
            // this failure.
            this.latestRefs = undefined
            run.fail("file", error)
            return { ok: false }
        } finally {
            run.commitMs = now() - startedAt
        }
    }

    private async writeRow(
        run: GateRun,
        input: { readonly source?: CheckpointSource; readonly refs?: Refs },
    ): Promise<CheckpointRow | undefined> {
        try {
            return await this.options.rows.write(input)
        } catch (error) {
            run.fail("row", error)
            return undefined
        }
    }

    /** A row without a bundle stays restorable through the conversation position it recorded. */
    private async captureBundle(
        run: GateRun,
        input: { readonly row: CheckpointRow; readonly refs?: Refs; readonly anchor?: CheckpointRow },
    ): Promise<void> {
        try {
            await this.options.bundles.capture(input)
        } catch (error) {
            run.fail("bundle", error)
        }
    }

    private seed(): void {
        if (this.seeded) return
        this.seeded = true
        try {
            const state = this.options.initialState?.()
            this.latestChat = state?.latestChat
            this.latestRefs = state?.latestRefs
        } catch (error) {
            Logger.warn(`[CheckpointGate] Could not read the latest checkpoint of task ${this.options.taskId}:`, error)
        }
    }

    private exclusive(
        reason: CheckpointGateReason,
        signal: AbortSignal | undefined,
        work: (run: GateRun) => Promise<CheckpointGateResult>,
    ): Promise<CheckpointGateResult> {
        const now = this.options.now ?? Date.now
        const queuedAt = now()
        // Waiting on a lock this chain already holds would never end.
        if (this.holding.getStore()) {
            Logger.warn(`[CheckpointGate] Skipped a re-entrant ${reason} checkpoint for task ${this.options.taskId}`)
            this.report({ reason, outcome: "skipped", waitMs: 0, holdMs: 0 })
            return Promise.resolve(SKIPPED)
        }
        const previous = this.tail
        let release!: () => void
        const own = new Promise<void>((resolve) => {
            release = resolve
        })
        // The next holder waits for this one and every earlier one, so a waiter
        // that left the queue early never lets two holders run at once.
        this.tail = previous.then(() => own)
        return (async () => {
            try {
                await waitUnlessAborted(previous, signal)
                const startedAt = now()
                if (this.closed || signal?.aborted) {
                    this.report({ reason, outcome: "skipped", waitMs: startedAt - queuedAt, holdMs: 0 })
                    return SKIPPED
                }
                this.seed()
                const run: GateRun = {
                    fail: (part, error) => {
                        run.failure ??= { part, errorName: error instanceof Error ? error.name : typeof error }
                        Logger.error(
                            `[CheckpointGate] ${reason}: the ${part} part failed for task ${this.options.taskId}; the checkpoint is kept without it`,
                            error,
                        )
                    },
                }
                let result: CheckpointGateResult
                try {
                    result = await this.holding.run(true, () => work(run))
                } catch (error) {
                    run.fail("row", error)
                    result = FAILED
                }
                this.report({
                    reason,
                    outcome: run.failure ? "failed" : result.outcome,
                    ...(run.failure ? { part: run.failure.part, errorName: run.failure.errorName } : {}),
                    waitMs: startedAt - queuedAt,
                    holdMs: now() - startedAt,
                    ...(run.commitMs === undefined ? {} : { commitMs: run.commitMs }),
                })
                return result
            } finally {
                release()
            }
        })()
    }

    private report(observation: CheckpointGateObservation): void {
        try {
            this.options.observe?.(observation)
        } catch {
            // Telemetry must never affect the task.
        }
    }
}

/** Wait for the previous holder, or stop waiting as soon as the caller is cancelled. */
function waitUnlessAborted(previous: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
    if (!signal) return previous
    if (signal.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
        const onAbort = () => resolve()
        signal.addEventListener("abort", onAbort, { once: true })
        void previous.then(() => {
            signal.removeEventListener("abort", onAbort)
            resolve()
        })
    })
}

import type { TrajectoryFrame, TrajectoryFrameState, TrajectoryFrameTurn } from "@shared/proto-conversions/trajectory"
import { UNAVAILABLE_TRAJECTORY_FRAME } from "@shared/proto-conversions/trajectory"
import { Logger } from "@/shared/services/Logger"
import { resolveInstanceLayout } from "../storage/instance"
import { openTrajectoryRows } from "../storage/trajectory/openTrajectoryRows"
import type { TrajectoryMeta, TrajectorySnapshot, TrajectoryTurn } from "../storage/trajectory/TrajectoryRowStore"
import { UIMessage } from "../storage/UIMessage"
import { CommittedUiMessagesMissing } from "./CommittedUiMessages"
import { TrajectoryMaintainer } from "./TrajectoryMaintainer"
import {
    type MaintainedTask,
    type TrajectoryAccess,
    type TrajectoryMaintainerLease,
    TrajectoryMaintainerRegistry,
} from "./TrajectoryMaintainerRegistry"

/**
 * The one maintainer registry of this process. `trajectory.db` accepts a single
 * writer handle per process, so every Controller and panel must share it.
 */
export const processTrajectoryMaintainers = new TrajectoryMaintainerRegistry()

/**
 * A write permission that its owner flips synchronously, for example when the
 * task lock is acquired, taken over or lost. Every change, including a repeated
 * one, notifies listeners, so they re-read whatever else they depend on.
 */
export class TrajectoryAdmission {
    private admittedTaskId: string | undefined
    private readonly listeners = new Set<() => void>()

    admits(taskId: string): boolean {
        return this.admittedTaskId === taskId
    }

    admit(taskId: string): void {
        this.admittedTaskId = taskId
        this.notify()
    }

    revoke(): void {
        this.admittedTaskId = undefined
        this.notify()
    }

    /** Notify without changing the permission, for a change in what listeners combine with it. */
    notify(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener()
            } catch (error) {
                Logger.warn(
                    `[trajectory] TrajectoryAdmissionListenerFailed: ${error instanceof Error ? error.message : String(error)}`,
                )
            }
        }
    }

    onDidChange(listener: () => void): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }
}

/** Where a source finds the maintainer of its task. */
export interface TrajectoryMaintainerProvider {
    /** Registry key: the task's instance root. */
    readonly key: string
    readonly registry: TrajectoryMaintainerRegistry
    readonly create: () => Promise<MaintainedTask>
}

/** The production provider: committed rows of `messages.db` folded into the task's `trajectory.db`. */
export async function taskTrajectoryMaintainers(taskId: string): Promise<TrajectoryMaintainerProvider> {
    const { root } = await resolveInstanceLayout({ taskId })
    return {
        key: root,
        registry: processTrajectoryMaintainers,
        create: async () => {
            const messages = await UIMessage.openCommittedUiMessages(taskId)
            const maintainer = new TrajectoryMaintainer({
                instanceId: taskId,
                messages,
                openStore: () => openTrajectoryRows(root),
            })
            return { maintainer, messages }
        },
    }
}

function frameState(meta: TrajectoryMeta | null): TrajectoryFrameState {
    if (meta?.state === "ready" || meta?.state === "error") return meta.state
    return "building"
}

function frameTurn(turn: TrajectoryTurn): TrajectoryFrameTurn {
    return {
        seq: turn.seq,
        attemptSeq: turn.attemptSeq,
        anchorTs: turn.anchorTs,
        prompt: turn.prompt,
        rounds: turn.rounds,
        toolUsage: turn.toolUsage,
        endsAttempt: turn.endsAttempt,
        tailTs: turn.tailTs,
    }
}

function resetFrame(snapshot: TrajectorySnapshot): TrajectoryFrame {
    return {
        state: frameState(snapshot.meta),
        revision: snapshot.meta?.revision ?? 0,
        baseRevision: 0,
        reset: true,
        turnCount: snapshot.turns.length,
        turns: snapshot.turns.map(frameTurn),
    }
}

function isClosed(error: unknown): boolean {
    return error instanceof Error && /\bis closed\b|\bnot open\b/i.test(error.message)
}

/** Failures that are an expected state of the task rather than a fault worth a warning. */
function isExpectedEnd(error: unknown): boolean {
    return isClosed(error) || error instanceof CommittedUiMessagesMissing
}

/** A running trajectory stream; `close` stops it and releases its hold on the maintainer. */
export interface TrajectoryStream {
    close(): Promise<void>
}

/**
 * C4: the trajectory of one task opening as a stream of frames.
 *
 * Every stream opens with a full `reset` frame, then sends frames whose
 * `baseRevision` is the revision of the previous one. Frames are sent one at a
 * time. While the opening may not write the trajectory, the stream reports
 * `unavailable` and holds no maintainer, so `trajectory.db` stays closed; when
 * permission returns it starts again from a full snapshot.
 */
export class TrajectorySource {
    constructor(
        private readonly access: TrajectoryAccess,
        private readonly maintainers: TrajectoryMaintainerProvider,
    ) {}

    /** One full snapshot, caught up to the committed rows first. */
    async snapshot(): Promise<TrajectoryFrame> {
        if (!this.access.writable()) return UNAVAILABLE_TRAJECTORY_FRAME
        let lease: TrajectoryMaintainerLease
        try {
            lease = await this.maintainers.registry.acquire(this.maintainers.key, this.access, this.maintainers.create)
        } catch (error) {
            if (error instanceof CommittedUiMessagesMissing) return UNAVAILABLE_TRAJECTORY_FRAME
            throw error
        }
        try {
            await lease.maintainer.catchUp(this.access)
            if (!this.access.writable()) return UNAVAILABLE_TRAJECTORY_FRAME
            return resetFrame(await lease.maintainer.readSnapshot(-1))
        } finally {
            await lease.release()
        }
    }

    /**
     * Send frames to `send` until the returned stream is closed or fails.
     *
     * A failure, including a rejected `send`, stops the stream, releases its
     * maintainer and then calls `onFailed` once; the owner ends its RPC there so
     * the client resubscribes. `onFailed` is not called after `close`.
     */
    subscribe(send: (frame: TrajectoryFrame) => Promise<void>, onFailed: () => void): TrajectoryStream {
        return new TrajectoryStreamRun(this.access, this.maintainers, send, onFailed)
    }
}

class TrajectoryStreamRun implements TrajectoryStream {
    private lease: TrajectoryMaintainerLease | undefined
    private stopWrites: (() => void) | undefined
    private readonly stopAccess: () => void
    /** Revision and build of the last frame sent; undefined until a snapshot went out for the current hold. */
    private sent: { revision: number; buildId: string | undefined } | undefined
    private unavailableSent = false
    private dirty = false
    /** Stopped, by the owner or by a failure. */
    private closed = false
    /** The owner called `close`; once set, a failure is no longer reported. */
    private cancelled = false
    private queue: Promise<void> = Promise.resolve()

    constructor(
        private readonly access: TrajectoryAccess,
        private readonly maintainers: TrajectoryMaintainerProvider,
        private readonly send: (frame: TrajectoryFrame) => Promise<void>,
        private readonly onFailed: () => void,
    ) {
        this.stopAccess = access.onDidChange(() => this.schedule())
        this.schedule()
    }

    /** Also waits for a failure already being handled, so the hold is released when it returns. */
    async close(): Promise<void> {
        this.cancelled = true
        this.closed = true
        this.stopAccess()
        await this.queue
        await this.releaseHold()
    }

    /** Steps run one at a time, so at most one frame is in flight. */
    private schedule(): void {
        this.queue = this.queue.then(() => this.step()).catch((error) => this.fail(error))
    }

    private async fail(error: unknown): Promise<void> {
        const open = !this.closed
        if (open && !isExpectedEnd(error)) {
            Logger.warn(`[trajectory] TrajectoryStreamFailed: ${error instanceof Error ? error.message : String(error)}`)
        }
        this.closed = true
        this.stopAccess()
        await this.releaseHold()
        // The owner may close while the hold is released; it ends its RPC itself then.
        if (!open || this.cancelled) return
        try {
            // Never awaited: the owner's cleanup closes this stream, which waits for this queue.
            this.onFailed()
        } catch (listenerError) {
            Logger.warn(
                `[trajectory] TrajectoryStreamFailureListenerFailed: ${listenerError instanceof Error ? listenerError.message : String(listenerError)}`,
            )
        }
    }

    private async step(): Promise<void> {
        if (!(await this.stillWritable())) return
        if (!this.lease) await this.hold()
        if (!this.lease || !(await this.stillWritable())) return
        if (!this.sent) {
            await this.sendSnapshot(this.lease)
        }
        while (this.dirty && this.lease && (await this.stillWritable())) {
            this.dirty = false
            await this.sendChange(this.lease)
        }
    }

    /**
     * Permission can be lost while a maintainer is acquired or a frame is
     * delivered, so every read follows a fresh check. Without permission the
     * hold is released and `unavailable` reported before anything is read.
     */
    private async stillWritable(): Promise<boolean> {
        if (this.closed) return false
        if (this.access.writable()) return true
        await this.becomeUnavailable()
        return false
    }

    /** Listen first, then read: a write between the two only marks the stream dirty. */
    private async hold(): Promise<void> {
        const lease = await this.maintainers.registry.acquire(this.maintainers.key, this.access, this.maintainers.create)
        if (this.closed) {
            await lease.release()
            return
        }
        this.lease = lease
        this.stopWrites = lease.maintainer.onDidWrite(() => {
            this.dirty = true
            this.schedule()
        })
    }

    private async sendSnapshot(lease: TrajectoryMaintainerLease): Promise<void> {
        const snapshot = await lease.maintainer.readSnapshot(-1)
        if (this.closed || !this.access.writable()) return
        const frame = resetFrame(snapshot)
        await this.send(frame)
        this.sent = { revision: frame.revision, buildId: snapshot.meta?.buildId }
        this.unavailableSent = false
        // Whatever was written while the snapshot was read or delivered is checked once more.
        this.dirty = true
    }

    private async sendChange(lease: TrajectoryMaintainerLease): Promise<void> {
        const sent = this.sent
        if (!sent) return
        const snapshot = await lease.maintainer.readSnapshot(sent.revision)
        const meta = snapshot.meta
        if (this.closed || !meta || !this.access.writable()) return
        if (meta.buildId !== sent.buildId) {
            this.sent = undefined
            await this.sendSnapshot(lease)
            return
        }
        if (meta.revision <= sent.revision) return
        await this.send({
            state: frameState(meta),
            revision: meta.revision,
            baseRevision: sent.revision,
            reset: false,
            turnCount: meta.turnCount,
            turns: snapshot.turns.map(frameTurn),
        })
        this.sent = { revision: meta.revision, buildId: meta.buildId }
    }

    private async becomeUnavailable(): Promise<void> {
        await this.releaseHold()
        if (this.unavailableSent || this.closed) return
        await this.send(UNAVAILABLE_TRAJECTORY_FRAME)
        this.unavailableSent = true
    }

    private async releaseHold(): Promise<void> {
        this.stopWrites?.()
        this.stopWrites = undefined
        this.sent = undefined
        this.dirty = false
        const lease = this.lease
        this.lease = undefined
        await lease?.release()
    }
}

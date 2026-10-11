import { Logger } from "@shared/services/Logger"
import type { ProviderTextPresentationPort } from "../executors/provider/ProviderCommandExecutor"
import { getPresentationCadenceMs, isRemoteWorkspaceEnvironment } from "../latency"
import type { MessageStateHandler } from "../message-state"
import type { PresentationPriority } from "../presentation-types"
import { type PresentationFlushContext, TaskPresentationScheduler } from "../TaskPresentationScheduler"
import type { PresentationIdSequence } from "./PresentationIdSequence"
import type { RealtimeMessagePublisher } from "./RealtimeMessagePublisher"

/** The two rows one streamed reply can own: what the model thought, then what it said. */
type ReplyRow = "reasoning" | "text"

type ToolProjection = Readonly<Record<string, unknown>>

/** How long a refresh may wait so that several provider chunks are drawn as one. */
export interface ProviderPresentationPacing {
    delayMs(priority: PresentationPriority): number
}

/** The local cadence; a remote workspace pays more per message and waits longer. */
export const LOCAL_PRESENTATION_PACING: ProviderPresentationPacing = {
    delayMs: (priority) => getPresentationCadenceMs(false, priority),
}

/**
 * The cadence of the host the session runs on.
 *
 * The host is asked once; until it answers, or if it cannot, the local cadence
 * applies, which only costs a remote workspace some extra messages.
 */
export function createHostPresentationPacing(
    readHost: () => Promise<Parameters<typeof isRemoteWorkspaceEnvironment>[0]>,
): ProviderPresentationPacing {
    let remote = false
    void readHost()
        .then((host) => {
            remote = isRemoteWorkspaceEnvironment(host)
        })
        .catch(() => undefined)
    return { delayMs: (priority) => getPresentationCadenceMs(remote, priority) }
}

/**
 * What the stream said since the chat last caught up.
 *
 * Every chunk carries the reply so far, so only the latest prose, reasoning and
 * state of each tool call is worth drawing; the frames in between are dropped.
 */
interface PendingFrame {
    readonly transientId: string
    text: string
    reasoning?: string
    readonly tools: Map<string, ToolProjection>
}

/**
 * Shows the assistant's reasoning and prose as chat rows while its turn streams.
 *
 * One row of each kind per stream, keyed by the provider's transient id, so a
 * resumed or retried stream rewrites its own rows instead of appending copies.
 * The rows stay transient until the turn is journaled: only then is the same
 * content committed durably, which keeps the visible conversation and the
 * durable one from disagreeing after a crash. Reasoning is shown as it streams
 * because a long think is otherwise indistinguishable from a stalled request.
 *
 * Drawing is paced: a provider emits a chunk every few characters and each one
 * carries the whole reply so far, so drawing every chunk sends work quadratic in
 * the reply's length to the host and the Webview, and partial rows pile up until
 * the final one overtakes them. Only one refresh runs at a time, the first
 * appearance of a row is drawn at once, and later changes are coalesced at the
 * presentation cadence. Settling a stream first drops what was never drawn and
 * waits for the refresh in flight, so no partial frame can land after its final.
 */
export class ProviderTextPresenter implements ProviderTextPresentationPort {
    private readonly rows = new Map<string, number>()
    /** The text each row last showed, so a chunk that changed nothing is not redrawn. */
    private readonly shown = new Map<string, string>()
    /** Tool calls of the current stream that have been drawn at least once. */
    private readonly drawnTools = new Set<string>()
    /** Rows of provisional tool cards each stream drew, kept only if its turn settles them. */
    private readonly provisionalTools = new Map<string, Set<number>>()
    private readonly scheduler: TaskPresentationScheduler
    private pending: PendingFrame | undefined

    constructor(
        private readonly messages: MessageStateHandler,
        private readonly nextPresentationId: PresentationIdSequence,
        private readonly realtime?: RealtimeMessagePublisher,
        private readonly presentToolPartial?: (projection: ToolProjection) => Promise<void>,
        pacing: ProviderPresentationPacing = LOCAL_PRESENTATION_PACING,
    ) {
        this.scheduler = new TaskPresentationScheduler({
            flush: (context) => this.draw(context),
            getDelayMs: (priority) => pacing.delayMs(priority),
            onFlushError: (error) => Logger.warn(`[ProviderTextPresenter] Failed to draw a streamed frame: ${String(error)}`),
        })
    }

    showPartial(input: {
        readonly transientId: string
        readonly text: string
        readonly reasoning?: string
        readonly projection?: ToolProjection
    }): void {
        const frame = this.frameFor(input.transientId)
        const opensRow = this.opensRow(frame.transientId, input)
        this.claimRows(frame.transientId, input)
        frame.text = input.text
        if (input.reasoning !== undefined) frame.reasoning = input.reasoning
        if (input.projection && this.presentToolPartial) frame.tools.set(toolKey(input.projection), input.projection)
        this.scheduler.requestFlush(opensRow ? "immediate" : "normal")
    }

    async commit(input: {
        readonly transientId: string
        readonly text: string
        readonly reasoning?: string
        readonly toolRows?: readonly number[]
    }): Promise<void> {
        await this.drain()
        this.drawnTools.clear()
        await this.withdrawUnsettledTools(input.transientId, input.toolRows ?? [])
        await this.settle(input.transientId, "reasoning", input.reasoning ?? "")
        await this.settle(input.transientId, "text", input.text)
    }

    /** Stop pacing; anything not yet drawn belongs to a session that is closing. */
    async dispose(): Promise<void> {
        this.pending = undefined
        await this.scheduler.dispose()
    }

    private frameFor(transientId: string): PendingFrame {
        if (this.pending?.transientId === transientId) return this.pending
        this.pending = { transientId, text: "", tools: new Map() }
        return this.pending
    }

    /**
     * Reserve the rows a chunk opens when it arrives, not when it is drawn.
     *
     * Rows sort by id, and a tool card the stream draws right after this chunk
     * reserves its own id at once. Reasoning first, then prose, then the cards.
     */
    private claimRows(transientId: string, input: { readonly text: string; readonly reasoning?: string }): void {
        if (input.reasoning !== undefined) this.rowId(transientId, "reasoning")
        if (input.text) this.rowId(transientId, "text")
    }

    /** A row or tool call the chat has not shown yet is drawn without waiting for the cadence. */
    private opensRow(
        transientId: string,
        input: { readonly text: string; readonly reasoning?: string; readonly projection?: ToolProjection },
    ): boolean {
        if (input.reasoning !== undefined && !this.rows.has(rowKey(transientId, "reasoning"))) return true
        if (input.text && !this.rows.has(rowKey(transientId, "text"))) return true
        return (
            input.projection !== undefined &&
            this.presentToolPartial !== undefined &&
            !this.drawnTools.has(toolKey(input.projection))
        )
    }

    private async draw(context: PresentationFlushContext): Promise<void> {
        const frame = this.pending
        this.pending = undefined
        if (!frame || !context.isCurrent()) return
        // Reasoning first: its row is allocated before the prose row, so the chat
        // shows the thinking above the answer it led to. Empty reasoning still
        // opens the row, so encrypted-only thinking reads as activity, not a stall.
        if (frame.reasoning !== undefined) this.show(frame.transientId, "reasoning", frame.reasoning)
        if (frame.text) this.show(frame.transientId, "text", frame.text)
        // One tool refresh at a time, each with its latest arguments: the handler
        // waits on the message store and the host, so overlapping refreshes would
        // queue behind each other and finish out of order.
        for (const [key, projection] of frame.tools) {
            if (!context.isCurrent()) return
            this.drawnTools.add(key)
            this.noteProvisional(frame.transientId, projection)
            await this.presentToolPartial?.(projection).catch((error) =>
                Logger.warn(`[ProviderTextPresenter] Failed to present partial tool call: ${String(error)}`),
            )
        }
    }

    /** Recorded before the card is drawn, so a refresh that fails halfway is still withdrawn. */
    private noteProvisional(transientId: string, projection: ToolProjection): void {
        if (projection.provisional !== true) return
        const row = (projection.block as { readonly ts?: unknown } | undefined)?.ts
        if (typeof row !== "number") return
        const rows = this.provisionalTools.get(transientId) ?? new Set<number>()
        rows.add(row)
        this.provisionalTools.set(transientId, rows)
    }

    /**
     * Remove the provisional cards the turn did not settle.
     *
     * A card stands for a call that was still being written. When the turn
     * settles without it the call never ran, so the card goes rather than
     * staying as a call the chat claims is still streaming.
     */
    private async withdrawUnsettledTools(transientId: string, settled: readonly number[]): Promise<void> {
        const drawn = this.provisionalTools.get(transientId)
        this.provisionalTools.delete(transientId)
        if (!drawn) return
        const kept = new Set(settled)
        const withdrawn = [...drawn].filter((row) => !kept.has(row))
        if (withdrawn.length === 0) return
        try {
            await this.messages.removeMessagesByTs(withdrawn)
        } catch (error) {
            // The turn is already durable; a card left behind is cosmetic, not a reason to fail it.
            Logger.warn(`[ProviderTextPresenter] Failed to withdraw unsettled tool cards: ${String(error)}`)
        }
    }

    /** Drop what was never drawn and wait for the refresh already drawing. */
    private async drain(): Promise<void> {
        this.pending = undefined
        try {
            await this.scheduler.flushNow()
        } catch (error) {
            Logger.warn(`[ProviderTextPresenter] Streamed frame failed before its turn settled: ${String(error)}`)
        }
    }

    private show(transientId: string, row: ReplyRow, text: string): void {
        const key = rowKey(transientId, row)
        if (this.rows.has(key) && this.shown.get(key) === text) return
        const message = {
            ts: this.rowId(transientId, row),
            type: "say" as const,
            say: row,
            text,
            partial: true,
        }
        this.shown.set(key, text)
        this.messages.upsertTransientClineMessage(message)
        this.realtime?.publish(message)
    }

    private async settle(transientId: string, row: ReplyRow, text: string): Promise<void> {
        const key = rowKey(transientId, row)
        const existing = this.rows.get(key)
        this.rows.delete(key)
        this.shown.delete(key)
        if (!text.trim()) {
            // A turn that only called tools has no prose to keep. Any row opened by
            // an early chunk is withdrawn rather than committed empty.
            if (existing !== undefined) this.messages.removeTransientClineMessage(existing)
            return
        }
        const committed = await this.messages.commitTransientClineMessage({
            ts: existing ?? this.nextPresentationId(),
            type: "say",
            say: row,
            text,
            partial: false,
        })
        this.realtime?.publish(committed)
    }

    /** The row a stream owns, allocated once so later chunks update rather than append. */
    private rowId(transientId: string, row: ReplyRow): number {
        const key = rowKey(transientId, row)
        const existing = this.rows.get(key)
        if (existing !== undefined) return existing
        const created = this.nextPresentationId()
        this.rows.set(key, created)
        return created
    }
}

function rowKey(transientId: string, row: ReplyRow): string {
    return `${transientId}:${row}`
}

/** One drawing slot per tool call; a projection without an identity shares its kind's slot. */
function toolKey(projection: ToolProjection): string {
    const identity = typeof projection.dlineTid === "string" ? projection.dlineTid : ""
    return `${String(projection.kind)}:${identity}`
}

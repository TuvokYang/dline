import type { ProviderTextPresentationPort } from "../executors/provider/ProviderCommandExecutor"
import type { MessageStateHandler } from "../message-state"
import type { PresentationIdSequence } from "./PresentationIdSequence"
import type { RealtimeMessagePublisher } from "./RealtimeMessagePublisher"

/** The two rows one streamed reply can own: what the model thought, then what it said. */
type ReplyRow = "reasoning" | "text"

/**
 * Shows the assistant's reasoning and prose as chat rows while its turn streams.
 *
 * One row of each kind per stream, keyed by the provider's transient id, so a
 * resumed or retried stream rewrites its own rows instead of appending copies.
 * The rows stay transient until the turn is journaled: only then is the same
 * content committed durably, which keeps the visible conversation and the
 * durable one from disagreeing after a crash. Reasoning is shown as it streams
 * because a long think is otherwise indistinguishable from a stalled request.
 */
export class ProviderTextPresenter implements ProviderTextPresentationPort {
	private readonly rows = new Map<string, number>()

	constructor(
		private readonly messages: MessageStateHandler,
		private readonly nextPresentationId: PresentationIdSequence,
		private readonly realtime?: RealtimeMessagePublisher,
	) {}

	showPartial(input: { readonly transientId: string; readonly text: string; readonly reasoning?: string }): void {
		// Reasoning first: its row is allocated before the prose row, so the chat
		// shows the thinking above the answer it led to.
		if (input.reasoning) this.show(input.transientId, "reasoning", input.reasoning)
		if (input.text) this.show(input.transientId, "text", input.text)
	}

	async commit(input: { readonly transientId: string; readonly text: string; readonly reasoning?: string }): Promise<void> {
		await this.settle(input.transientId, "reasoning", input.reasoning ?? "")
		await this.settle(input.transientId, "text", input.text)
	}

	private show(transientId: string, row: ReplyRow, text: string): void {
		const message = {
			ts: this.rowId(transientId, row),
			type: "say" as const,
			say: row,
			text,
			partial: true,
		}
		this.messages.upsertTransientClineMessage(message)
		this.realtime?.publish(message)
	}

	private async settle(transientId: string, row: ReplyRow, text: string): Promise<void> {
		const key = rowKey(transientId, row)
		const existing = this.rows.get(key)
		this.rows.delete(key)
		if (!text.trim()) {
			// A turn that only called tools has no prose to keep. Any row opened by
			// an early chunk is withdrawn rather than committed empty.
			if (existing !== undefined) this.messages.removeTransientClineMessage(existing)
			return
		}
		await this.messages.commitTransientClineMessage({
			ts: existing ?? this.nextPresentationId(),
			type: "say",
			say: row,
			text,
			partial: false,
		})
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

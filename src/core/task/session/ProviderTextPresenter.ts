import type { ProviderTextPresentationPort } from "../executors/provider/ProviderCommandExecutor"
import type { MessageStateHandler } from "../message-state"
import type { PresentationIdSequence } from "./PresentationIdSequence"

/**
 * Shows the assistant's prose as a chat row while its turn streams.
 *
 * One row per stream, keyed by the provider's transient id, so a resumed or
 * retried stream rewrites its own row instead of appending a second copy. The
 * row stays transient until the turn is journaled: only then is the same text
 * committed durably, which keeps the visible conversation and the durable one
 * from disagreeing after a crash.
 */
export class ProviderTextPresenter implements ProviderTextPresentationPort {
	private readonly rows = new Map<string, number>()

	constructor(
		private readonly messages: MessageStateHandler,
		private readonly nextPresentationId: PresentationIdSequence,
	) {}

	showPartial(input: { readonly transientId: string; readonly text: string }): void {
		if (!input.text) return
		this.messages.upsertTransientClineMessage({
			ts: this.rowId(input.transientId),
			type: "say",
			say: "text",
			text: input.text,
			partial: true,
		})
	}

	async commit(input: { readonly transientId: string; readonly text: string }): Promise<void> {
		const existing = this.rows.get(input.transientId)
		this.rows.delete(input.transientId)
		if (!input.text.trim()) {
			// A turn that only called tools has no prose to keep. Any row opened by
			// an early chunk is withdrawn rather than committed empty.
			if (existing !== undefined) this.messages.removeTransientClineMessage(existing)
			return
		}
		const ts = existing ?? this.nextPresentationId()
		await this.messages.commitTransientClineMessage({
			ts,
			type: "say",
			say: "text",
			text: input.text,
			partial: false,
		})
	}

	/** The row a stream owns, allocated once so later chunks update rather than append. */
	private rowId(transientId: string): number {
		const existing = this.rows.get(transientId)
		if (existing !== undefined) return existing
		const created = this.nextPresentationId()
		this.rows.set(transientId, created)
		return created
	}
}

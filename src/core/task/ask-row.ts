import type { UiAsk, UiMessage } from "@shared/ExtensionMessage"

/**
 * Build the canonical complete ask row every writer of an ask must use.
 *
 * A command ask starts `pending`: the chat treats a settled command row with
 * no status as a finished legacy command and collapses its card for good, so
 * an ask written without one would hide every later state - running,
 * cancelled, interrupted - behind the one-line summary.
 */
export function createCanonicalAskRow(type: UiAsk, text: string | undefined, ts: number, interactionId?: string): UiMessage {
	const commandPresentation = type === "command" ? { commandStatus: "pending" as const, exitCode: undefined } : {}
	const interactionIdentity = interactionId ? { interactionId } : {}
	return {
		ts,
		type: "ask",
		say: undefined,
		ask: type,
		text,
		partial: false,
		...interactionIdentity,
		...commandPresentation,
	}
}

import type { ActiveInteractionView, ClineMessage } from "./ExtensionMessage"

/** Match one complete ask presentation to the exact interaction that owns it. */
export function matchesActiveInteractionAnchor(message: ClineMessage, interaction: ActiveInteractionView): boolean {
	return (
		message.type === "ask" &&
		message.partial !== true &&
		message.ts === interaction.askMessageTs &&
		message.interactionId === interaction.interactionId &&
		message.ask === interaction.taskAsk
	)
}

import type { ActiveInteractionView, TaskInputViewState, TaskViewAction } from "@shared/ExtensionMessage"
import type { ActiveInteraction } from "../interaction/InteractionReducer"
import { getInteraction } from "../interaction/InteractionRegistry"

/** Complete projection result for one active interaction. */
export interface InteractionProjectionResult {
	view?: ActiveInteractionView
	input?: TaskInputViewState
	actions?: TaskViewAction[]
}

/** Project one interaction without reading UI or API messages. */
export function projectInteraction(interaction: Readonly<ActiveInteraction>, stateRevision: number): InteractionProjectionResult {
	// Opening interactions have not registered their ask yet. Persisted malformed
	// anchors are reconciled to Resume before hydration, and runtime presentation
	// failures create a reconstructable Resume ask, so no error UI is projected here.
	if (!interaction.anchor || interaction.anchor.messageType !== "ask") return {}

	const definition = getInteraction(interaction.kind)
	const input: TaskInputViewState = {
		...definition.input,
		enabled: definition.input.enabled && interaction.status === "awaiting",
	}
	const actions: TaskViewAction[] = definition.actions.map((action) => ({
		...action,
		enabled: interaction.status === "awaiting",
		dispatchTarget: "interaction",
	}))
	return {
		view: {
			taskId: interaction.taskId,
			turnId: interaction.turnId,
			interactionId: interaction.interactionId,
			kind: interaction.kind,
			status: interaction.status,
			stateRevision,
			// The anchor is the ask the Webview actually rendered. Falling back to
			// the definition only covers first presentation, where the two agree
			// because the ask was raised from this very definition.
			taskAsk: interaction.anchor.taskAsk ?? definition.taskAsk,
			// Keep the legacy renderer key only at the Webview presentation boundary.
			presentationKind: interaction.kind === "change_todo_list" ? "focus_chain_change" : definition.presentationKind,
			askMessageTs: interaction.anchor.messageTs,
		},
		input,
		actions,
	}
}

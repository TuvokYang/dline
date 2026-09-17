import type { DispatchInteraction } from "./types"

/** Build the causal identity shared by every UI surface for one interaction. */
function interactionDispatchKey(request: Parameters<DispatchInteraction>[0]): string {
	return `${request.taskId}:${request.turnId}:${request.interactionId}`
}

/**
 * Coalesce concurrent UI dispatches for the same causal interaction.
 *
 * Footer buttons and the composer are independent React subtrees, so their
 * local pending latches cannot prevent a click and Enter key event from racing
 * in the same tick. The first dispatch owns the backend request; every other
 * surface for that interaction observes the same settlement. A successor
 * interaction has a different identity and remains independently dispatchable.
 */
export function createInteractionDispatchGate(dispatch: DispatchInteraction): DispatchInteraction {
	const inFlight = new Map<string, ReturnType<DispatchInteraction>>()

	return (request) => {
		const key = interactionDispatchKey(request)
		const existing = inFlight.get(key)
		if (existing) {
			return existing
		}

		const pending = dispatch(request)
		inFlight.set(key, pending)
		const release = () => {
			if (inFlight.get(key) === pending) {
				inFlight.delete(key)
			}
		}
		void pending.then(release, release)
		return pending
	}
}

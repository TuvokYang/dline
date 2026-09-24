import type { TaskViewAction } from "@shared/ExtensionMessage"

/**
 * The foreground work that is currently eligible for an explicit background handoff.
 *
 * Handoff eligibility is runtime ownership, not canonical Task state: it depends
 * on whether a live executor still holds a cancellable process and a pending
 * handoff request. Declaring it as a narrow query keeps the canonical projection
 * free of executor internals and lets any Task host — the VS Code sidebar, a
 * headless reviewer, or an automated approver — supply the same fact.
 */
export interface BackgroundHandoffAvailabilityPort {
	/** Activity identity that can be moved to the background right now, if any. */
	readyActivityId(): string | undefined
	/** Whether a move was already requested and is still settling. */
	isRequested(activityId: string): boolean
}

/** Project the optional background handoff affordance into footer actions. */
export function projectBackgroundHandoffAction(
	availability: BackgroundHandoffAvailabilityPort | undefined,
): TaskViewAction | undefined {
	const activityId = availability?.readyActivityId()
	if (!activityId) return undefined
	return {
		type: "continue_in_background",
		label: "Continue in Background",
		appearance: "secondary",
		enabled: !availability?.isRequested(activityId),
		payloadPolicy: "none",
		dispatchTarget: "task",
		activityId,
	}
}

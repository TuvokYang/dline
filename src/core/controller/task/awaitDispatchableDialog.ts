import type { DialogInteraction, TaskState } from "@core/task/kernel"

/** How long a promoted recovery dialog may take to reach a dispatchable state. */
const DEFAULT_TIMEOUT_MS = 10_000
const POLL_INTERVAL_MS = 25

/** Minimal state source; any Task host can supply it without exposing the session. */
export interface DialogStateSource {
	state(): TaskState
}

export interface AwaitDispatchableDialogOptions {
	readonly timeoutMs?: number
	/** False once the caller no longer serves this task, e.g. it was cleared or replaced. */
	readonly isCurrent?: () => boolean
}

/**
 * Wait until the promoted task owns a dialog a response can be dispatched to.
 *
 * Hydrate reopens an interrupted task with its recovery dialog still `planned`:
 * the prepare and reveal commands run through the outbox after promotion
 * returns. Reading the dialog immediately therefore sees a dialog that cannot
 * accept a response yet, and the dispatch is rejected as stale even though the
 * user's Resume click is valid. Selecting the interrupted dialog as well is what
 * lets a resumed task answer at all, because that is where hydrate parks it.
 *
 * The wait ends early once the task is stopping or no longer current: the
 * caller holds the lifecycle lock, and no dialog can become answerable then.
 */
export async function awaitDispatchableDialog(
	source: DialogStateSource,
	options: AwaitDispatchableDialogOptions = {},
): Promise<DialogInteraction | undefined> {
	const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
	for (;;) {
		const state = source.state()
		const dispatchable = dispatchableDialog(state)
		if (dispatchable) return dispatchable
		if (state.halt.status === "stopping" || options.isCurrent?.() === false) return undefined
		if (Date.now() >= deadline) return undefined
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
	}
}

/** Select the dialog that can currently accept a user response. */
export function dispatchableDialog(state: TaskState): DialogInteraction | undefined {
	return [state.dialog.primary, state.dialog.interrupted, ...Object.values(state.dialog.approvalsByBlock)].find(
		(interaction): interaction is DialogInteraction =>
			interaction !== undefined && interaction.status === "awaiting" && interaction.receiverGeneration !== undefined,
	)
}

import {
	type BackgroundCommandProvider,
	type BackgroundResultConsumer,
	type BackgroundSubagentProvider,
	buildTaskBackgroundResults,
} from "../background/BackgroundContextInjector"
import type { BackgroundResultsLease, ComposeBackgroundResultsPort } from "../executors/compose/ComposeBackgroundResultsPort"

export interface TaskBackgroundResultsOwnerOptions {
	readonly subagents: BackgroundSubagentProvider
	readonly commands: BackgroundCommandProvider & BackgroundResultConsumer
}

/**
 * Task-scoped owner of background results delivered to the model.
 *
 * Background commands and subagents finish on their own schedule, so their
 * outcome reaches the model only when a later round carries it. Collection
 * leaves results pending; only the round that journaled them commits the
 * legacy injected/consumed transitions. Failed persistence therefore leaves
 * the result available to the next compose attempt.
 */
export class TaskBackgroundResultsOwner implements ComposeBackgroundResultsPort {
	constructor(private readonly options: TaskBackgroundResultsOwnerOptions) {}

	async collect(input: { readonly signal: AbortSignal }): Promise<BackgroundResultsLease | undefined> {
		if (input.signal.aborted) throw input.signal.reason
		const section = await buildTaskBackgroundResults(this.options.subagents, this.options.commands)
		if (!section.text) return undefined
		if (input.signal.aborted) throw input.signal.reason
		let committed = false
		return {
			text: section.text,
			commit: () => {
				if (committed) return
				this.commitDelivery(section.subagentIds, section.commandIds)
				committed = true
			},
		}
	}

	/** The journal now owns delivery; later rounds must not collect the same results. */
	private commitDelivery(subagentIds: readonly string[], commandIds: readonly string[]): void {
		if (subagentIds.length > 0) {
			const manager = this.options.subagents.getSubagentJobManager()
			manager.markInjected([...subagentIds])
			manager.markConsumed([...subagentIds])
		}
		if (commandIds.length > 0) {
			this.options.commands.markBackgroundCommandsInjected([...commandIds])
			this.options.commands.markBackgroundCommandsConsumed([...commandIds])
		}
	}
}

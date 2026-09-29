import type { CommandExecutor } from "@integrations/terminal/CommandExecutor"
import { type BackgroundSubagentProvider, buildTaskBackgroundResults } from "../background/BackgroundContextInjector"
import type { BackgroundResultsLease, ComposeBackgroundResultsPort } from "../executors/compose/ProductionComposeAdapter"

export interface TaskBackgroundResultsOwnerOptions {
	readonly subagents: BackgroundSubagentProvider
	readonly commands: CommandExecutor
}

/**
 * Task-scoped owner of background results delivered to the model.
 *
 * Background commands and subagents finish on their own schedule, so their
 * outcome reaches the model only when a later round carries it. Two lifecycle
 * steps keep that delivery exactly-once: collecting marks the results
 * `injected`, and the round that actually journaled them marks them
 * `consumed`. Splitting the steps is what prevents an aborted round from
 * silently dropping a result nobody will report again.
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
				committed = true
				this.markConsumed(section.subagentIds, section.commandIds)
			},
		}
	}

	/** Record that the model has been told, so later rounds stay silent. */
	private markConsumed(subagentIds: readonly string[], commandIds: readonly string[]): void {
		if (subagentIds.length > 0) this.options.subagents.getSubagentJobManager().markConsumed([...subagentIds])
		if (commandIds.length > 0) this.options.commands.markBackgroundCommandsConsumed([...commandIds])
	}
}

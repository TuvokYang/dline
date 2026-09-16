import type { HaltOrder, ToolDomainRunner, ToolRunCommand } from "./ToolExecutionDomain"

/**
 * The workspace resources the tool domain owns.
 *
 * Ownership matters more than location: today these handles are constructed by
 * Task and reach the executor by injection, but the reset discipline lives here
 * so it is applied in one place instead of at each cancellation call site.
 */
export interface OwnedToolResources {
	/** Revert and close any editor-visible diff. Safe to call when not editing. */
	revertDiff(): Promise<void>
	/** Stop any running foreground command. */
	cancelCommand(): Promise<void>
}

export interface ToolDomainResourceOptions {
	readonly resources: OwnedToolResources
	/** Execute one admitted block; supplied by the assembling Task. */
	readonly execute: (command: ToolRunCommand) => Promise<void>
	readonly onReleaseError?: (error: unknown, order: HaltOrder) => void
}

/**
 * Adapts the owned resources to the executor's runner contract.
 *
 * `release` is the single disposer. Previously the same duty was spread across
 * the abort, interrupt, terminate and provider-retry paths, each of which had to
 * remember to revert the diff; a missed path leaked an open editor and a double
 * call reverted work twice. Routing every stop through here makes the
 * "exactly one reset per stop" property structural: the domain guarantees a
 * single `release` per halt generation, and this adapter performs the resets.
 */
export function createToolDomainRunner(options: ToolDomainResourceOptions): ToolDomainRunner {
	const { resources, execute, onReleaseError } = options

	return {
		runBlock: (command) => execute(command),

		release: async (order) => {
			// Both resets are attempted even when the first fails, so one stuck
			// handle cannot strand the other resource in an open state.
			const outcomes = await Promise.allSettled([resources.revertDiff(), resources.cancelCommand()])

			for (const outcome of outcomes) {
				if (outcome.status === "rejected") {
					// A release failure is reported but never rethrown: the runtime
					// still needs the halt receipt to know the domain is quiet.
					onReleaseError?.(outcome.reason, order)
				}
			}
		},
	}
}

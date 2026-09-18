import type { AgentBaseConfig } from "./AgentConfigLoader"
import { DEFAULT_SUBAGENT_NAME, isDefaultSubagentName } from "./DefaultSubagentConfig"
import type { SubagentBatchItemRequest } from "./SubagentRequestParser"

/** How an agent name was looked up, so the planner stays testable without disk. */
export interface SubagentBatchResolvers {
	/**
	 * Resolve a named subagent config.
	 * @param agentName Name requested by the item.
	 * @returns The config, or undefined when unknown or disabled.
	 */
	resolveAgent(agentName: string): Promise<AgentBaseConfig | undefined>
	/**
	 * Report whether a Profile name can be bound by a subagent.
	 * @param profileName Profile requested by the item.
	 * @returns True when the Profile exists, is enabled, and is usable here.
	 */
	isProfileUsable(profileName: string): boolean
	/**
	 * List the names a caller could have used, for the failure message.
	 * @returns Bounded, sorted list of selectable subagent names.
	 */
	listAgentNames(): Promise<string[]>
}

/** One item that will execute. */
export interface PlannedSubagentItem {
	/** Stable identity for this item, used by runners, cancel, finish and retry. */
	jobId: string
	/** One-based position as written by the caller, retained for display only. */
	index: number
	/** Effective subagent name after resolution. */
	subagentName: string
	/** Effective config, absent for the built-in default subagent. */
	agentConfig: AgentBaseConfig | undefined
	task: string
	context: string
	prompt: string
	/** Effective timeout for this item, after inheriting the batch option. */
	timeoutSeconds: number
	/** Profile bound to this item, when one was resolved. */
	profileName: string | undefined
}

/** One item that cannot execute, with the reason to report. */
export interface RejectedSubagentItem {
	jobId: string
	index: number
	/** Name the caller asked for, which may not exist. */
	requestedName: string
	task: string
	context: string
	prompt: string
	timeoutSeconds: number
	/** Actionable, non-sensitive reason shown to the user and the model. */
	error: string
}

/** Result of planning a batch. */
export interface SubagentBatchPlan {
	planned: PlannedSubagentItem[]
	rejected: RejectedSubagentItem[]
}

/** Inputs needed to plan a batch. */
export interface PlanSubagentBatchInput {
	items: readonly SubagentBatchItemRequest[]
	/** Shared timeout applied to items that did not set their own. */
	batchTimeoutSeconds: number
	/** Stable prefix for generated job ids, normally derived from the tool call. */
	batchId: string
	resolvers: SubagentBatchResolvers
}

/**
 * Turn a parsed batch into executable items with stable identities.
 *
 * Identity is assigned here rather than at execution because everything the
 * batch later does - cancel, finish, retry, activity updates, status rows -
 * has to address one item unambiguously. Array position cannot serve that
 * purpose: rejected items make the executing set sparse, so a position is not
 * the same thing across the two lists.
 *
 * Resolution is deliberately per item. A batch exists to run differently
 * configured work at once, so a single resolved agent for the whole call would
 * silently discard the distinction the caller asked for.
 *
 * A failure is recorded per item rather than thrown. Rejecting the whole call
 * because one of up to 32 items named a missing profile would discard work that
 * is valid and ready.
 *
 * @param input Parsed items, shared options and the lookups to use.
 * @returns Items to execute and items to report as failed.
 */
export async function planSubagentBatch(input: PlanSubagentBatchInput): Promise<SubagentBatchPlan> {
	const planned: PlannedSubagentItem[] = []
	const rejected: RejectedSubagentItem[] = []

	for (const item of input.items) {
		const jobId = subagentJobId(input.batchId, item.index)
		const timeoutSeconds = item.timeoutSeconds ?? input.batchTimeoutSeconds
		const base = {
			jobId,
			index: item.index,
			task: item.task,
			context: item.context,
			prompt: item.prompt,
			timeoutSeconds,
		}

		const usesDefault = isDefaultSubagentName(item.agentName)
		const agentConfig = await input.resolvers.resolveAgent(item.agentName)
		if (!usesDefault && !agentConfig) {
			const available = await input.resolvers.listAgentNames()
			rejected.push({
				...base,
				requestedName: item.agentName,
				error: `Unknown or disabled subagent '${item.agentName}'. Available subagents: ${available.join(", ")}.`,
			})
			continue
		}

		const subagentName = agentConfig?.name ?? DEFAULT_SUBAGENT_NAME

		// An explicit item profile is a binding decision by the caller, so an
		// unusable one fails the item. Falling back to the parent Profile would
		// run the work against a model and credentials that were not chosen,
		// and report it as success.
		if (item.profile && !input.resolvers.isProfileUsable(item.profile)) {
			rejected.push({
				...base,
				requestedName: item.agentName,
				error: `API Profile '${item.profile}' is unavailable or not enabled for subagents. Choose an enabled Profile or omit the profile field to use the subagent's own configuration.`,
			})
			continue
		}

		planned.push({
			...base,
			subagentName,
			agentConfig: applyProfileOverride(agentConfig, item.profile),
			// An item profile wins over the YAML profile, which in turn wins
			// over the parent Act profile resolved further down the stack.
			profileName: item.profile ?? agentConfig?.profile ?? undefined,
		})
	}

	return { planned, rejected }
}

/**
 * Build the stable job id for one batch position.
 *
 * The id embeds the caller's position so a status row, an activity record and a
 * log line can be matched to the item the user wrote, while remaining a single
 * opaque key everywhere else.
 *
 * @param batchId Stable identifier of the whole call.
 * @param index One-based item position.
 * @returns Stable per-item job id.
 */
export function subagentJobId(batchId: string, index: number): string {
	return `${batchId}_${index}`
}

/**
 * Apply an explicit item profile on top of the resolved config.
 *
 * The override is expressed in the config the builder already consumes, so the
 * item's choice travels through the same resolution path as a YAML profile
 * instead of adding a second, parallel way to select a Profile.
 *
 * Also used when replaying a retained item, so a retry rebuilds the same
 * binding the original run used rather than re-deriving it.
 *
 * @param agentConfig Resolved config, absent for the built-in default.
 * @param profile Profile explicitly requested by the item.
 * @returns Config carrying the effective profile.
 */
export function applyProfileOverride(
	agentConfig: AgentBaseConfig | undefined,
	profile: string | undefined,
): AgentBaseConfig | undefined {
	if (!profile) return agentConfig
	if (!agentConfig) {
		// The built-in default has no document of its own; the item's profile is
		// the only configured value, so a minimal config carries it.
		return { name: DEFAULT_SUBAGENT_NAME, profile } as AgentBaseConfig
	}
	return { ...agentConfig, profile }
}

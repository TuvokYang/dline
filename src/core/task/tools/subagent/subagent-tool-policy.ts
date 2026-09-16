import { TURN_ENDING_TOOL_NAMES } from "@core/task/assistant-message-order"
import { ClineDefaultTool, CONVERSATIONAL_TOOL_NAMES } from "@shared/tools"
import { DEFAULT_SUBAGENT_ALLOWED_TOOLS } from "./DefaultSubagentConfig"

/**
 * The one turn-ending tool a subagent must always keep.
 *
 * A subagent reports back by completing, so removing this would leave a run
 * with no way to finish. It is therefore enforced rather than offered.
 */
export const REQUIRED_SUBAGENT_TOOL = ClineDefaultTool.ATTEMPT

/** Every identity the config loader will accept when reading a document back. */
const KNOWN_TOOL_NAMES: ReadonlySet<ClineDefaultTool> = new Set(Object.values(ClineDefaultTool))

/**
 * Tools a subagent must never be given.
 *
 * Two overlapping sets disqualify a tool, and both matter:
 *
 * - `TURN_ENDING_TOOL_NAMES` hands control back to the user and ends the turn.
 * - `CONVERSATIONAL_TOOL_NAMES` opens a UI interaction and awaits user input.
 *   `act_mode_respond` is in this set but not the first, because it continues
 *   the turn; it still addresses a user the subagent does not have.
 *
 * Either way the subagent is left waiting on a person who will never answer.
 * Both are derived rather than restated, minus the one tool the subagent needs
 * in order to finish.
 */
export function isForbiddenSubagentTool(tool: string): boolean {
	if (tool === REQUIRED_SUBAGENT_TOOL) return false
	return TURN_ENDING_TOOL_NAMES.has(tool) || CONVERSATIONAL_TOOL_NAMES.has(tool as ClineDefaultTool)
}

/**
 * Drop forbidden tools without granting the required one.
 *
 * Used where an empty list still means "inherit the default allowlist", so
 * appending `attempt_completion` would turn inheritance into an explicit
 * one-tool selection. Configuration read and RPC write both need that
 * distinction; only the resolved runtime allowlist grants the required tool.
 *
 * @param requestedTools Tools as written by YAML or by the caller.
 * @returns The same tools minus the ones policy forbids, order preserved.
 */
export function rejectForbiddenSubagentTools<T extends string>(requestedTools: readonly T[]): T[] {
	return requestedTools.filter((tool) => !isForbiddenSubagentTool(tool))
}

/**
 * Apply the policy to a list about to be written to a config document.
 *
 * `attempt_completion` is never written. It is not a capability the author
 * chooses; it is granted unconditionally at resolution, so storing it would
 * present an implicit guarantee as an editable preference and invite someone to
 * remove it. A document records only what was actually selected.
 *
 * @param requestedTools Tools the caller intends to persist.
 * @returns Persistable list: known names only, de-duplicated, forbidden tools
 *   removed. May be empty, which on disk means "inherit the default allowlist".
 */
export function sanitizeSubagentToolsForPersistence(requestedTools: readonly string[]): ClineDefaultTool[] {
	// An unrecognised name would be written happily and then rejected by the
	// loader, which fails the whole document and makes the subagent disappear.
	// Refusing it here keeps what can be stored equal to what can be read back.
	const known = requestedTools.filter((tool): tool is ClineDefaultTool => KNOWN_TOOL_NAMES.has(tool as ClineDefaultTool))
	// The required tool is dropped rather than rejected: it is permitted, and the
	// UI keeps it checked, but resolution grants it regardless. It is excluded
	// here separately from the forbidden set, which it does not belong to.
	const selectable = known.filter((tool) => tool !== REQUIRED_SUBAGENT_TOOL)
	return Array.from(new Set(rejectForbiddenSubagentTools(selectable)))
}

/**
 * Apply the subagent tool policy to a requested allowlist.
 *
 * This is the single enforcement point: configuration read, RPC write, the
 * capability catalogue, and the selection UI all project this result instead of
 * filtering independently. `attempt_completion` is appended unconditionally
 * because it is how a subagent reports back, not a capability anyone selects.
 *
 * An absent list inherits the default allowlist. A list that was written but
 * contains nothing permitted does not: the author asked for a narrow set, and
 * widening that to every default tool would grant more than they requested. It
 * degrades to the reporting tool alone.
 *
 * @param requestedTools Tools requested by YAML or by the user. `undefined` and
 *   `[]` both mean "not specified" and inherit.
 * @param options.builtInDefault Whether this is the built-in default subagent,
 *   which additionally excludes command execution.
 * @param options.explicitlyNarrowed Set when the author did write a list and
 *   every entry was rejected, so inheritance must not apply.
 * @returns Ordered, de-duplicated allowlist with the policy applied.
 */
export function sanitizeSubagentTools(
	requestedTools: readonly string[] | undefined,
	options: { builtInDefault?: boolean; explicitlyNarrowed?: boolean } = {},
): ClineDefaultTool[] {
	const specified = requestedTools && requestedTools.length > 0
	if (!specified && options.explicitlyNarrowed) {
		return [REQUIRED_SUBAGENT_TOOL]
	}

	const source = specified ? requestedTools : (DEFAULT_SUBAGENT_ALLOWED_TOOLS as readonly string[])

	const allowed = source.filter((tool): tool is ClineDefaultTool => {
		if (isForbiddenSubagentTool(tool)) return false
		if (options.builtInDefault && tool === ClineDefaultTool.BASH) return false
		return true
	})

	return Array.from(new Set<ClineDefaultTool>([...allowed, REQUIRED_SUBAGENT_TOOL]))
}

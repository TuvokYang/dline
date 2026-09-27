import {
	collectContextWindowRequestPressures,
	getLatestReliableContextWindowTokens,
} from "@core/context/context-management/context-pressure"
import type { UiMessage } from "@shared/ExtensionMessage"

/** Context pressure as the compaction barrier observes it. */
export interface RestoredPressure {
	readonly contextTokens: number
	readonly compactTriggerTokens: number
}

/**
 * The pressure a restored conversation already carries.
 *
 * A task learns its context pressure only when a request settles, and that
 * observation lives in memory. A chat restore reopens the task, so the rewound
 * conversation - which may be exactly as full as the one that was compacted -
 * would otherwise get one uncompacted request before anything noticed. The
 * newest provider-reported occupancy in the kept request rows is that same
 * observation, recovered from where the request recorded it.
 *
 * Returns nothing when no request reported reliable usage, because an unknown
 * pressure must not be read as a full window.
 */
export function readRestoredContextPressure(
	messages: readonly UiMessage[],
	compactTriggerTokens: number,
): RestoredPressure | undefined {
	const contextTokens = getLatestReliableContextWindowTokens(collectContextWindowRequestPressures(messages))
	if (contextTokens <= 0 || compactTriggerTokens <= 0) return undefined
	return { contextTokens, compactTriggerTokens }
}

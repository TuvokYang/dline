import type { ClineApiReqInfo, ClineMessage, ClineSayTool } from "@shared/ExtensionMessage"
import type { ContextWindowRequestPressure } from "./context-window-projection"
import { computeCompactTrigger, computeSummarizeBudget } from "./context-window-utils"

/** Context pressure inputs required to evaluate one mode-switch request. */
export interface ModeSwitchPressureInput {
	sourceProfile: string
	targetProfile: string
	sourceWindow: number
	targetWindow: number
	currentTokens: number
}

/** Pure mode-switch pressure decision. */
export type ModeSwitchPressureDecision = { kind: "switch" } | { kind: "confirm"; triggerTokens: number }

/**
 * Compute canonical context occupancy from persisted request usage.
 *
 * @param info Persisted API request metrics.
 * @returns Canonical context occupancy in tokens.
 */
export function getContextTokens(info: ClineApiReqInfo): number {
	if (typeof info.contextTokens === "number" && Number.isFinite(info.contextTokens) && info.contextTokens >= 0) {
		return info.contextTokens
	}
	return (info.tokensIn || 0) + (info.tokensOut || 0) + (info.cacheWrites || 0) + (info.cacheReads || 0)
}

/**
 * Parse canonical context occupancy from a serialized API request message.
 *
 * @param text Serialized api_req_started metadata.
 * @returns Canonical context occupancy, or zero when metadata is unavailable.
 */
export function readContextTokens(text?: string): number {
	if (!text) {
		return 0
	}
	try {
		return getContextTokens(JSON.parse(text) as ClineApiReqInfo)
	} catch {
		return 0
	}
}

/** Parse request pressure while preserving whether occupancy is reliable or estimated. */
export function readContextWindowRequestPressure(text?: string): ContextWindowRequestPressure | undefined {
	if (!text) return undefined

	try {
		const info = JSON.parse(text) as ClineApiReqInfo
		const pressure: ContextWindowRequestPressure = {}
		const estimatedContextTokens = normalizePositiveTokens(info.estimatedContextTokens)
		if (estimatedContextTokens > 0) {
			pressure.estimatedContextTokens = estimatedContextTokens
			pressure.contextTokensSource = "estimate"
		}

		const explicitContextTokens = normalizePositiveTokens(info.contextTokens)
		const legacyContextTokens = normalizePositiveTokens(
			(info.tokensIn || 0) + (info.tokensOut || 0) + (info.cacheWrites || 0) + (info.cacheReads || 0),
		)
		const reliableContextTokens = info.contextTokensSource === "estimate" ? 0 : explicitContextTokens || legacyContextTokens
		if (reliableContextTokens > 0) {
			pressure.contextTokens = reliableContextTokens
			pressure.contextTokensSource = "provider"
		}
		if (info.cancelReason) pressure.cancelReason = info.cancelReason
		return pressure
	} catch {
		return undefined
	}
}

function normalizePositiveTokens(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * Decide whether a message is a durable card for a successfully completed compaction.
 *
 * @param message The chat message to classify.
 * @returns True when the message reports a completed compaction unit.
 */
function isCompletedCompactionCard(message: ClineMessage): boolean {
	if (message.type !== "say" || message.say !== "tool" || message.partial || !message.text) return false
	try {
		const tool = JSON.parse(message.text) as ClineSayTool
		return tool.tool === "summarizeTask" && tool.compactionStatus === "completed"
	} catch {
		return false
	}
}

/**
 * Collect request pressure records that still describe the live conversation.
 *
 * A completed compaction replaces the preceding conversation with a summary, so provider
 * occupancy recorded before that boundary no longer measures the current context. Keeping
 * those records made the first post-compaction request inherit the pre-compaction baseline
 * until fresh provider usage arrived, which displayed a context far larger than was sent.
 *
 * @param messages The chat messages in chronological order.
 * @returns Pressure records recorded after the latest completed compaction.
 */
export function collectContextWindowRequestPressures(messages: readonly ClineMessage[]): readonly ContextWindowRequestPressure[] {
	let startIndex = 0
	for (let index = messages.length - 1; index >= 0; index--) {
		if (isCompletedCompactionCard(messages[index])) {
			startIndex = index + 1
			break
		}
	}
	const pressures: ContextWindowRequestPressure[] = []
	for (let index = startIndex; index < messages.length; index++) {
		const message = messages[index]
		if (message.say !== "api_req_started") continue
		const pressure = readContextWindowRequestPressure(message.text)
		if (pressure !== undefined) pressures.push(pressure)
	}
	return pressures
}

/** Return the newest reliable provider occupancy after the active compaction boundary. */
export function getLatestReliableContextWindowTokens(pressures: readonly ContextWindowRequestPressure[]): number {
	for (let index = pressures.length - 1; index >= 0; index--) {
		const pressure = pressures[index]
		if (pressure.contextTokensSource !== "provider") continue
		const contextTokens = normalizePositiveTokens(pressure.contextTokens)
		if (contextTokens > 0) return contextTokens
	}
	return 0
}

/** Keep Profile preflight conservative while the live indicator is catching up with persisted provider usage. */
export function resolveOccupiedContextWindowTokens(
	indicatorTokens: number,
	pressures: readonly ContextWindowRequestPressure[],
): number {
	return Math.max(normalizePositiveTokens(indicatorTokens), getLatestReliableContextWindowTokens(pressures))
}

/**
 * Decide whether a mode switch is safe or requires compact confirmation.
 *
 * @param input Source, target, and current context pressure.
 * @returns A direct-switch or confirmation-required decision.
 */
export function decideModeSwitch(input: ModeSwitchPressureInput): ModeSwitchPressureDecision {
	if (input.sourceProfile === input.targetProfile || input.targetWindow >= input.sourceWindow) {
		return { kind: "switch" }
	}
	const triggerTokens = computeCompactTrigger(input.targetWindow, computeSummarizeBudget())
	return input.currentTokens >= triggerTokens ? { kind: "confirm", triggerTokens } : { kind: "switch" }
}

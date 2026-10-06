import type { ContextWindowIndicatorSnapshot } from "@shared/context-window-indicator"

const INDICATOR_PHASES = new Set(["stable", "sending", "receiving", "committing", "rolling_back"])

function isTokenCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/**
 * Validate the historical display baseline without restoring execution budgets.
 * Interrupted active segments are discarded; saved durable, staged and ENV
 * values remain historical until execution re-estimates its actual input.
 */
export function readHistoryContextWindowIndicator(input: unknown, taskId: string): ContextWindowIndicatorSnapshot | undefined {
	if (!input || typeof input !== "object") return undefined
	const value = input as Record<string, unknown>
	if (
		value.taskId !== taskId ||
		typeof value.phase !== "string" ||
		!INDICATOR_PHASES.has(value.phase) ||
		(value.mode !== "act" && value.mode !== "plan") ||
		!isTokenCount(value.revision) ||
		!isTokenCount(value.epoch) ||
		!isTokenCount(value.updatedAt) ||
		!isTokenCount(value.contextWindow) ||
		value.contextWindow === 0 ||
		!isTokenCount(value.durableContextTokens) ||
		!isTokenCount(value.pendingSendTokens) ||
		!isTokenCount(value.receivingTokens) ||
		!isTokenCount(value.environmentTokens) ||
		(value.stagedTokens !== undefined && !isTokenCount(value.stagedTokens))
	)
		return undefined

	return {
		taskId,
		revision: value.revision,
		epoch: value.epoch,
		phase: "stable",
		durableContextTokens: value.durableContextTokens,
		pendingSendTokens: 0,
		receivingTokens: 0,
		stagedTokens: value.stagedTokens ?? 0,
		environmentTokens: value.environmentTokens,
		contextWindow: value.contextWindow,
		profileId: typeof value.profileId === "string" ? value.profileId : undefined,
		profileName: typeof value.profileName === "string" ? value.profileName : undefined,
		mode: value.mode,
		updatedAt: value.updatedAt,
		lineage: { kind: "baseline" },
	}
}

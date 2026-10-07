import type { ThinkingConfig } from "@shared/proto/dline/models/metadata"

export interface ThinkingBudgetBounds {
	readonly minimum: number
	readonly maximum?: number
}

/** Validate declared positive-budget bounds without deciding support, mode, defaults, or disabling. */
export function resolveThinkingBudgetBounds(
	declaration: Pick<ThinkingConfig, "minBudget" | "maxBudget">,
): ThinkingBudgetBounds | undefined {
	const { minBudget, maxBudget } = declaration
	if (minBudget !== undefined && (!Number.isSafeInteger(minBudget) || minBudget < 0)) return undefined
	if (maxBudget !== undefined && (!Number.isSafeInteger(maxBudget) || maxBudget <= 0)) return undefined
	// One is the first positive integer, not a provider-specific budget or preference default.
	const minimum = Math.max(1, minBudget ?? 0)
	if (maxBudget !== undefined && minimum > maxBudget) return undefined
	return { minimum, ...(maxBudget !== undefined ? { maximum: maxBudget } : {}) }
}

/** Clamp a positive request preference to valid declared bounds; special wire values belong to providers. */
export function clampThinkingBudget(
	budget: number,
	declaration: Pick<ThinkingConfig, "minBudget" | "maxBudget">,
): number | undefined {
	if (!Number.isSafeInteger(budget) || budget <= 0) return undefined
	const bounds = resolveThinkingBudgetBounds(declaration)
	if (!bounds) return undefined
	return Math.max(bounds.minimum, bounds.maximum === undefined ? budget : Math.min(budget, bounds.maximum))
}

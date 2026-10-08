import { Logger } from "@shared/services/Logger"
import type { Settings } from "@shared/storage/state-keys"
import type { SettingsRepository } from "./settings/SettingsRepository"

/**
 * Settings keys that earlier builds persisted but that no longer exist in the
 * Settings schema.
 *
 * Per-mode model selection now lives in API profiles, and the plain per-mode
 * reasoning effort was replaced by the Task reasoning override. A leftover
 * value is unreadable through the current key partition, so it is removed
 * rather than migrated; tasks that held only the old effort inherit the
 * profile default.
 */
export const REMOVED_SETTINGS_KEYS: readonly string[] = [
	"planModeReasoningEffort",
	"actModeReasoningEffort",
	"planModeOpenRouterModelId",
	"planModeOpenRouterModelInfo",
	"actModeOpenRouterModelId",
	"actModeOpenRouterModelInfo",
	"planModeOcaModelId",
	"planModeOcaModelInfo",
	"planModeOcaReasoningEffort",
	"actModeOcaModelId",
	"actModeOcaModelInfo",
	"actModeOcaReasoningEffort",
]

/** Return the removed keys still present in a settings document, in declaration order. */
export function findRemovedSettingsKeys(values: Readonly<Record<string, unknown>>): string[] {
	return REMOVED_SETTINGS_KEYS.filter((key) => Object.hasOwn(values, key))
}

/**
 * Remove leftover keys from the canonical Settings document.
 *
 * The presence check runs against the cached snapshot first so a clean document
 * costs neither the cross-process lock nor a write. The patch itself is resolved
 * against the latest disk state under the repository lock, so a concurrent
 * window cannot reinstate or lose unrelated values.
 */
export async function cleanupRemovedSettings(repository: SettingsRepository): Promise<readonly string[]> {
	if (findRemovedSettingsKeys(repository.readSnapshot().values).length === 0) return []

	let removed: string[] = []
	await repository.mutateResolved((values) => {
		removed = findRemovedSettingsKeys(values)
		return Object.fromEntries(removed.map((key) => [key, undefined])) as Partial<Settings>
	})
	if (removed.length > 0) {
		Logger.info(`[SettingsCleanup] Removed ${removed.length} legacy keys: ${removed.join(", ")}`)
	}
	return removed
}

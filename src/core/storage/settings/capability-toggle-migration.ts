import type { ClineRulesToggles } from "@shared/cline-rules"
import { Logger } from "@/shared/services/Logger"
import { capabilityResourceId } from "./capability-resource-id"
import type { CapabilityKind } from "./capability-toggle-store"

/**
 * Marker recording the highest key-normalization generation already applied to
 * the workspace preference document.
 *
 * A boolean could not repair a document that a later defect polluted again, so
 * the marker carries a generation and the migration reruns whenever
 * CAPABILITY_KEY_NORMALIZATION_GENERATION is raised.
 */
export const CAPABILITY_KEY_NORMALIZATION_GENERATION_KEY = "__capabilityKeyNormalizationGeneration"

/** Raise this when a new defect makes another normalization pass necessary. */
export const CAPABILITY_KEY_NORMALIZATION_GENERATION = 1

/**
 * Legacy workspace-state maps and the capability kind that now owns them.
 *
 * These names are historical storage facts, not current keys: every entry
 * except `mcpServersToggles` has already been removed from `LocalStateKeys`.
 * They are spelled out as literals so retiring a key from the live enum can
 * never silently drop the one-time migration that carries a user's stored
 * `false` preferences into the scope chain.
 */
export const LEGACY_LOCAL_TOGGLE_KEYS: ReadonlyArray<readonly [key: string, kind: CapabilityKind]> = [
    ["localClineRulesToggles", "rules"],
    ["localCursorRulesToggles", "cursorRules"],
    ["localWindsurfRulesToggles", "windsurfRules"],
    ["localAgentsRulesToggles", "agentsRules"],
    ["localSkillsToggles", "skills"],
    ["localSubagentsToggles", "subagents"],
    ["workflowToggles", "workflows"],
    ["mcpServersToggles", "mcp"],
]

/**
 * Every workspace-state key a previous build may have written.
 *
 * The VSCode-to-file transfer needs this list, not the live `LocalStateKeys`
 * enum: a retired key still exists in an installed user's VSCode storage, and
 * dropping it from the transfer would strip their disabled toggles before this
 * migration ever sees them.
 */
export const LEGACY_WORKSPACE_STATE_KEYS: readonly string[] = LEGACY_LOCAL_TOGGLE_KEYS.map(([key]) => key)

/** Minimal view of the state manager this migration needs. */
export interface LegacyToggleSource {
    getLegacyWorkspaceToggleMap(key: string): Record<string, boolean> | undefined
}

/** One capability kind's normalized overrides, ready to merge into the workspace scope. */
export interface LegacyToggleMigration {
    readonly kind: CapabilityKind
    readonly overrides: ClineRulesToggles
}

/**
 * Convert the legacy full-state maps into sparse overrides.
 *
 * The legacy maps stored every discovered path, including the ones the user
 * never touched. Carrying those over would freeze today's scan result as an
 * explicit preference and defeat inheritance, so only entries that differ from
 * the discovery default (enabled) are treated as a real user decision.
 *
 * Paths are normalized through `capabilityResourceId` so an override survives
 * separator and case differences between launches — the exact drift that used
 * to make toggles reappear as enabled after an update.
 */
export function planLegacyToggleMigration(source: LegacyToggleSource): LegacyToggleMigration[] {
    const migrations: LegacyToggleMigration[] = []

    for (const [key, kind] of LEGACY_LOCAL_TOGGLE_KEYS) {
        const legacy = source.getLegacyWorkspaceToggleMap(key)
        if (!legacy) continue

        const overrides: ClineRulesToggles = {}
        for (const [resourcePath, enabled] of Object.entries(legacy)) {
            if (enabled !== false) continue
            const id = capabilityResourceId(resourcePath)
            if (id === "") continue
            overrides[id] = false
        }

        if (Object.keys(overrides).length > 0) {
            migrations.push({ kind, overrides })
        }
    }

    if (migrations.length > 0) {
        Logger.debug(
            `[CapabilityToggleMigration] Planned ${migrations.length} kinds: ${migrations
                .map((migration) => `${migration.kind}=${Object.keys(migration.overrides).length}`)
                .join(" ")}`,
        )
    }

    return migrations
}

/**
 * Merge migrated overrides into an existing workspace map.
 *
 * An existing override was written by a build that already understands the
 * scope chain, so it wins over the legacy value.
 */
export function mergeMigratedOverrides(
    current: Readonly<ClineRulesToggles> | undefined,
    migrated: Readonly<ClineRulesToggles>,
): ClineRulesToggles {
    return { ...migrated, ...(current ?? {}) }
}

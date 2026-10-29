import type { StateManager } from "@core/storage/StateManager"
import type { ClineRulesToggles } from "@shared/cline-rules"
import type { SettingsKey } from "@shared/storage/state-keys"
import { Logger } from "@/shared/services/Logger"
import { pruneOrphanOverrides } from "./capability-orphan-prune"
import {
    activeCapabilityScope,
    CAPABILITY_SCOPES,
    type CapabilityScope,
    resolveToggles,
    type ScopedToggles,
    withoutToggleOverride,
    withToggleOverride,
} from "./capability-toggle-scopes"

/**
 * The capability families that carry per-scope toggles.
 *
 * "rules" covers Dline's own rule files. Editor-specific rule families keep
 * their own kind because they are discovered from different directories and a
 * user disabling a Cursor rule must not affect a Dline rule with the same name.
 */
export type CapabilityKind =
    | "rules"
    | "workflows"
    | "skills"
    | "subagents"
    | "cursorRules"
    | "windsurfRules"
    | "agentsRules"
    | "mcp"

/** Settings keys holding the sparse override map for one capability kind per scope. */
const SCOPE_KEYS: Record<CapabilityKind, Record<CapabilityScope, SettingsKey>> = {
    rules: {
        global: "globalClineRulesToggles",
        workspace: "workspaceRulesToggles",
        task: "taskRulesToggles",
    },
    workflows: {
        global: "globalWorkflowToggles",
        workspace: "workspaceWorkflowToggles",
        task: "taskWorkflowToggles",
    },
    skills: {
        global: "globalSkillsToggles",
        workspace: "workspaceSkillsToggles",
        task: "taskSkillsToggles",
    },
    subagents: {
        global: "globalSubagentsToggles",
        workspace: "workspaceSubagentsToggles",
        task: "taskSubagentsToggles",
    },
    cursorRules: {
        global: "globalCursorRulesToggles",
        workspace: "workspaceCursorRulesToggles",
        task: "taskCursorRulesToggles",
    },
    windsurfRules: {
        global: "globalWindsurfRulesToggles",
        workspace: "workspaceWindsurfRulesToggles",
        task: "taskWindsurfRulesToggles",
    },
    agentsRules: {
        global: "globalAgentsRulesToggles",
        workspace: "workspaceAgentsRulesToggles",
        task: "taskAgentsRulesToggles",
    },
    mcp: {
        global: "globalMcpToggles",
        workspace: "workspaceMcpToggles",
        task: "taskMcpToggles",
    },
}

/** Settings key holding one capability kind's overrides in a given scope. */
export function capabilityToggleSettingsKey(kind: CapabilityKind, scope: CapabilityScope): SettingsKey {
    return SCOPE_KEYS[kind][scope]
}

/**
 * Read the stored overrides of one capability kind for every scope.
 *
 * This is a pure read: it returns sparse override maps, never the effective
 * state, so callers resolve them against a discovery result.
 */
export function readScopedToggles(stateManager: StateManager, kind: CapabilityKind): ScopedToggles {
    const keys = SCOPE_KEYS[kind]
    return {
        global: stateManager.getScopedCapabilityToggles("global", keys.global) as ClineRulesToggles,
        workspace: stateManager.getScopedCapabilityToggles("workspace", keys.workspace) as ClineRulesToggles,
        task: stateManager.getScopedCapabilityToggles("task", keys.task) as ClineRulesToggles,
    }
}

/**
 * Flatten the scope chain into one override map.
 *
 * Consumers that carry a single toggle map per capability kind use this. It
 * preserves precedence but loses the layer a value came from, so it must not be
 * used where the origin scope matters.
 */
export function mergeScopedToggles(scopes: ScopedToggles): Record<string, boolean> {
    return { ...scopes.global, ...scopes.workspace, ...scopes.task }
}

/**
 * Resolve the effective enabled state of one capability kind against its
 * discovery result, applying global → workspace → task precedence.
 */
export function resolveCapabilityToggles(
    stateManager: StateManager,
    kind: CapabilityKind,
    discovered: Readonly<ClineRulesToggles>,
): ClineRulesToggles {
    return resolveToggles(discovered, readScopedToggles(stateManager, kind))
}

/**
 * Persist one explicit user toggle into the scope that is currently active.
 *
 * The active scope follows the editor: without an open workspace only "global"
 * exists, an open workspace selects "workspace", and entering a task selects
 * "task". Only the changed path is recorded, so every other capability keeps
 * inheriting from the scope above.
 */
export async function setCapabilityEnabled(
    stateManager: StateManager,
    kind: CapabilityKind,
    context: { hasWorkspace: boolean; hasTask: boolean },
    resourcePath: string,
    enabled: boolean,
): Promise<ClineRulesToggles> {
    const scope = activeCapabilityScope(context)
    const key = SCOPE_KEYS[kind][scope]
    return (await stateManager.mutateScopedCapabilityToggles(scope, key, (current) =>
        withToggleOverride(current as ClineRulesToggles, resourcePath, enabled),
    )) as ClineRulesToggles
}

/**
 * Drop one explicit override so the capability inherits from the scope above again.
 */
export async function clearCapabilityOverride(
    stateManager: StateManager,
    kind: CapabilityKind,
    scope: CapabilityScope,
    resourcePath: string,
): Promise<ClineRulesToggles> {
    const key = SCOPE_KEYS[kind][scope]
    return (await stateManager.mutateScopedCapabilityToggles(scope, key, (current) =>
        withoutToggleOverride(current as ClineRulesToggles, resourcePath),
    )) as ClineRulesToggles
}

/**
 * Drop one override from every scope.
 *
 * Used when the underlying resource is gone: leaving an override behind would
 * silently apply to a future resource that happens to reuse the same path.
 */
export async function clearCapabilityOverrideEverywhere(
    stateManager: StateManager,
    kind: CapabilityKind,
    resourcePath: string,
): Promise<void> {
    for (const scope of CAPABILITY_SCOPES) {
        await clearCapabilityOverride(stateManager, kind, scope, resourcePath)
    }
}

/**
 * Drop overrides whose resource no longer exists, in every scope.
 *
 * Callers pass the discovery result as-is; `pruneOrphanOverrides` decides
 * whether the scan is authoritative enough to act on. A non-authoritative scan
 * is a no-op, so a temporarily unreadable directory can never erase a
 * preference.
 */
export async function pruneCapabilityOrphans(
    stateManager: StateManager,
    kind: CapabilityKind,
    discoveredIds: ReadonlySet<string>,
    scanComplete: boolean,
): Promise<number> {
    const keysNormalized = stateManager.hasNormalizedCapabilityKeys
    let removed = 0

    for (const scope of CAPABILITY_SCOPES) {
        const key = SCOPE_KEYS[kind][scope]
        const overrides = stateManager.getScopedCapabilityToggles(scope, key) as ClineRulesToggles
        const result = pruneOrphanOverrides({ overrides, discoveredIds, scanComplete, keysNormalized })
        if (!result.pruned) continue

        await stateManager.mutateScopedCapabilityToggles(scope, key, () => result.pruned as never)
        removed += result.removedIds.length
        Logger.debug(
            `[CapabilityToggle] Pruned ${result.removedIds.length} orphan ${kind} overrides in ${scope}: ${result.removedIds.join(", ")}`,
        )
    }

    return removed
}

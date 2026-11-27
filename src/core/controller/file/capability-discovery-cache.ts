import type { StateManager } from "@core/storage/StateManager"
import type { CapabilityKind } from "@core/storage/settings/capability-toggle-store"
import type { ClineRulesToggles } from "@shared/cline-rules"
import type { GlobalStateKey, LocalStateKey } from "@shared/storage/state-keys"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"

/**
 * Which discovered resources exist, per capability kind and root scope (`local` or `global`).
 *
 * The state push has to tell the webview which resources exist, but discovery
 * runs in its own RPCs and preferences are stored as sparse overrides — an
 * absent path there means "inherit", not "missing". Publishing the override map
 * alone would therefore show an empty list until the user toggled something.
 *
 * The previous build avoided that by letting each scan write its full result
 * back into the preference store, which is exactly how an incomplete scan after
 * an update could erase a user's disabled entries. This module keeps the two
 * facts separate: discovery says what exists, the scope chain says what the
 * user decided, and the state push combines them.
 *
 * Two properties matter for the panel to stay stable:
 *
 *   - A scan that could not read a directory is rejected, so a transient
 *     failure cannot blank the list.
 *   - The last trustworthy result is mirrored into workspace state (for local
 *     resources) or global state (for global resources), so a restart or state
 *     push shows the discovered set instead of an empty sparse override map.
 *
 * The mirror is a display cache, never a preference: a stale entry can only
 * show one extra row until the next scan, and it never changes an enabled
 * state, because the scope chain remains the sole source of user intent.
 */

export type CapabilityDiscoveryScope = "local" | "global"

/** Capability kinds whose local discovery result is mirrored into workspace state. */
const LOCAL_DISCOVERY_STATE_KEYS: Readonly<Partial<Record<CapabilityKind, LocalStateKey>>> = {
    rules: "discoveredRulesToggles",
    workflows: "discoveredWorkflowToggles",
    skills: "discoveredSkillsToggles",
    subagents: "discoveredSubagentsToggles",
    cursorRules: "discoveredCursorRulesToggles",
    windsurfRules: "discoveredWindsurfRulesToggles",
    agentsRules: "discoveredAgentsRulesToggles",
}

/** Capability kinds whose global discovery result is mirrored into global state. */
const GLOBAL_DISCOVERY_STATE_KEYS: Readonly<Partial<Record<CapabilityKind, GlobalStateKey>>> = {
    rules: "discoveredGlobalRulesToggles",
    workflows: "discoveredGlobalWorkflowToggles",
    skills: "discoveredGlobalSkillsToggles",
    subagents: "discoveredGlobalSubagentsToggles",
}

const discoveredTogglesByController = new WeakMap<
    Controller,
    Record<CapabilityDiscoveryScope, Map<CapabilityKind, ClineRulesToggles>>
>()

function cacheFor(controller: Controller, scope: CapabilityDiscoveryScope): Map<CapabilityKind, ClineRulesToggles> {
    let byScope = discoveredTogglesByController.get(controller)
    if (!byScope) {
        byScope = { local: new Map(), global: new Map() }
        discoveredTogglesByController.set(controller, byScope)
    }
    return byScope[scope]
}

/**
 * Record what a scan found for one capability kind in either the local or global root.
 *
 * An incomplete scan is ignored rather than stored: it cannot distinguish "no
 * resources here" from "could not read", and treating the two alike is what
 * made the panel flicker.
 */
export function rememberDiscoveredToggles(
    controller: Controller,
    kind: CapabilityKind,
    discovered: Readonly<ClineRulesToggles>,
    complete: boolean,
    scope: CapabilityDiscoveryScope = "local",
): void {
    if (!complete) {
        Logger.debug(`[CapabilityDiscovery] Ignoring incomplete ${scope} ${kind} scan; keeping the previous result`)
        return
    }

    const snapshot = { ...discovered }
    cacheFor(controller, scope).set(kind, snapshot)
    void persistDiscoveredToggles(controller, kind, snapshot, scope)
}

/** Whether a trustworthy discovery snapshot exists in memory or persisted mirror storage. */
export function hasDiscoveredTogglesSnapshot(
    controller: Controller,
    kind: CapabilityKind,
    scope: CapabilityDiscoveryScope = "local",
): boolean {
    if (discoveredTogglesByController.get(controller)?.[scope].has(kind)) return true
    return Object.keys(readPersistedDiscoveredToggles(controller.stateManager, kind, scope)).length > 0
}

/** Read the last trustworthy scan result for one capability kind and scope. */
export function readDiscoveredToggles(
    controller: Controller,
    kind: CapabilityKind,
    scope: CapabilityDiscoveryScope = "local",
): ClineRulesToggles {
    const cached = discoveredTogglesByController.get(controller)?.[scope].get(kind)
    if (cached) return cached

    // Nothing scanned yet in this session. Fall back to the mirror so a restart
    // shows the previous set instead of an empty panel.
    return readPersistedDiscoveredToggles(controller.stateManager, kind, scope)
}

function readPersistedDiscoveredToggles(
    stateManager: StateManager | undefined,
    kind: CapabilityKind,
    scope: CapabilityDiscoveryScope,
): ClineRulesToggles {
    if (!stateManager) return {}
    if (scope === "global") {
        const key = GLOBAL_DISCOVERY_STATE_KEYS[kind]
        if (!key || typeof stateManager.getGlobalStateKey !== "function") return {}
        return (stateManager.getGlobalStateKey(key) as ClineRulesToggles | undefined) ?? {}
    }
    const key = LOCAL_DISCOVERY_STATE_KEYS[kind]
    if (!key || typeof stateManager.getWorkspaceStateKey !== "function") return {}
    return stateManager.getWorkspaceStateKey(key) ?? {}
}

async function persistDiscoveredToggles(
    controller: Controller,
    kind: CapabilityKind,
    discovered: ClineRulesToggles,
    scope: CapabilityDiscoveryScope,
): Promise<void> {
    const stateManager = controller.stateManager
    if (!stateManager) return
    if (scope === "global") {
        const key = GLOBAL_DISCOVERY_STATE_KEYS[kind]
        if (!key || typeof stateManager.setGlobalState !== "function") return
        try {
            stateManager.setGlobalState(key, discovered)
        } catch (error) {
            Logger.warn(`[CapabilityDiscovery] Failed to persist the global ${kind} discovery snapshot`, error)
        }
        return
    }

    const key = LOCAL_DISCOVERY_STATE_KEYS[kind]
    if (!key || typeof stateManager.setWorkspaceState !== "function") return
    try {
        await stateManager.setWorkspaceState(key, discovered)
    } catch (error) {
        // The mirror only speeds up the next startup; losing it degrades to the
        // pre-scan empty panel rather than breaking the current session.
        Logger.warn(`[CapabilityDiscovery] Failed to persist the ${kind} discovery snapshot`, error)
    }
}

import type { StateManager } from "@core/storage/StateManager"
import type { CapabilityKind } from "@core/storage/settings/capability-toggle-store"
import type { ClineRulesToggles } from "@shared/cline-rules"
import type { LocalStateKey } from "@shared/storage/state-keys"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"

/**
 * Which locally discovered resources exist, per capability kind.
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
 *   - The last trustworthy result is mirrored into workspace state, so a
 *     restart shows the previous set instead of an empty panel until the first
 *     scan settles.
 *
 * The mirror is a display cache, never a preference: a stale entry can only
 * show one extra row until the next scan, and it never changes an enabled
 * state, because the scope chain remains the sole source of user intent.
 */

/** Capability kinds whose local discovery result is mirrored into workspace state. */
const DISCOVERY_STATE_KEYS: Readonly<Partial<Record<CapabilityKind, LocalStateKey>>> = {
    rules: "discoveredRulesToggles",
    workflows: "discoveredWorkflowToggles",
    skills: "discoveredSkillsToggles",
    subagents: "discoveredSubagentsToggles",
    cursorRules: "discoveredCursorRulesToggles",
    windsurfRules: "discoveredWindsurfRulesToggles",
    agentsRules: "discoveredAgentsRulesToggles",
}

const discoveredTogglesByController = new WeakMap<Controller, Map<CapabilityKind, ClineRulesToggles>>()

function cacheFor(controller: Controller): Map<CapabilityKind, ClineRulesToggles> {
    let byKind = discoveredTogglesByController.get(controller)
    if (!byKind) {
        byKind = new Map()
        discoveredTogglesByController.set(controller, byKind)
    }
    return byKind
}

/**
 * Record what a scan found for one capability kind.
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
): void {
    if (!complete) {
        Logger.debug(`[CapabilityDiscovery] Ignoring incomplete ${kind} scan; keeping the previous result`)
        return
    }

    const snapshot = { ...discovered }
    cacheFor(controller).set(kind, snapshot)
    void persistDiscoveredToggles(controller, kind, snapshot)
}

/** Read the last trustworthy scan result for one capability kind. */
export function readDiscoveredToggles(controller: Controller, kind: CapabilityKind): ClineRulesToggles {
    const cached = discoveredTogglesByController.get(controller)?.get(kind)
    if (cached) return cached

    // Nothing scanned yet in this session. Fall back to the mirror so a restart
    // shows the previous set instead of an empty panel.
    return readPersistedDiscoveredToggles(controller.stateManager, kind)
}

function readPersistedDiscoveredToggles(stateManager: StateManager, kind: CapabilityKind): ClineRulesToggles {
    const key = DISCOVERY_STATE_KEYS[kind]
    if (!key) return {}
    return stateManager.getWorkspaceStateKey(key) ?? {}
}

async function persistDiscoveredToggles(
    controller: Controller,
    kind: CapabilityKind,
    discovered: ClineRulesToggles,
): Promise<void> {
    const key = DISCOVERY_STATE_KEYS[kind]
    if (!key) return

    try {
        await controller.stateManager.setWorkspaceState(key, discovered)
    } catch (error) {
        // The mirror only speeds up the next startup; losing it degrades to the
        // pre-scan empty panel rather than breaking the current session.
        Logger.warn(`[CapabilityDiscovery] Failed to persist the ${kind} discovery snapshot`, error)
    }
}

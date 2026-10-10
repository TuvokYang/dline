import type { StateManager } from "@core/storage/StateManager"
import type { CapabilityScope } from "@core/storage/settings/capability-toggle-scopes"
import {
    clearCapabilityOverride,
    readScopedToggles,
    resolveCapabilityToggles,
    setCapabilityEnabled,
} from "@core/storage/settings/capability-toggle-store"
import type { SettingsKey } from "@shared/storage/state-keys"
import { describe, expect, it, vi } from "vitest"

type ToggleMap = Record<string, boolean>

/** Minimal StateManager double keyed by the settings key each scope writes. */
function createStateManager(initial: Partial<Record<SettingsKey, ToggleMap>> = {}) {
    const stored = { ...initial } as Record<string, ToggleMap>
    const writes: Array<{ scope: CapabilityScope; key: SettingsKey }> = []

    const stateManager = {
        getScopedCapabilityToggles: vi.fn((_scope: CapabilityScope, key: SettingsKey) => stored[key] ?? {}),
        mutateScopedCapabilityToggles: vi.fn(
            async (scope: CapabilityScope, key: SettingsKey, resolveValue: (current: ToggleMap) => ToggleMap) => {
                writes.push({ scope, key })
                stored[key] = resolveValue(stored[key] ?? {})
                return stored[key]
            },
        ),
    } as unknown as StateManager

    return { stateManager, stored, writes }
}

describe("capability toggle store", () => {
    it("reads the override map of every scope for one capability kind", () => {
        const { stateManager } = createStateManager({
            globalSkillsToggles: { "/skills/a": false },
            workspaceSkillsToggles: { "/skills/b": false },
            taskSkillsToggles: { "/skills/c": false },
        })

        expect(readScopedToggles(stateManager, "skills")).toEqual({
            global: { "/skills/a": false },
            workspace: { "/skills/b": false },
            task: { "/skills/c": false },
        })
    })

    it("applies global → workspace → task precedence over the discovered default", () => {
        const { stateManager } = createStateManager({
            globalSkillsToggles: { "/skills/a": false, "/skills/b": false },
            workspaceSkillsToggles: { "/skills/b": true },
            taskSkillsToggles: { "/skills/c": false },
        })

        expect(
            resolveCapabilityToggles(stateManager, "skills", {
                "/skills/a": true,
                "/skills/b": true,
                "/skills/c": true,
                "/skills/d": true,
            }),
        ).toEqual({
            "/skills/a": false, // global override
            "/skills/b": true, // workspace overrides global
            "/skills/c": false, // task override
            "/skills/d": true, // inherits the discovered default
        })
    })

    it("keeps the four capability kinds on separate keys", () => {
        const { stateManager } = createStateManager({
            globalSkillsToggles: { "/shared/path": false },
        })

        expect(resolveCapabilityToggles(stateManager, "skills", { "/shared/path": true })).toEqual({
            "/shared/path": false,
        })
        // Rules must not observe the skills preference for the same path.
        expect(resolveCapabilityToggles(stateManager, "rules", { "/shared/path": true })).toEqual({
            "/shared/path": true,
        })
    })

    it("writes an explicit toggle into the scope selected by the editor context", async () => {
        const { stateManager, stored, writes } = createStateManager()

        await setCapabilityEnabled(stateManager, "skills", { hasWorkspace: false, hasTask: false }, "/skills/a", false)
        await setCapabilityEnabled(stateManager, "workflows", { hasWorkspace: true, hasTask: false }, "/wf/a", false)
        await setCapabilityEnabled(stateManager, "rules", { hasWorkspace: true, hasTask: true }, "/rules/a", false)

        expect(writes).toEqual([
            { scope: "global", key: "globalSkillsToggles" },
            { scope: "workspace", key: "workspaceWorkflowToggles" },
            { scope: "task", key: "taskRulesToggles" },
        ])
        expect(stored.globalSkillsToggles).toEqual({ "/skills/a": false })
        expect(stored.workspaceWorkflowToggles).toEqual({ "/wf/a": false })
        expect(stored.taskRulesToggles).toEqual({ "/rules/a": false })
    })

    it("records only the changed path so siblings keep inheriting", async () => {
        const { stateManager, stored } = createStateManager({
            workspaceSkillsToggles: { "/skills/a": false },
        })

        await setCapabilityEnabled(stateManager, "skills", { hasWorkspace: true, hasTask: false }, "/skills/b", false)

        expect(stored.workspaceSkillsToggles).toEqual({ "/skills/a": false, "/skills/b": false })
    })

    it("clearing an override restores inheritance from the scope above", async () => {
        const { stateManager } = createStateManager({
            globalSkillsToggles: { "/skills/a": false },
            workspaceSkillsToggles: { "/skills/a": true },
        })

        expect(resolveCapabilityToggles(stateManager, "skills", { "/skills/a": true })).toEqual({ "/skills/a": true })

        await clearCapabilityOverride(stateManager, "skills", "workspace", "/skills/a")

        expect(resolveCapabilityToggles(stateManager, "skills", { "/skills/a": true })).toEqual({ "/skills/a": false })
    })
})

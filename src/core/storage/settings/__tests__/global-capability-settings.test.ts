import type { StateManager } from "@core/storage/StateManager"
import { resolveToggles } from "@core/storage/settings/capability-toggle-scopes"
import { describe, expect, it, vi } from "vitest"
import { removeGlobalCapability, setGlobalCapabilityEnabled } from "../global-capability-settings"

function createStateManager(initial: Record<string, boolean>) {
    const state = { stored: initial }
    const stateManager = {
        mutateGlobalSettingsKey: vi.fn(async (_key, mutate: (current: Record<string, boolean>) => Record<string, boolean>) => {
            state.stored = mutate(state.stored)
            return state.stored
        }),
    } as unknown as StateManager

    return { state, stateManager }
}

describe("global capability settings", () => {
    it("records an explicit preference without touching unrelated capabilities", async () => {
        const { state, stateManager } = createStateManager({ "/rules/persisted.md": false })

        await setGlobalCapabilityEnabled(stateManager, "globalClineRulesToggles", "/rules/new.md", false)

        expect(state.stored).toEqual({ "/rules/persisted.md": false, "/rules/new.md": false })
    })

    it("deletes only the explicitly removed capability", async () => {
        const { state, stateManager } = createStateManager({
            "/rules/persisted.md": false,
            "/rules/new.md": true,
        })

        await removeGlobalCapability(stateManager, "globalClineRulesToggles", "/rules/persisted.md")

        expect(state.stored).toEqual({ "/rules/new.md": true })
    })

    it("keeps a stored preference authoritative when the capability is rediscovered", async () => {
        const { state, stateManager } = createStateManager({})

        await setGlobalCapabilityEnabled(stateManager, "globalClineRulesToggles", "/rules/persisted.md", false)

        // Discovery reports the rule as available with the default enabled state,
        // but the stored preference must still win.
        expect(resolveToggles({ "/rules/persisted.md": true }, { global: state.stored })).toEqual({
            "/rules/persisted.md": false,
        })
    })
})

import type { StateManager } from "@core/storage/StateManager"
import type { ClineRulesToggles } from "@shared/cline-rules"
import type { SettingsKey } from "@shared/storage/state-keys"
import { describe, expect, it } from "vitest"
import type { CapabilityScope } from "../capability-toggle-scopes"
import { readScopedToggles, setCapabilityEnabled } from "../capability-toggle-store"

/**
 * The three preference scopes must stay separate stores.
 *
 * When two scopes resolve through the same reader, the chain collapses: a task
 * choice leaks into the workspace default, or the task layer reports the value
 * it was supposed to override. The fake below keeps one store per scope, which
 * is exactly the contract StateManager has to honour.
 */
class FakeScopedStore {
    private readonly stores: Record<CapabilityScope, Record<string, unknown>> = {
        global: {},
        workspace: {},
        task: {},
    }

    seed(scope: CapabilityScope, key: SettingsKey, value: ClineRulesToggles): void {
        this.stores[scope][key] = value
    }

    asStateManager(): StateManager {
        return {
            getScopedCapabilityToggles: (scope: CapabilityScope, key: SettingsKey) => this.stores[scope][key] ?? {},
            mutateScopedCapabilityToggles: async (
                scope: CapabilityScope,
                key: SettingsKey,
                resolveValue: (current: unknown) => unknown,
            ) => {
                const next = resolveValue(this.stores[scope][key] ?? {})
                this.stores[scope][key] = next
                return next
            },
        } as unknown as StateManager
    }

    read(scope: CapabilityScope, key: SettingsKey): Record<string, boolean> {
        return (this.stores[scope][key] ?? {}) as Record<string, boolean>
    }
}

describe("Capability scope isolation", () => {
    it("writes a task preference without touching the workspace default", async () => {
        const store = new FakeScopedStore()
        store.seed("workspace", "workspaceSkillsToggles", { "skills/review": true })
        const stateManager = store.asStateManager()

        await setCapabilityEnabled(stateManager, "skills", { hasWorkspace: true, hasTask: true }, "skills/review", false)

        expect(store.read("task", "taskSkillsToggles")).toEqual({ "skills/review": false })
        expect(store.read("workspace", "workspaceSkillsToggles")).toEqual({ "skills/review": true })
    })

    it("writes to the workspace scope when no task is open", async () => {
        const store = new FakeScopedStore()
        const stateManager = store.asStateManager()

        await setCapabilityEnabled(stateManager, "skills", { hasWorkspace: true, hasTask: false }, "skills/review", false)

        expect(store.read("workspace", "workspaceSkillsToggles")).toEqual({ "skills/review": false })
        expect(store.read("task", "taskSkillsToggles")).toEqual({})
    })

    it("falls back to the global scope when there is no workspace", async () => {
        const store = new FakeScopedStore()
        const stateManager = store.asStateManager()

        await setCapabilityEnabled(stateManager, "skills", { hasWorkspace: false, hasTask: false }, "skills/review", false)

        expect(store.read("global", "globalSkillsToggles")).toEqual({ "skills/review": false })
    })

    it("reports each scope's own overrides", () => {
        const store = new FakeScopedStore()
        store.seed("global", "globalSkillsToggles", { "skills/a": false })
        store.seed("workspace", "workspaceSkillsToggles", { "skills/b": false })
        store.seed("task", "taskSkillsToggles", { "skills/c": false })

        expect(readScopedToggles(store.asStateManager(), "skills")).toEqual({
            global: { "skills/a": false },
            workspace: { "skills/b": false },
            task: { "skills/c": false },
        })
    })
})

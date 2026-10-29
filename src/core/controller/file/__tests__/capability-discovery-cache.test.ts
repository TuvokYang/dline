import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Controller } from "../../index"
import { readDiscoveredToggles, rememberDiscoveredToggles } from "../capability-discovery-cache"

/**
 * These cover the two properties that keep the capability panel stable:
 * a failed scan must not blank the list, and a restart must not show an empty
 * panel before the first scan settles.
 */

interface FakeController {
    stateManager: {
        getWorkspaceStateKey: (key: string) => Record<string, boolean> | undefined
        setWorkspaceState: (key: string, value: Record<string, boolean>) => Promise<void>
    }
}

function createController(persisted: Record<string, Record<string, boolean>> = {}): {
    controller: Controller
    persisted: Record<string, Record<string, boolean>>
    setWorkspaceState: ReturnType<typeof vi.fn>
} {
    const setWorkspaceState = vi.fn(async (key: string, value: Record<string, boolean>) => {
        persisted[key] = value
    })
    const fake: FakeController = {
        stateManager: {
            getWorkspaceStateKey: (key: string) => persisted[key],
            setWorkspaceState,
        },
    }
    return { controller: fake as unknown as Controller, persisted, setWorkspaceState }
}

describe("capability discovery cache", () => {
    let rulePath: string

    beforeEach(() => {
        rulePath = "/workspace/.agents/rules/style.md"
    })

    it("publishes what a complete scan found", () => {
        const { controller } = createController()

        rememberDiscoveredToggles(controller, "rules", { [rulePath]: true }, true)

        expect(readDiscoveredToggles(controller, "rules")).toEqual({ [rulePath]: true })
    })

    it("keeps the previous result when a scan could not read its directory", () => {
        const { controller } = createController()
        rememberDiscoveredToggles(controller, "rules", { [rulePath]: true }, true)

        // A transient failure reports an empty list; accepting it would blank the panel.
        rememberDiscoveredToggles(controller, "rules", {}, false)

        expect(readDiscoveredToggles(controller, "rules")).toEqual({ [rulePath]: true })
    })

    it("accepts a complete scan that legitimately found nothing", () => {
        const { controller } = createController()
        rememberDiscoveredToggles(controller, "rules", { [rulePath]: true }, true)

        // The user deleted the rule: an empty but trustworthy scan must win.
        rememberDiscoveredToggles(controller, "rules", {}, true)

        expect(readDiscoveredToggles(controller, "rules")).toEqual({})
    })

    it("restores the previous set from workspace state before the first scan", () => {
        const { controller } = createController({ discoveredRulesToggles: { [rulePath]: true } })

        // Nothing scanned yet in this session, as right after a restart.
        expect(readDiscoveredToggles(controller, "rules")).toEqual({ [rulePath]: true })
    })

    it("mirrors a complete scan into workspace state", async () => {
        const { controller, persisted, setWorkspaceState } = createController()

        rememberDiscoveredToggles(controller, "workflows", { "/workspace/.agents/workflows/release.md": true }, true)
        await vi.waitFor(() => expect(setWorkspaceState).toHaveBeenCalled())

        expect(persisted.discoveredWorkflowToggles).toEqual({ "/workspace/.agents/workflows/release.md": true })
    })

    it("does not mirror an incomplete scan", async () => {
        const { controller, setWorkspaceState } = createController()

        rememberDiscoveredToggles(controller, "workflows", {}, false)

        expect(setWorkspaceState).not.toHaveBeenCalled()
    })

    it("isolates capability kinds from each other", () => {
        const { controller } = createController()

        rememberDiscoveredToggles(controller, "rules", { [rulePath]: true }, true)

        expect(readDiscoveredToggles(controller, "skills")).toEqual({})
    })
})

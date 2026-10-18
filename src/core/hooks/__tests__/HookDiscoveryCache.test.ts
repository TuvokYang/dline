import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../storage/disk", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../storage/disk")>()),
    getHookDirectoryCandidates: async () => ["/hooks"],
}))

import { HookDiscoveryCache } from "../HookDiscoveryCache"
import { HookFactory } from "../hook-factory"

/**
 * TaskStart discovery is read without owning a cold scan, so the cache itself
 * must restore the snapshot after every hook change. These tests drive the
 * cache through the same invalidation the hook RPCs and file watcher use.
 */
describe("HookDiscoveryCache", () => {
    let presentHooks: Set<string>
    let gateFirstProbe: Promise<void> | undefined
    let probe: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        HookDiscoveryCache.resetForTesting()
        presentHooks = new Set()
        gateFirstProbe = undefined
        probe = vi.spyOn(HookFactory, "findHookInHooksDir").mockImplementation(async (hookName, dir) => {
            const gate = gateFirstProbe
            gateFirstProbe = undefined
            // Sample the filesystem state when the probe starts, as a real stat would.
            const exists = presentHooks.has(hookName)
            if (gate) await gate
            return exists ? `${dir}/${hookName}.ps1` : undefined
        })
    })

    afterEach(() => {
        HookDiscoveryCache.resetForTesting()
        vi.restoreAllMocks()
    })

    it("re-warms a resident hook after invalidation so a snapshot read sees the new script", async () => {
        const cache = HookDiscoveryCache.getInstance()
        await expect(cache.keepWarm("TaskStart")).resolves.toEqual([])

        presentHooks.add("TaskStart")
        cache.invalidateAll()

        await vi.waitFor(() => expect(cache.peek("TaskStart")).toEqual(["/hooks/TaskStart.ps1"]))
    })

    it("only re-warms hooks registered as resident", async () => {
        const cache = HookDiscoveryCache.getInstance()
        await cache.get("PreToolUse")
        expect(cache.peek("PreToolUse")).toEqual([])

        cache.invalidateAll()
        await new Promise((resolve) => setTimeout(resolve, 20))

        expect(cache.peek("PreToolUse")).toBeUndefined()
    })

    it("does not let a scan that started before an invalidation publish its stale result", async () => {
        const cache = HookDiscoveryCache.getInstance()
        let releaseStaleProbe!: () => void
        gateFirstProbe = new Promise<void>((resolve) => {
            releaseStaleProbe = resolve
        })
        const staleScan = cache.keepWarm("TaskStart")
        // The first scan has sampled "no hook" before the hook appears.
        await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))

        presentHooks.add("TaskStart")
        cache.invalidateAll()
        await vi.waitFor(() => expect(cache.peek("TaskStart")).toEqual(["/hooks/TaskStart.ps1"]))

        releaseStaleProbe()
        await expect(staleScan).resolves.toEqual([])
        expect(cache.peek("TaskStart")).toEqual(["/hooks/TaskStart.ps1"])
    })

    it("lets a bounded reader join the re-warm started by an invalidation", async () => {
        const cache = HookDiscoveryCache.getInstance()
        await cache.keepWarm("TaskStart")

        presentHooks.add("TaskStart")
        cache.invalidateAll()

        await expect(cache.getWithin("TaskStart", 1_000)).resolves.toEqual(["/hooks/TaskStart.ps1"])
    })
})

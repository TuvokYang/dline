import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { CapabilitySourceSnapshot, CollectCapabilitiesInput } from "./CapabilitiesAggregator"
import { WorkspaceCapabilityCatalogRegistry } from "./WorkspaceCapabilityCatalog"

function sourceSnapshot(skillHash = "skill-v1"): CapabilitySourceSnapshot {
    const skillPath = path.resolve("workspace/.agents/skills/review/SKILL.md")
    const workflowPath = path.resolve("workspace/.agents/workflows/review.md")
    const subagentPath = path.resolve("workspace/.agents/subagents/reviewer.yml")
    return {
        skills: [
            {
                skill: { name: "review", description: "Review code", path: skillPath, source: "project" },
                entry: { name: "review", description: "Review code", contentHash: skillHash },
            },
        ],
        workflows: [
            {
                source: "project",
                path: workflowPath,
                entry: { name: "review-flow", description: "Review workflow", contentHash: "workflow-v1" },
            },
        ],
        subagents: [
            {
                source: "project",
                path: subagentPath,
                entry: { name: "reviewer", description: "Review code", contentHash: "subagent-v1", tools: ["read_file"] },
            },
            { source: "builtin", entry: { name: "default", description: "Default agent" } },
        ],
    }
}

function input(overrides: Partial<CollectCapabilitiesInput> = {}): CollectCapabilitiesInput {
    return { cwd: path.resolve("workspace"), ...overrides }
}

describe("WorkspaceCapabilityCatalogRegistry", () => {
    it("single-flights source collection across tasks and projects task-local toggles in memory", async () => {
        let release: ((snapshot: CapabilitySourceSnapshot) => void) | undefined
        const pending = new Promise<CapabilitySourceSnapshot>((resolve) => {
            release = resolve
        })
        const collectSources = vi.fn(() => pending)
        const registry = new WorkspaceCapabilityCatalogRegistry({ collectSources })
        const skillPath = path.resolve("workspace/.agents/skills/review/SKILL.md")

        const enabled = registry.getCapabilities(input())
        const disabled = registry.getCapabilities(input({ localSkillsToggles: { [skillPath]: false } }))

        expect(collectSources).toHaveBeenCalledTimes(1)
        release?.(sourceSnapshot())
        await expect(enabled).resolves.toMatchObject({ skills: [{ name: "review" }] })
        await expect(disabled).resolves.toMatchObject({ skills: [] })
        expect(collectSources).toHaveBeenCalledTimes(1)

        await registry.getCapabilities(input({ localSkillsToggles: { [skillPath]: true } }))
        expect(collectSources).toHaveBeenCalledTimes(1)
    })

    it("coalesces repeated workspace invalidations into one refresh and publishes one revision", async () => {
        const collectSources = vi
            .fn<() => Promise<CapabilitySourceSnapshot>>()
            .mockResolvedValueOnce(sourceSnapshot("skill-v1"))
            .mockResolvedValueOnce(sourceSnapshot("skill-v2"))
            .mockResolvedValueOnce(sourceSnapshot("skill-v3"))
        const registry = new WorkspaceCapabilityCatalogRegistry({ collectSources })
        const firstListener = vi.fn()
        const secondListener = vi.fn()
        const firstSubscription = registry.subscribe(input().cwd, firstListener)
        const secondSubscription = registry.subscribe(input().cwd, secondListener)

        await registry.getCapabilities(input())
        const change = {}
        registry.invalidateWorkspace(input().cwd, change)
        registry.invalidateWorkspace(input().cwd, change)
        const refreshed = await registry.getSourceSnapshot(input())

        expect(collectSources).toHaveBeenCalledTimes(2)
        expect(refreshed.revision).toBe(2)
        expect(refreshed.sources.skills[0]?.entry.contentHash).toBe("skill-v2")
        expect(firstListener).toHaveBeenCalledTimes(1)
        expect(firstListener).toHaveBeenCalledWith(refreshed)
        expect(secondListener).toHaveBeenCalledTimes(1)
        expect(secondListener).toHaveBeenCalledWith(refreshed)

        firstSubscription.dispose()
        registry.invalidateWorkspace(input().cwd)
        const afterDispose = await registry.getSourceSnapshot(input())
        expect(collectSources).toHaveBeenCalledTimes(3)
        expect(afterDispose.revision).toBe(3)
        expect(firstListener).toHaveBeenCalledTimes(1)
        expect(secondListener).toHaveBeenCalledTimes(2)
        expect(secondListener).toHaveBeenLastCalledWith(afterDispose)
        secondSubscription.dispose()
    })

    it("owns remote source input and freezes the nested snapshot graph", async () => {
        const collectedContents: string[] = []
        const collectSources = vi.fn(async (collectionInput) => {
            collectedContents.push(collectionInput.remoteSkillEntries?.[0]?.contents ?? "")
            return sourceSnapshot()
        })
        const registry = new WorkspaceCapabilityCatalogRegistry({ collectSources })
        const remoteSkillEntries = [{ name: "remote", contents: "skill-v1", alwaysEnabled: false }]
        const firstInput = input({ remoteSkillEntries })

        const snapshot = await registry.getSourceSnapshot(firstInput)

        expect(Object.isFrozen(snapshot)).toBe(true)
        expect(Object.isFrozen(snapshot.sources)).toBe(true)
        expect(Object.isFrozen(snapshot.sources.skills)).toBe(true)
        expect(Object.isFrozen(snapshot.sources.skills[0])).toBe(true)
        expect(Object.isFrozen(snapshot.sources.skills[0]?.skill)).toBe(true)
        expect(Object.isFrozen(snapshot.sources.skills[0]?.entry)).toBe(true)
        expect(Object.isFrozen(snapshot.sources.subagents[0]?.entry.tools)).toBe(true)

        remoteSkillEntries[0].contents = "skill-v2"
        registry.invalidateWorkspace(firstInput.cwd)
        await registry.getSourceSnapshot(
            input({ remoteSkillEntries: [{ name: "remote", contents: "skill-v1", alwaysEnabled: false }] }),
        )

        expect(collectedContents).toEqual(["skill-v1", "skill-v1"])
    })

    it("keeps different remote source documents in separate canonical snapshots", async () => {
        const collectSources = vi.fn(async () => sourceSnapshot())
        const registry = new WorkspaceCapabilityCatalogRegistry({ collectSources })

        await registry.getCapabilities(
            input({ remoteSkillEntries: [{ name: "a", contents: "---\nname: a\ndescription: A\n---", alwaysEnabled: false }] }),
        )
        await registry.getCapabilities(
            input({ remoteSkillEntries: [{ name: "b", contents: "---\nname: b\ndescription: B\n---", alwaysEnabled: false }] }),
        )

        expect(collectSources).toHaveBeenCalledTimes(2)
    })
})

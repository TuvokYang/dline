import * as path from "path"
import { describe, expect, it, vi } from "vitest"
import { NestedRepositoryBoundaryDetector, type NestedRepositoryProbe } from "../NestedRepositoryBoundaryDetector"

const WORKTREE_ROOT = path.resolve("checkpoint-detector-workspace")

function workspacePath(...segments: string[]): string {
    return path.join(WORKTREE_ROOT, ...segments)
}

/** Probe backed by an explicit set of directories that own a `.git` marker. */
function createProbe(markedDirectories: string[]): NestedRepositoryProbe & { hasGitMarker: ReturnType<typeof vi.fn> } {
    const marked = new Set(markedDirectories.map((directory) => path.resolve(directory)))
    const hasGitMarker = vi.fn(async (directory: string) => marked.has(path.resolve(directory)))
    return { hasGitMarker }
}

describe("NestedRepositoryBoundaryDetector", () => {
    it("treats a file under a nested repository as nested", async () => {
        const probe = createProbe([workspacePath(".worktree", "feature")])
        const detector = new NestedRepositoryBoundaryDetector(WORKTREE_ROOT, [], probe)

        await expect(detector.isInsideNestedRepository(workspacePath(".worktree", "feature", "src", "owned.ts"))).resolves.toBe(
            true,
        )
    })

    it("treats a root workspace file as owned by the root repository", async () => {
        const probe = createProbe([workspacePath(".worktree", "feature")])
        const detector = new NestedRepositoryBoundaryDetector(WORKTREE_ROOT, [], probe)

        await expect(detector.isInsideNestedRepository(workspacePath("src", "root.ts"))).resolves.toBe(false)
    })

    it("does not treat the worktree root's own .git as a nested boundary", async () => {
        const probe = createProbe([WORKTREE_ROOT])
        const detector = new NestedRepositoryBoundaryDetector(WORKTREE_ROOT, [], probe)

        await expect(detector.isInsideNestedRepository(workspacePath("src", "root.ts"))).resolves.toBe(false)
    })

    it("recognises a repository created after the detector was constructed", async () => {
        const marked = new Set<string>()
        const probe: NestedRepositoryProbe = {
            hasGitMarker: async (directory: string) => marked.has(path.resolve(directory)),
        }
        let currentTime = 1_000
        const detector = new NestedRepositoryBoundaryDetector(WORKTREE_ROOT, [], probe, () => currentTime)
        const lateFile = workspacePath(".worktree", "feature", "src", "owned.ts")

        await expect(detector.isInsideNestedRepository(lateFile)).resolves.toBe(false)

        // The agent runs `git worktree add` mid-task.
        marked.add(path.resolve(workspacePath(".worktree", "feature")))
        currentTime += 60_000

        await expect(detector.isInsideNestedRepository(lateFile)).resolves.toBe(true)
    })

    it("caches positive results so an established boundary is not re-probed", async () => {
        const probe = createProbe([workspacePath("packages", "nested")])
        const detector = new NestedRepositoryBoundaryDetector(WORKTREE_ROOT, [], probe)
        const nestedFile = workspacePath("packages", "nested", "src", "owned.ts")

        await detector.isInsideNestedRepository(nestedFile)
        const probeCallsAfterFirstResolve = probe.hasGitMarker.mock.calls.length
        await detector.isInsideNestedRepository(nestedFile)

        expect(probe.hasGitMarker.mock.calls.length).toBe(probeCallsAfterFirstResolve)
    })

    it("honours a seeded boundary without probing it", async () => {
        const probe = createProbe([])
        const detector = new NestedRepositoryBoundaryDetector(WORKTREE_ROOT, ["packages/nested"], probe)

        await expect(detector.isInsideNestedRepository(workspacePath("packages", "nested", "owned.ts"))).resolves.toBe(true)
        expect(probe.hasGitMarker).not.toHaveBeenCalled()
    })

    it("resolves a seeded boundary for a deeply nested file after reaching the cached entry", async () => {
        const probe = createProbe([])
        const detector = new NestedRepositoryBoundaryDetector(WORKTREE_ROOT, ["packages/nested"], probe)

        await expect(detector.isInsideNestedRepository(workspacePath("packages", "nested", "src", "owned.ts"))).resolves.toBe(
            true,
        )
        // Only the uncached intermediate directory is probed; the boundary itself
        // is answered from the seeded cache.
        expect(probe.hasGitMarker.mock.calls.map(([directory]) => path.resolve(directory as string))).toEqual([
            path.resolve(workspacePath("packages", "nested", "src")),
        ])
    })

    it("stops the upward walk at the worktree root", async () => {
        const probe = createProbe([path.dirname(WORKTREE_ROOT)])
        const detector = new NestedRepositoryBoundaryDetector(WORKTREE_ROOT, [], probe)

        await expect(detector.isInsideNestedRepository(workspacePath("src", "root.ts"))).resolves.toBe(false)
        for (const [directory] of probe.hasGitMarker.mock.calls) {
            expect(path.resolve(directory as string).startsWith(WORKTREE_ROOT)).toBe(true)
        }
    })
})

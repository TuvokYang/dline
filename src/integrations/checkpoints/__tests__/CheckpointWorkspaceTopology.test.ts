import { describe, expect, it, vi } from "vitest"
import { type CheckpointTopologyProbe, detectCheckpointWorkspaceTopology } from "../CheckpointWorkspaceTopology"

function createProbe(overrides: Partial<CheckpointTopologyProbe> = {}): CheckpointTopologyProbe {
    return {
        inspectRepository: vi.fn().mockResolvedValue({ relation: "none", head: "absent" }),
        findGitMarkers: vi.fn().mockResolvedValue([]),
        readGitmodules: vi.fn().mockResolvedValue(undefined),
        inspectBoundaryHead: vi.fn().mockResolvedValue("committed"),
        ...overrides,
    }
}

describe("detectCheckpointWorkspaceTopology", () => {
    it.each([
        [{ relation: "none", head: "absent" }, "none", "absent"],
        [{ relation: "workspace", head: "unborn" }, "workspace", "unborn"],
        [{ relation: "workspace", head: "committed" }, "workspace", "committed"],
        [{ relation: "ancestor", head: "committed" }, "ancestor", "committed"],
    ] as const)("keeps shadow checkpoints available for %o", async (repository, relation, head) => {
        const topology = await detectCheckpointWorkspaceTopology(
            "C:/workspace",
            createProbe({
                inspectRepository: vi.fn().mockResolvedValue(repository),
            }),
        )

        expect(topology.fileCheckpointsAvailable).toBe(true)
        expect(topology.repository).toEqual({ relation, head })
    })

    it("classifies initialized, uninitialized, and unborn repository boundaries without mutating git metadata", async () => {
        const inspectBoundaryHead = vi.fn(async (_workspacePath: string, relativePath: string) =>
            relativePath === "packages/unborn" ? ("unborn" as const) : ("committed" as const),
        )
        const probe = createProbe({
            findGitMarkers: vi
                .fn()
                .mockResolvedValue(["packages/initialized/.git", "packages/nested/.git", "packages/unborn/.git"]),
            readGitmodules: vi.fn().mockResolvedValue(`
[submodule "initialized"]
	path = packages/initialized
[submodule "missing"]
	path = packages/missing
`),
            inspectBoundaryHead,
        })

        const topology = await detectCheckpointWorkspaceTopology("C:/workspace", probe)

        expect(topology.boundaries).toEqual([
            { relativePath: "packages/initialized", kind: "submodule", initialized: true, head: "committed" },
            { relativePath: "packages/missing", kind: "submodule", initialized: false, head: "absent" },
            { relativePath: "packages/nested", kind: "nested_repo", initialized: true, head: "committed" },
            { relativePath: "packages/unborn", kind: "nested_repo", initialized: true, head: "unborn" },
        ])
        expect(topology.exclusionPatterns).toEqual([
            "/packages/initialized/",
            "/packages/missing/",
            "/packages/nested/",
            "/packages/unborn/",
        ])
        expect(inspectBoundaryHead).toHaveBeenCalledTimes(3)
    })
})

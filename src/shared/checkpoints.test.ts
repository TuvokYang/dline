import * as path from "path"
import { describe, expect, it } from "vitest"
import { checkpointReferenceSetsEqual, getCheckpointHashForWorkspace } from "./checkpoints"

describe("checkpoint reference sets", () => {
	it("uses positional fallback only for legacy references without root metadata", () => {
		const rootA = path.resolve("C:/workspace-a")
		const rootB = path.resolve("C:/workspace-b")
		const rootC = path.resolve("C:/workspace-c")

		expect(
			getCheckpointHashForWorkspace({ hashes: ["hash-a", "hash-b"], workspaceRoots: [rootA, rootB] }, rootC, 1),
		).toBeUndefined()
		expect(getCheckpointHashForWorkspace({ hashes: ["legacy-a", "legacy-b"], workspaceRoots: [] }, rootC, 1)).toBe("legacy-b")
	})

	it("compares root-aware references by workspace identity instead of array position", () => {
		const rootA = path.resolve("C:/workspace-a")
		const rootB = path.resolve("C:/workspace-b")
		const rootC = path.resolve("C:/workspace-c")

		expect(
			checkpointReferenceSetsEqual(
				{ hashes: ["hash-a", "hash-b"], workspaceRoots: [rootA, rootB] },
				{ hashes: ["hash-b", "hash-a"], workspaceRoots: [rootB, rootA] },
			),
		).toBe(true)
		expect(
			checkpointReferenceSetsEqual(
				{ hashes: ["hash-a", "hash-b"], workspaceRoots: [rootA, rootB] },
				{ hashes: ["hash-a", "hash-b"], workspaceRoots: [rootA, rootC] },
			),
		).toBe(false)
	})
})

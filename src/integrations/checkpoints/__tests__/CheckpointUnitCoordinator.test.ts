import type CheckpointTracker from "@integrations/checkpoints/CheckpointTracker"
import type { TaskFileTracker } from "@integrations/checkpoints/TaskFileTracker"
import { VcsType, type WorkspaceRoot } from "@shared/multi-root/types"
import * as path from "path"
import { describe, expect, it, vi } from "vitest"
import { CheckpointUnitCoordinator } from "../CheckpointUnitCoordinator"

function root(rootPath: string, name: string): WorkspaceRoot {
	return { path: rootPath, name, vcs: VcsType.None }
}

function tracker(hash: string) {
	return {
		commitForFiles: vi.fn().mockResolvedValue(hash),
		restoreFiles: vi.fn().mockResolvedValue(undefined),
		resetHead: vi.fn().mockResolvedValue(undefined),
		getDiffSet: vi.fn().mockResolvedValue([]),
		getTaskDiffSet: vi.fn().mockResolvedValue([]),
		getTaskDiffCount: vi.fn().mockResolvedValue(0),
		getConsecutiveStagingFailures: vi.fn().mockReturnValue(0),
	} as unknown as CheckpointTracker
}

function taskFiles(files: string[], scanRequired = false): TaskFileTracker {
	return {
		getModifiedFiles: vi.fn().mockReturnValue(files),
		isWorkspaceScanRequired: vi.fn().mockReturnValue(scanRequired),
		dropModifiedFiles: vi.fn(),
		clearWorkspaceScanRequired: vi.fn(),
	} as unknown as TaskFileTracker
}

describe("CheckpointUnitCoordinator", () => {
	it("commits every workspace root and preserves root-aligned references", async () => {
		const rootA = path.resolve("C:/workspace-a")
		const rootB = path.resolve("C:/workspace-b")
		const fileA = path.join(rootA, "src", "a.ts")
		const fileB = path.join(rootB, "src", "b.ts")
		const trackerA = tracker("hash-a")
		const trackerB = tracker("hash-b")
		const trackedFiles = taskFiles([fileA, fileB])
		const createCheckpointTracker = vi.fn(async (_taskId: string, _enabled: boolean, workspacePath: string) =>
			workspacePath === rootA ? trackerA : trackerB,
		)
		const coordinator = new CheckpointUnitCoordinator({
			taskId: "task-1",
			enableCheckpoints: true,
			roots: [root(rootA, "a"), root(rootB, "b")],
			primaryRootIndex: 0,
			taskFileTracker: trackedFiles,
			createCheckpointTracker,
		})

		const references = await coordinator.commit()

		expect(references).toEqual({ hashes: ["hash-a", "hash-b"], workspaceRoots: [rootA, rootB] })
		expect(trackerA.commitForFiles).toHaveBeenCalledWith([fileA], { forceWorkspaceScan: false })
		expect(trackerB.commitForFiles).toHaveBeenCalledWith([fileB], { forceWorkspaceScan: false })
		expect(trackedFiles.dropModifiedFiles).toHaveBeenCalledWith(expect.arrayContaining([fileA, fileB]))
	})

	it("keeps successful roots usable when another root cannot initialize", async () => {
		const rootA = path.resolve("C:/workspace-a")
		const rootB = path.resolve("C:/workspace-b")
		const trackerA = tracker("hash-a")
		const coordinator = new CheckpointUnitCoordinator({
			taskId: "task-1",
			enableCheckpoints: true,
			roots: [root(rootA, "a"), root(rootB, "b")],
			primaryRootIndex: 0,
			createCheckpointTracker: vi.fn(async (_taskId, _enabled, workspacePath) => {
				if (workspacePath === rootB) throw new Error("secondary unavailable")
				return trackerA
			}),
		})

		const references = await coordinator.commit()
		const outcome = await coordinator.restore({ hashes: ["hash-a", "hash-b"], workspaceRoots: [rootA, rootB] }, [])

		expect(references).toEqual({ hashes: ["hash-a", ""], workspaceRoots: [rootA, rootB] })
		expect(outcome.restoredWorkspacePaths).toEqual([rootA])
		expect(outcome.restoredReferences).toEqual({ hashes: ["hash-a", ""], workspaceRoots: [rootA, rootB] })
		expect(outcome.failures).toEqual([{ workspacePath: rootB, reason: "secondary unavailable" }])
		expect(trackerA.resetHead).toHaveBeenCalledWith("hash-a")
	})

	it("uses persisted root identity when workspace root order changes", async () => {
		const rootA = path.resolve("C:/workspace-a")
		const rootB = path.resolve("C:/workspace-b")
		const trackerA = tracker("new-a")
		const trackerB = tracker("new-b")
		const coordinator = new CheckpointUnitCoordinator({
			taskId: "task-1",
			enableCheckpoints: true,
			roots: [root(rootB, "b"), root(rootA, "a")],
			primaryRootIndex: 0,
			createCheckpointTracker: vi.fn(async (_taskId, _enabled, workspacePath) =>
				workspacePath === rootA ? trackerA : trackerB,
			),
		})

		await coordinator.restore({ hashes: ["old-a", "old-b"], workspaceRoots: [rootA, rootB] }, [])

		expect(trackerA.resetHead).toHaveBeenCalledWith("old-a")
		expect(trackerB.resetHead).toHaveBeenCalledWith("old-b")
	})

	it("aggregates task-owned diffs and completion counts across roots", async () => {
		const rootA = path.resolve("C:/workspace-a")
		const rootB = path.resolve("C:/workspace-b")
		const trackerA = tracker("hash-a")
		const trackerB = tracker("hash-b")
		vi.mocked(trackerA.getTaskDiffSet).mockResolvedValue([
			{ relativePath: "a.ts", absolutePath: path.join(rootA, "a.ts"), before: "a0", after: "a1" },
		])
		vi.mocked(trackerB.getTaskDiffSet).mockResolvedValue([
			{ relativePath: "b.ts", absolutePath: path.join(rootB, "b.ts"), before: "b0", after: "b1" },
		])
		vi.mocked(trackerA.getTaskDiffCount).mockResolvedValue(1)
		vi.mocked(trackerB.getTaskDiffCount).mockResolvedValue(2)
		const coordinator = new CheckpointUnitCoordinator({
			taskId: "task-1",
			enableCheckpoints: true,
			roots: [root(rootA, "a"), root(rootB, "b")],
			primaryRootIndex: 0,
			createCheckpointTracker: vi.fn(async (_taskId, _enabled, workspacePath) =>
				workspacePath === rootA ? trackerA : trackerB,
			),
		})
		const base = { hashes: ["base-a", "base-b"], workspaceRoots: [rootA, rootB] }
		const target = { hashes: ["target-a", "target-b"], workspaceRoots: [rootA, rootB] }

		const diffOutcome = await coordinator.getDiffSet(target, base, true)
		const countOutcome = await coordinator.getTaskDiffCount(base, target)

		expect(diffOutcome.changedFiles.map((file) => file.relativePath)).toEqual(["a.ts", "b.ts"])
		expect(diffOutcome.failures).toEqual([])
		expect(countOutcome).toEqual({ count: 3, failures: [] })
	})

	it("forces every ready root to scan after a terminal command", async () => {
		const rootA = path.resolve("C:/workspace-a")
		const rootB = path.resolve("C:/workspace-b")
		const trackerA = tracker("hash-a")
		const trackerB = tracker("hash-b")
		const trackedFiles = taskFiles([], true)
		const coordinator = new CheckpointUnitCoordinator({
			taskId: "task-1",
			enableCheckpoints: true,
			roots: [root(rootA, "a"), root(rootB, "b")],
			primaryRootIndex: 0,
			taskFileTracker: trackedFiles,
			createCheckpointTracker: vi.fn(async (_taskId, _enabled, workspacePath) =>
				workspacePath === rootA ? trackerA : trackerB,
			),
		})

		await coordinator.commit()

		expect(trackerA.commitForFiles).toHaveBeenCalledWith([], { forceWorkspaceScan: true })
		expect(trackerB.commitForFiles).toHaveBeenCalledWith([], { forceWorkspaceScan: true })
		expect(trackedFiles.clearWorkspaceScanRequired).toHaveBeenCalledOnce()
	})

	it("does not reuse a stale root revision when the current commit fails", async () => {
		const rootA = path.resolve("C:/workspace-a")
		const rootB = path.resolve("C:/workspace-b")
		const trackerA = tracker("unused-a")
		const trackerB = tracker("unused-b")
		vi.mocked(trackerA.commitForFiles).mockResolvedValueOnce("hash-a1").mockResolvedValueOnce("hash-a2")
		vi.mocked(trackerB.commitForFiles).mockResolvedValueOnce("hash-b1").mockResolvedValueOnce(undefined)
		const coordinator = new CheckpointUnitCoordinator({
			taskId: "task-1",
			enableCheckpoints: true,
			roots: [root(rootA, "a"), root(rootB, "b")],
			primaryRootIndex: 0,
			createCheckpointTracker: vi.fn(async (_taskId, _enabled, workspacePath) =>
				workspacePath === rootA ? trackerA : trackerB,
			),
		})

		expect(await coordinator.commit()).toEqual({ hashes: ["hash-a1", "hash-b1"], workspaceRoots: [rootA, rootB] })
		expect(await coordinator.commit()).toEqual({ hashes: ["hash-a2", ""], workspaceRoots: [rootA, rootB] })
	})

	it("preserves healthy root diffs when another root fails", async () => {
		const rootA = path.resolve("C:/workspace-a")
		const rootB = path.resolve("C:/workspace-b")
		const trackerA = tracker("hash-a")
		const trackerB = tracker("hash-b")
		vi.mocked(trackerA.getTaskDiffSet).mockResolvedValue([
			{ relativePath: "a.ts", absolutePath: path.join(rootA, "a.ts"), before: "a0", after: "a1" },
		])
		vi.mocked(trackerB.getTaskDiffSet).mockRejectedValue(new Error("broken shadow repo"))
		vi.mocked(trackerA.getTaskDiffCount).mockResolvedValue(1)
		vi.mocked(trackerB.getTaskDiffCount).mockRejectedValue(new Error("broken shadow repo"))
		const coordinator = new CheckpointUnitCoordinator({
			taskId: "task-1",
			enableCheckpoints: true,
			roots: [root(rootA, "a"), root(rootB, "b")],
			primaryRootIndex: 0,
			createCheckpointTracker: vi.fn(async (_taskId, _enabled, workspacePath) =>
				workspacePath === rootA ? trackerA : trackerB,
			),
		})
		const base = { hashes: ["base-a", "base-b"], workspaceRoots: [rootA, rootB] }
		const target = { hashes: ["target-a", "target-b"], workspaceRoots: [rootA, rootB] }

		const diffOutcome = await coordinator.getDiffSet(target, base, true)
		const countOutcome = await coordinator.getTaskDiffCount(base, target)

		expect(diffOutcome.changedFiles.map((file) => file.relativePath)).toEqual(["a.ts"])
		expect(diffOutcome.failures).toEqual([{ workspacePath: rootB, reason: "broken shadow repo" }])
		expect(countOutcome).toEqual({ count: 1, failures: [{ workspacePath: rootB, reason: "broken shadow repo" }] })
	})

	it("does not route a removed root revision to a newly opened root", async () => {
		const rootA = path.resolve("C:/workspace-a")
		const rootB = path.resolve("C:/workspace-b")
		const rootC = path.resolve("C:/workspace-c")
		const trackerB = tracker("hash-b")
		const trackerC = tracker("hash-c")
		const coordinator = new CheckpointUnitCoordinator({
			taskId: "task-1",
			enableCheckpoints: true,
			roots: [root(rootB, "b"), root(rootC, "c")],
			primaryRootIndex: 0,
			createCheckpointTracker: vi.fn(async (_taskId, _enabled, workspacePath) =>
				workspacePath === rootB ? trackerB : trackerC,
			),
		})

		const outcome = await coordinator.restore({ hashes: ["old-a", "old-b"], workspaceRoots: [rootA, rootB] }, [])

		expect(trackerB.resetHead).toHaveBeenCalledWith("old-b")
		expect(trackerC.resetHead).not.toHaveBeenCalled()
		expect(outcome.restoredReferences).toEqual({ hashes: ["old-b", ""], workspaceRoots: [rootB, rootC] })
		expect(outcome.failures).toEqual([{ workspacePath: rootA, reason: "Workspace root is not currently open" }])
	})
})

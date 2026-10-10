import fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import simpleGit, { type SimpleGit } from "simple-git"
import { afterEach, describe, expect, it, vi } from "vitest"
import { GitOperations } from "../CheckpointGitOperations"
import CheckpointTracker from "../CheckpointTracker"
import { getShadowGitPath, hashWorkingDir } from "../CheckpointUtils"
import { NestedRepositoryBoundaryDetector } from "../NestedRepositoryBoundaryDetector"
import { TaskFileTracker } from "../TaskFileTracker"

function createGitHarness(): { git: SimpleGit; add: ReturnType<typeof vi.fn> } {
    const add = vi.fn().mockResolvedValue(undefined)
    return {
        git: { add } as unknown as SimpleGit,
        add,
    }
}

function configureNestedRepositoryBoundary(operations: GitOperations, relativePath: string): void {
    const workspacePath = (operations as unknown as { cwd: string }).cwd
    Object.assign(operations, {
        boundaryDetector: new NestedRepositoryBoundaryDetector(workspacePath, [relativePath]),
    })
}

/** Create a real nested repository marker so lazy detection can observe it. */
async function createNestedRepositoryMarker(nestedRepositoryPath: string): Promise<void> {
    await fs.mkdir(path.join(nestedRepositoryPath, ".git"), { recursive: true })
}

describe("CheckpointTracker baseline checkpoints", () => {
    it("returns a restorable shadow hash for an unborn user repository before any task files are tracked", async () => {
        const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "dline-unborn-checkpoint-"))
        const workspacePath = path.join(sandbox, "workspace")
        const documentsPath = path.join(sandbox, "documents")
        const previousDocumentsPath = process.env.DLINE_DOCS_DIR
        process.env.DLINE_DOCS_DIR = documentsPath
        await fs.mkdir(workspacePath, { recursive: true })
        await fs.writeFile(path.join(workspacePath, "initial.txt"), "baseline")
        await simpleGit(workspacePath).init()

        try {
            const tracker = await CheckpointTracker.create("task-unborn", true, workspacePath)
            if (!tracker) throw new Error("checkpoint_tracker_missing")
            tracker.setTaskFileTracker(new TaskFileTracker("task-unborn"))

            const checkpointHash = await tracker.commit()
            const shadowGitPath = await getShadowGitPath(hashWorkingDir(workspacePath))
            const shadowGit = simpleGit(path.dirname(shadowGitPath))
            const shadowHead = await shadowGit.revparse(["HEAD"])
            const userBranch = await simpleGit(workspacePath).branchLocal()

            expect(checkpointHash).toBe(shadowHead.trim())
            expect(userBranch.current).toBe("")
        } finally {
            if (previousDocumentsPath === undefined) delete process.env.DLINE_DOCS_DIR
            else process.env.DLINE_DOCS_DIR = previousDocumentsPath
            await fs.rm(sandbox, { recursive: true, force: true })
        }
    })
})

describe("GitOperations repository boundaries", () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("stages root files while excluding tracked files owned by a nested repository", async () => {
        const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "dline-checkpoint-boundary-"))
        const workspacePath = path.join(sandbox, "workspace")
        const rootFile = path.join(workspacePath, "src", "root.ts")
        const nestedFile = path.join(workspacePath, "packages", "nested", "src", "owned.ts")
        await fs.mkdir(path.dirname(rootFile), { recursive: true })
        await fs.mkdir(path.dirname(nestedFile), { recursive: true })
        await fs.writeFile(rootFile, "root")
        await fs.writeFile(nestedFile, "nested")
        try {
            const operations = new GitOperations(workspacePath)
            configureNestedRepositoryBoundary(operations, "packages/nested")
            const harness = createGitHarness()

            const result = await operations.addCheckpointFiles({
                git: harness.git,
                mode: "tracked",
                fileList: [rootFile, nestedFile],
                taskId: "task-1",
            })

            expect(result).toMatchObject({ success: true, stagedCount: 1 })
            expect(result.rejectedPaths).toEqual(["packages/nested/src/owned.ts"])
            expect(harness.add).toHaveBeenCalledOnce()
            expect(harness.add).toHaveBeenCalledWith(["-A", "-f", "--", ":(literal)src/root.ts"])
        } finally {
            await fs.rm(sandbox, { recursive: true, force: true })
        }
    })

    it("excludes files owned by a repository created after the tracker started", async () => {
        const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "dline-checkpoint-late-boundary-"))
        const workspacePath = path.join(sandbox, "workspace")
        const rootFile = path.join(workspacePath, "src", "root.ts")
        const lateRepositoryPath = path.join(workspacePath, ".worktree", "feature")
        const lateFile = path.join(lateRepositoryPath, "src", "owned.ts")
        await fs.mkdir(path.dirname(rootFile), { recursive: true })
        await fs.mkdir(path.dirname(lateFile), { recursive: true })
        await fs.writeFile(rootFile, "root")
        await fs.writeFile(lateFile, "late")
        try {
            // No seeded boundary: the repository appears only on disk, exactly as it
            // would when the agent runs `git worktree add` mid-task.
            const operations = new GitOperations(workspacePath)
            await createNestedRepositoryMarker(lateRepositoryPath)
            const harness = createGitHarness()

            const result = await operations.addCheckpointFiles({
                git: harness.git,
                mode: "tracked",
                fileList: [rootFile, lateFile],
                taskId: "task-late-boundary",
            })

            expect(result).toMatchObject({ success: true, stagedCount: 1 })
            expect(result.rejectedPaths).toEqual([".worktree/feature/src/owned.ts"])
            expect(harness.add).toHaveBeenCalledWith(["-A", "-f", "--", ":(literal)src/root.ts"])
        } finally {
            await fs.rm(sandbox, { recursive: true, force: true })
        }
    })

    it("reports nested files as rejected instead of failing when every tracked file is nested", async () => {
        const workspacePath = path.resolve("checkpoint-test-workspace")
        const operations = new GitOperations(workspacePath)
        configureNestedRepositoryBoundary(operations, "packages/nested")
        const harness = createGitHarness()
        const nestedFile = path.join(workspacePath, "packages", "nested", "src", "owned.ts")

        const result = await operations.addCheckpointFiles({
            git: harness.git,
            mode: "tracked",
            fileList: [nestedFile],
            taskId: "task-1",
        })

        expect(result).toEqual({
            success: true,
            stagedCount: 0,
            rejectedPaths: ["packages/nested/src/owned.ts"],
        })
        expect(harness.add).not.toHaveBeenCalled()
    })

    it("isolates a rejected pathspec so the remaining files still reach the index", async () => {
        const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "dline-checkpoint-isolation-"))
        const workspacePath = path.join(sandbox, "workspace")
        const goodFile = path.join(workspacePath, "src", "good.ts")
        const poisonedFile = path.join(workspacePath, "src", "poisoned.ts")
        await fs.mkdir(path.dirname(goodFile), { recursive: true })
        await fs.writeFile(goodFile, "good")
        await fs.writeFile(poisonedFile, "poisoned")
        try {
            const operations = new GitOperations(workspacePath)
            const add = vi.fn(async (args: string[]) => {
                if (args.includes(":(literal)src/poisoned.ts")) {
                    throw new Error("fatal: Pathspec 'src/poisoned.ts' is in submodule 'src'")
                }
                return undefined
            })
            const git = { add } as unknown as SimpleGit

            const result = await operations.addCheckpointFiles({
                git,
                mode: "tracked",
                fileList: [goodFile, poisonedFile],
                taskId: "task-isolation",
            })

            expect(result).toMatchObject({ success: true, stagedCount: 1 })
            expect(result.rejectedPaths).toEqual(["src/poisoned.ts"])
            expect(add).toHaveBeenCalledWith(["-A", "-f", "--", ":(literal)src/good.ts"])
        } finally {
            await fs.rm(sandbox, { recursive: true, force: true })
        }
    })

    it("rejects a worktree path whose parent symlink resolves outside the worktree", async () => {
        const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "dline-checkpoint-symlink-"))
        const workspacePath = path.join(sandbox, "workspace")
        const outsidePath = path.join(sandbox, "outside")
        const linkedPath = path.join(workspacePath, "linked-outside")
        await fs.mkdir(workspacePath, { recursive: true })
        await fs.mkdir(outsidePath, { recursive: true })
        await fs.writeFile(path.join(outsidePath, "owned.ts"), "outside")
        await fs.symlink(outsidePath, linkedPath, process.platform === "win32" ? "junction" : "dir")
        try {
            const operations = new GitOperations(workspacePath)
            const harness = createGitHarness()

            const result = await operations.addCheckpointFiles({
                git: harness.git,
                mode: "tracked",
                fileList: [path.join(linkedPath, "owned.ts")],
                taskId: "task-symlink",
            })

            expect(result).toEqual({ success: false, stagedCount: 0, rejectedPaths: [] })
            expect(harness.add).not.toHaveBeenCalled()
        } finally {
            await fs.rm(sandbox, { recursive: true, force: true })
        }
    })

    it("accepts a legal worktree child whose first segment starts with two dots", async () => {
        const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "dline-checkpoint-dot-segment-"))
        const workspacePath = path.join(sandbox, "workspace")
        const trackedFile = path.join(workspacePath, "..cache", "tracked.ts")
        await fs.mkdir(path.dirname(trackedFile), { recursive: true })
        await fs.writeFile(trackedFile, "tracked")
        try {
            const operations = new GitOperations(workspacePath)
            const harness = createGitHarness()

            const result = await operations.addCheckpointFiles({
                git: harness.git,
                mode: "tracked",
                fileList: [trackedFile],
                taskId: "task-dot-segment",
            })

            expect(result).toMatchObject({ success: true, stagedCount: 1, rejectedPaths: [] })
            expect(harness.add).toHaveBeenCalledOnce()
            expect(harness.add).toHaveBeenCalledWith(["-A", "-f", "--", ":(literal)..cache/tracked.ts"])
        } finally {
            await fs.rm(sandbox, { recursive: true, force: true })
        }
    })

    it.each(["EACCES", "ELOOP"])("fails closed when canonical path resolution returns %s", async (code) => {
        const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "dline-checkpoint-realpath-error-"))
        const workspacePath = path.join(sandbox, "workspace")
        const trackedFile = path.join(workspacePath, "tracked.ts")
        await fs.mkdir(workspacePath, { recursive: true })
        await fs.writeFile(trackedFile, "tracked")
        vi.spyOn(fs, "realpath").mockRejectedValue(Object.assign(new Error(code), { code }))
        try {
            const operations = new GitOperations(workspacePath)
            const harness = createGitHarness()

            const result = await operations.addCheckpointFiles({
                git: harness.git,
                mode: "tracked",
                fileList: [trackedFile],
                taskId: `task-realpath-${code.toLowerCase()}`,
            })

            expect(result).toEqual({ success: false, stagedCount: 0, rejectedPaths: [] })
            expect(harness.add).not.toHaveBeenCalled()
        } finally {
            await fs.rm(sandbox, { recursive: true, force: true })
        }
    })

    it("uses shadow exclude rules for workspace scans instead of per-boundary staging", async () => {
        const operations = new GitOperations(path.resolve("checkpoint-test-workspace"))
        const harness = createGitHarness()

        const result = await operations.addCheckpointFiles({
            git: harness.git,
            mode: "workspace-scan",
            taskId: "task-1",
        })

        expect(result).toEqual({ success: true, stagedCount: 0, rejectedPaths: [] })
        expect(harness.add).toHaveBeenCalledWith([".", "--ignore-errors"])
    })

    it("splits large tracked batches so one command cannot exceed the process limit", async () => {
        const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "dline-checkpoint-batching-"))
        const workspacePath = path.join(sandbox, "workspace")
        const sourceDir = path.join(workspacePath, "src")
        await fs.mkdir(sourceDir, { recursive: true })
        const files: string[] = []
        for (let index = 0; index < 250; index += 1) {
            const filePath = path.join(sourceDir, `file-${index}.ts`)
            await fs.writeFile(filePath, "content")
            files.push(filePath)
        }
        try {
            const operations = new GitOperations(workspacePath)
            const harness = createGitHarness()

            const result = await operations.addCheckpointFiles({
                git: harness.git,
                mode: "tracked",
                fileList: files,
                taskId: "task-batching",
            })

            expect(result).toMatchObject({ success: true, stagedCount: 250, rejectedPaths: [] })
            expect(harness.add).toHaveBeenCalledTimes(3)
            for (const call of harness.add.mock.calls) {
                expect((call[0] as string[]).length - 3).toBeLessThanOrEqual(100)
            }
        } finally {
            await fs.rm(sandbox, { recursive: true, force: true })
        }
    })
})

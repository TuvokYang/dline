import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import simpleGit from "simple-git"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Logger } from "@/shared/services/Logger"
import { getLatestGitCommitHash } from "../git"

const execFileAsync = promisify(execFile)

describe("getLatestGitCommitHash", () => {
    let sandbox: string
    let workspace: string

    beforeEach(async () => {
        for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) {
            vi.stubEnv(key, undefined)
        }
        sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "dline-git-head-"))
        workspace = path.join(sandbox, "workspace")
        await fs.mkdir(workspace)
        await simpleGit(workspace).init()
        vi.spyOn(Logger, "error").mockImplementation(() => {})
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        vi.unstubAllEnvs()
        await fs.rm(sandbox, { recursive: true, force: true })
    })

    async function createCommit(): Promise<string> {
        const git = simpleGit(workspace)
        await fs.writeFile(path.join(workspace, "file.txt"), "committed content")
        await git.add("file.txt")
        await execFileAsync(
            "git",
            [
                "-c",
                "user.name=Dline Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgSign=false",
                "-c",
                `core.hooksPath=${path.join(sandbox, "no-hooks")}`,
                "commit",
                "-m",
                "initial",
            ],
            { cwd: workspace },
        )
        return (await git.raw(["log", "-1", "--format=%H"])).trim()
    }

    it("returns no hash without reporting an error for a repository with no commits", async () => {
        const git = simpleGit(workspace)
        await fs.writeFile(path.join(workspace, "staged.txt"), "user staged content")
        await git.add("staged.txt")
        const headBefore = await fs.readFile(path.join(workspace, ".git", "HEAD"))
        const indexBefore = await fs.readFile(path.join(workspace, ".git", "index"))

        expect(await getLatestGitCommitHash(workspace)).toBeNull()
        expect(await getLatestGitCommitHash(workspace)).toBeNull()

        expect(Logger.error).not.toHaveBeenCalled()
        expect(await fs.readFile(path.join(workspace, ".git", "HEAD"))).toEqual(headBefore)
        expect(await fs.readFile(path.join(workspace, ".git", "index"))).toEqual(indexBefore)
        expect(await fs.readdir(path.join(workspace, ".git", "refs", "heads"))).toEqual([])
    })

    it("returns no hash for a directory outside a repository", async () => {
        const plainDirectory = path.join(sandbox, "plain")
        await fs.mkdir(plainDirectory)

        expect(await getLatestGitCommitHash(plainDirectory)).toBeNull()
        expect(Logger.error).not.toHaveBeenCalled()
    })

    it("returns the current commit for a branch", async () => {
        const commit = await createCommit()

        expect(await getLatestGitCommitHash(workspace)).toBe(commit)
        expect(Logger.error).not.toHaveBeenCalled()
    })

    it("returns the current commit for a detached HEAD", async () => {
        const commit = await createCommit()
        await simpleGit(workspace).raw(["checkout", "--detach", commit])

        expect(await getLatestGitCommitHash(workspace)).toBe(commit)
        expect(Logger.error).not.toHaveBeenCalled()
    })

    it("returns the commit from a linked worktree whose git metadata is a file", async () => {
        const commit = await createCommit()
        const worktree = path.join(sandbox, "linked-worktree")
        await simpleGit(workspace).raw(["worktree", "add", "--detach", worktree, commit])

        expect((await fs.stat(path.join(worktree, ".git"))).isFile()).toBe(true)
        expect(await getLatestGitCommitHash(worktree)).toBe(commit)
        expect(Logger.error).not.toHaveBeenCalled()
    })

    it("does not report an unborn orphan branch in a repository that already has history", async () => {
        await createCommit()
        await simpleGit(workspace).raw(["checkout", "--orphan", "new-history"])

        expect(await getLatestGitCommitHash(workspace)).toBeNull()
        expect(Logger.error).not.toHaveBeenCalled()
    })

    it("does not treat a branch pointing at a missing object as an unborn HEAD", async () => {
        await createCommit()
        const ref = (await simpleGit(workspace).raw(["symbolic-ref", "HEAD"])).trim()
        await fs.writeFile(path.join(workspace, ".git", ref), `${"1".repeat(40)}\n`)

        expect(await getLatestGitCommitHash(workspace)).toBeNull()
        expect(Logger.error).toHaveBeenCalledOnce()
        expect(vi.mocked(Logger.error).mock.calls[0]?.[1]).toBeInstanceOf(Error)
    })

    it("keeps diagnostics for a malformed branch reference", async () => {
        const ref = (await simpleGit(workspace).raw(["symbolic-ref", "HEAD"])).trim()
        await fs.writeFile(path.join(workspace, ".git", ref), "not-an-object-id\n")

        expect(await getLatestGitCommitHash(workspace)).toBeNull()
        expect(Logger.error).toHaveBeenCalledOnce()
        expect(vi.mocked(Logger.error).mock.calls[0]?.[1]).toBeInstanceOf(Error)
    })
})

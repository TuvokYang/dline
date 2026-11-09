import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import { afterEach, describe, it } from "vitest"
import { resolveCommandTarget, resolveCommandWorkdirectory } from "../command-workdirectory"

const cleanupPaths: string[] = []

afterEach(async () => {
    await Promise.all(cleanupPaths.splice(0).map((cleanupPath) => fs.rm(cleanupPath, { recursive: true, force: true })))
})

async function createTempDirectory(stem: string): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), stem))
    cleanupPaths.push(directory)
    return directory
}

describe("resolveCommandWorkdirectory", () => {
    it("resolves relative directories from the task cwd and recognizes project scope", async () => {
        const workspace = await createTempDirectory("dline-command-workspace-")
        const nested = path.join(workspace, "packages", "app")
        await fs.mkdir(nested, { recursive: true })

        const result = await resolveCommandWorkdirectory({
            cwd: workspace,
            requestedPath: path.join("packages", "app"),
            workspaceRoots: [workspace],
        })

        assert.equal(result.path, await fs.realpath(nested))
        assert.equal(result.isWithinWorkspace, true)
    })

    it("classifies a real directory outside every workspace root as external", async () => {
        const workspace = await createTempDirectory("dline-command-workspace-")
        const external = await createTempDirectory("dline-command-external-")

        const result = await resolveCommandWorkdirectory({
            cwd: workspace,
            requestedPath: external,
            workspaceRoots: [workspace],
        })

        assert.equal(result.path, await fs.realpath(external))
        assert.equal(result.isWithinWorkspace, false)
    })

    it("resolves workspace hints and classifies a junction by its real target", async () => {
        const workspace = await createTempDirectory("dline-command-workspace-")
        const second = await createTempDirectory("dline-command-second-")
        const external = await createTempDirectory("dline-command-external-")
        const junction = path.join(workspace, "outside")
        await fs.symlink(external, junction, process.platform === "win32" ? "junction" : "dir")
        const roots = [
            { name: "first", path: workspace },
            { name: "second", path: second },
        ]
        const workspaceManager = {
            getRoots: () => roots,
            getPrimaryRoot: () => roots[0],
            resolvePathToRoot: (candidate: string) => roots.find((root) => candidate === root.path),
            getRootByName: (name: string) => roots.find((root) => root.name === name),
        } as unknown as WorkspaceRootManager
        const hinted = await resolveCommandTarget({
            cwd: workspace,
            command: "@second:echo hello",
            isMultiRootEnabled: true,
            workspaceManager,
        })
        assert.equal(hinted.actualCommand, "echo hello")
        assert.equal(hinted.path, await fs.realpath(second))
        assert.equal(hinted.isWithinWorkspace, true)
        const escaped = await resolveCommandTarget({ cwd: workspace, command: "echo hello", workdirectory: "outside" })
        assert.equal(escaped.path, await fs.realpath(external))
        assert.equal(escaped.isWithinWorkspace, false)
    })

    it("rejects missing paths and regular files before execution", async () => {
        const workspace = await createTempDirectory("dline-command-workspace-")
        const filePath = path.join(workspace, "file.txt")
        await fs.writeFile(filePath, "content", "utf8")

        await assert.rejects(
            resolveCommandWorkdirectory({ cwd: workspace, requestedPath: "missing" }),
            /workdirectory does not exist/,
        )
        await assert.rejects(
            resolveCommandWorkdirectory({ cwd: workspace, requestedPath: filePath }),
            /workdirectory is not a directory/,
        )
    })
})

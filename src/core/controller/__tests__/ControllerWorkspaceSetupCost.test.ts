import { readFile } from "fs/promises"
import path from "path"
import { describe, expect, it } from "vitest"

/**
 * Workspace root detection spawns `git` child processes for every workspace
 * folder (`detectVcs` + `getLatestGitCommitHash`). It used to run twice on the
 * critical path of every task start: once from `ensureWorkspaceManager` and
 * again unconditionally inside `initTask`, with no in-flight de-duplication.
 * Concurrent callers therefore each started their own sweep, adding seconds
 * between task creation and the first provider request.
 *
 * These are structural assertions because constructing a real Controller pulls
 * in the whole extension host. The repository already uses this pattern for
 * other ordering guarantees (see TaskRequestApiBoundary.test.ts).
 */
describe("Controller workspace setup cost", () => {
    const controllerSourcePath = path.resolve(__dirname, "../index.ts")

    async function readControllerSource(): Promise<string> {
        return await readFile(controllerSourcePath, "utf8")
    }

    it("resolves the workspace manager through a single shared in-flight setup", async () => {
        const source = await readControllerSource()

        expect(source).toContain("private workspaceManagerSetup?: Promise<WorkspaceRootManager | undefined>")
        expect(source).toContain("this.workspaceManagerSetup ??= setupWorkspaceManager({")
    })

    it("clears the in-flight setup once detection settles so later failures can retry", async () => {
        const source = await readControllerSource()

        const assignmentIndex = source.indexOf("this.workspaceManagerSetup ??= setupWorkspaceManager({")
        const clearIndex = source.indexOf("this.workspaceManagerSetup = undefined", assignmentIndex)

        expect(assignmentIndex).toBeGreaterThan(-1)
        expect(clearIndex).toBeGreaterThan(assignmentIndex)
    })

    it("does not re-detect workspace roots on the task start path", async () => {
        const source = await readControllerSource()

        // `setupWorkspaceManager` must be reached only through the shared helper.
        const directCalls = source.match(/setupWorkspaceManager\(\{/g) ?? []
        expect(directCalls).toHaveLength(1)

        const initTaskIndex = source.indexOf("const cwd = this.workspaceManager?.getPrimaryRoot()?.path")
        expect(initTaskIndex).toBeGreaterThan(-1)

        const ensureIndex = source.lastIndexOf("await this.ensureWorkspaceManager()", initTaskIndex)
        expect(ensureIndex).toBeGreaterThan(-1)
        expect(ensureIndex).toBeLessThan(initTaskIndex)
    })
})

import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, describe, expect, it } from "vitest"
import { IgnoreController } from "./IgnoreController"

const controllers: IgnoreController[] = []
const workspaces: string[] = []

async function createWorkspace(files: Record<string, string>): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ignore-controller-"))
    workspaces.push(root)
    for (const [relativePath, content] of Object.entries(files)) {
        const target = path.join(root, relativePath)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, content, "utf8")
    }
    return root
}

async function loadRules(files: Record<string, string>): Promise<{ cwd: string; rules: IgnoreController }> {
    const cwd = await createWorkspace(files)
    const rules = await IgnoreController.loadSnapshot(cwd)
    controllers.push(rules)
    return { cwd, rules }
}

afterEach(async () => {
    await Promise.all(controllers.splice(0).map((controller) => controller.dispose()))
    await Promise.all(workspaces.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("IgnoreController", () => {
    describe("permissions", () => {
        it("removes every permission for a rule without attributes", async () => {
            const { cwd, rules } = await loadRules({ ".agentignore": "secrets/\n" })
            const target = path.join(cwd, "secrets/key.txt")

            expect(rules.validateAccess(target, "read")).toBe(false)
            expect(rules.validateAccess(target, "write")).toBe(false)
            expect(rules.validateAccess(target, "execute")).toBe(false)
            expect(rules.validateAccess(target, "scan")).toBe(false)
        })

        it("hides a directory from listings while keeping its files usable", async () => {
            const { cwd, rules } = await loadRules({ ".agentignore": "generated/ -s\n" })
            const target = path.join(cwd, "generated/schema.ts")

            expect(rules.validateAccess(target, "scan")).toBe(false)
            expect(rules.validateAccess(target, "read")).toBe(true)
            expect(rules.validateAccess(target, "write")).toBe(true)
        })

        it("makes a directory read-only", async () => {
            const { cwd, rules } = await loadRules({ ".agentignore": "vendor/ -w\n" })
            const target = path.join(cwd, "vendor/lib.js")

            expect(rules.validateAccess(target, "read")).toBe(true)
            expect(rules.validateAccess(target, "scan")).toBe(true)
            expect(rules.validateAccess(target, "write")).toBe(false)
        })

        it("refuses a directory as a command working directory", async () => {
            const { cwd, rules } = await loadRules({ ".agentignore": "scripts/untrusted/ -x\n" })
            const target = path.join(cwd, "scripts/untrusted")

            expect(rules.validateDirectoryAccess(target, "execute")).toBe(false)
            expect(rules.validateDirectoryAccess(target, "read")).toBe(true)
        })

        it("allows every operation when the workspace has no rule files", async () => {
            const { cwd, rules } = await loadRules({ "src/app.ts": "" })

            expect(rules.validateAccess(path.join(cwd, "src/app.ts"), "read")).toBe(true)
            expect(rules.getIgnoreContent("read")).toBeUndefined()
        })
    })

    describe("repository rules", () => {
        it("keeps an untracked path readable while hiding it from listings", async () => {
            const { cwd, rules } = await loadRules({ ".gitignore": ".memory-bank/\n" })
            const target = path.join(cwd, ".memory-bank/notes.md")

            // Not tracking a path says nothing about whether opening it is allowed.
            expect(rules.validateAccess(target, "scan")).toBe(false)
            expect(rules.validateAccess(target, "read")).toBe(true)
            expect(rules.validateAccess(target, "write")).toBe(true)
        })

        it("keeps agent rules out of the repository view", async () => {
            const { cwd, rules } = await loadRules({
                ".gitignore": "build/\n",
                ".agentignore": "secrets/\n",
            })

            expect(rules.validateRepositoryAccess(path.join(cwd, "build/app.js"))).toBe(false)
            expect(rules.validateRepositoryAccess(path.join(cwd, "secrets/key.txt"))).toBe(true)
        })

        it("lets an agent negation re-admit a repository-ignored file", async () => {
            // gitignore semantics: a file inside an excluded directory cannot be
            // re-included, so the repository rule must target the file itself.
            const { cwd, rules } = await loadRules({
                ".gitignore": "*.log\n",
                ".agentignore": "!audit.log -s\n",
            })

            expect(rules.validateAccess(path.join(cwd, "audit.log"), "scan")).toBe(true)
            expect(rules.validateRepositoryAccess(path.join(cwd, "audit.log"))).toBe(false)
        })
    })

    describe("built-in floor", () => {
        it("hides generated directories from listings without any rule file", async () => {
            const { cwd, rules } = await loadRules({ "src/app.ts": "" })

            for (const artifact of ["node_modules/pkg/index.js", "dist/extension.js", "tmp/report.png"]) {
                expect(rules.validateAccess(path.join(cwd, artifact), "scan")).toBe(false)
            }
        })

        it("keeps generated directories readable and writable", async () => {
            const { cwd, rules } = await loadRules({ "src/app.ts": "" })

            // Opening a named artifact costs no traversal, so test output, build
            // results and packaged bundles must stay reachable.
            for (const artifact of ["tmp/test-result/run/report.png", "dist/extension.js", "out/build.log"]) {
                expect(rules.validateAccess(path.join(cwd, artifact), "read")).toBe(true)
                expect(rules.validateAccess(path.join(cwd, artifact), "write")).toBe(true)
            }
        })

        it("keeps the repository directory readable but never writable", async () => {
            const { cwd, rules } = await loadRules({ "src/app.ts": "" })
            const target = path.join(cwd, ".git/HEAD")

            expect(rules.validateAccess(target, "read")).toBe(true)
            expect(rules.validateAccess(target, "write")).toBe(false)
        })

        it("still refuses a floor directory that an agent rule excludes", async () => {
            const { cwd, rules } = await loadRules({ ".agentignore": "tmp/secrets/\n" })

            expect(rules.validateAccess(path.join(cwd, "tmp/secrets/token.txt"), "read")).toBe(false)
            expect(rules.validateAccess(path.join(cwd, "tmp/report.png"), "read")).toBe(true)
        })
    })

    describe("accepted filenames", () => {
        it("reads .dlineignore when .agentignore is absent", async () => {
            const { cwd, rules } = await loadRules({ ".dlineignore": "secrets/\n" })

            expect(rules.validateAccess(path.join(cwd, "secrets/key.txt"), "read")).toBe(false)
        })

        it("reads .clineignore when the preferred names are absent", async () => {
            const { cwd, rules } = await loadRules({ ".clineignore": "secrets/\n" })

            expect(rules.validateAccess(path.join(cwd, "secrets/key.txt"), "read")).toBe(false)
        })

        it("uses only the highest-precedence file", async () => {
            const { cwd, rules } = await loadRules({
                ".agentignore": "current/\n",
                ".clineignore": "superseded/\n",
            })

            expect(rules.validateAccess(path.join(cwd, "current/a.txt"), "read")).toBe(false)
            expect(rules.validateAccess(path.join(cwd, "superseded/a.txt"), "read")).toBe(true)
        })
    })

    describe("shouldIgnoreDirectory", () => {
        it("prunes the built-in directories without any rule file", async () => {
            const { cwd, rules } = await loadRules({ "src/app.ts": "" })

            expect(rules.shouldIgnoreDirectory(path.join(cwd, "node_modules"))).toBe(true)
            expect(rules.shouldIgnoreDirectory(path.join(cwd, "src"))).toBe(false)
        })

        it("prunes a directory named by the workspace rules", async () => {
            const { cwd, rules } = await loadRules({ ".agentignore": "coverage/\n" })

            expect(rules.shouldIgnoreDirectory(path.join(cwd, "coverage"))).toBe(true)
        })

        it("never prunes the workspace root", async () => {
            const { cwd, rules } = await loadRules({ ".agentignore": "*\n" })

            expect(rules.shouldIgnoreDirectory(cwd)).toBe(false)
        })

        it("does not prune a directory that is only read-only", async () => {
            const { cwd, rules } = await loadRules({ ".agentignore": "vendor/ -w\n" })

            expect(rules.shouldIgnoreDirectory(path.join(cwd, "vendor"))).toBe(false)
        })
    })

    describe("exports", () => {
        it("includes the built-in floor in the glob patterns", async () => {
            const { rules } = await loadRules({ "src/app.ts": "" })

            expect(rules.toGlobPatterns()).toContain("**/node_modules")
        })

        it("translates directory and anchored rules into globs", async () => {
            const { rules } = await loadRules({ ".agentignore": "coverage/\n/generated\n" })

            expect(rules.toGlobPatterns()).toEqual(expect.arrayContaining(["**/coverage", "generated", "generated/**"]))
        })

        it("omits a read-only rule from the scan globs", async () => {
            const { rules } = await loadRules({ ".agentignore": "vendor/ -w\n" })

            expect(rules.toGlobPatterns()).not.toContain("**/vendor")
        })

        it("emits repository rules and the floor in gitignore syntax", async () => {
            const { rules } = await loadRules({
                ".gitignore": "build/\n",
                ".agentignore": "secrets/\n",
            })
            const content = rules.toRepositoryGitignoreContent()

            expect(content).toContain("node_modules/")
            expect(content).toContain("build/")
            // Checkpoints mirror the repository, so agent rules must not leak in.
            expect(content).not.toContain("secrets/")
        })
    })

    describe("filterPaths", () => {
        it("drops the paths excluded by the requested permission", async () => {
            const { rules } = await loadRules({ ".agentignore": "secrets/\n" })

            expect(rules.filterPaths(["src/app.ts", "secrets/key.txt"], "read")).toEqual(["src/app.ts"])
        })
    })
})

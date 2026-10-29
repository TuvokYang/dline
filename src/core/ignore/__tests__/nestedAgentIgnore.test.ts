import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { readDirectoryAgentGlobPatterns } from "../IgnoreController"

/**
 * A nested `.agentignore` is the only place a subtree can state what the agent
 * must not traverse, and the workspace root loader never reads it. These cases
 * pin the recursive reader that a tree walk depends on.
 */
const roots: string[] = []

function tempRoot(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "dline-nested-agentignore-"))
    roots.push(root)
    return root
}

afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe("readDirectoryAgentGlobPatterns", () => {
    it("returns nothing for a directory without an agent rule file", async () => {
        const root = tempRoot()
        expect(await readDirectoryAgentGlobPatterns(root)).toEqual([])
    })

    it("translates a nested rule into patterns that prune the subtree", async () => {
        const root = tempRoot()
        writeFileSync(path.join(root, ".agentignore"), "secrets/\n*.pem\n")

        const patterns = await readDirectoryAgentGlobPatterns(root)

        // Both the bare name and everything below it must match, or a walk
        // reaches the directory's children before the rule can exclude them.
        expect(patterns).toContain("**/secrets")
        expect(patterns).toContain("**/secrets/**")
        expect(patterns).toContain("**/*.pem")
    })

    it("honours the same filename precedence as the workspace root", async () => {
        const root = tempRoot()
        writeFileSync(path.join(root, ".agentignore"), "keep-out/\n")
        writeFileSync(path.join(root, ".clineignore"), "legacy-name/\n")

        const patterns = await readDirectoryAgentGlobPatterns(root)

        // Only the highest-precedence file contributes, so a directory that
        // migrated its file does not have the replaced rules re-applied.
        expect(patterns).toContain("**/keep-out")
        expect(patterns).not.toContain("**/legacy-name")
    })

    it("falls back to a legacy filename when the preferred one is absent", async () => {
        const root = tempRoot()
        writeFileSync(path.join(root, ".clineignore"), "legacy-name/\n")

        expect(await readDirectoryAgentGlobPatterns(root)).toContain("**/legacy-name")
    })

    it("keeps a read-only rule traversable because it only removed write", async () => {
        const root = tempRoot()
        writeFileSync(path.join(root, ".agentignore"), "vendor/   -w\n")

        const patterns = await readDirectoryAgentGlobPatterns(root)

        // `-w` removes write and leaves scanning allowed, so a walk must still
        // enter the directory. Pruning it here would make the rule stricter
        // than the file says, and the attribute must never reach the glob.
        expect(patterns).not.toContain("**/vendor")
        expect(patterns.some((pattern) => pattern.includes("-w"))).toBe(false)
    })

    it("prunes a subtree when the rule removes scanning", async () => {
        const root = tempRoot()
        writeFileSync(path.join(root, ".agentignore"), "generated/   -s\n")

        // `-s` is the opposite case: the directory is hidden from listings, so
        // the walk must never descend into it.
        expect(await readDirectoryAgentGlobPatterns(root)).toContain("**/generated")
    })

    it("reads a rule file in a subdirectory of the traversal root", async () => {
        const root = tempRoot()
        const nested = path.join(root, "packages", "service")
        mkdirSync(nested, { recursive: true })
        writeFileSync(path.join(nested, ".agentignore"), "generated/\n")

        // The walk calls this once per entered directory, so the parent having
        // no file must not stop the child's rules from being read.
        expect(await readDirectoryAgentGlobPatterns(root)).toEqual([])
        expect(await readDirectoryAgentGlobPatterns(nested)).toContain("**/generated")
    })
})

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CanonicalPathBoundary } from "../CanonicalPathBoundary"

const cleanupRoots: string[] = []

async function temporaryRoot(name: string): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), name))
    cleanupRoots.push(root)
    return root
}

afterEach(async () => {
    await Promise.all(cleanupRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("CanonicalPathBoundary", () => {
    it("canonicalizes a missing leaf through its nearest existing ancestor", async () => {
        const root = await temporaryRoot("dline-canonical-missing-")
        const workspace = path.join(root, "workspace")
        await fs.mkdir(workspace)

        const result = await new CanonicalPathBoundary().review({
            targets: [path.join(workspace, "missing", "file.txt")],
            roots: [workspace],
        })

        expect(result).toMatchObject({ outcome: "confirmed", isExternal: false })
        if (result.outcome !== "confirmed") throw new Error("expected confirmed boundary")
        expect(result.canonicalTargets).toEqual([path.join(await fs.realpath(workspace), "missing", "file.txt")])
    })

    it("detects a workspace junction whose canonical target is external", async () => {
        const root = await temporaryRoot("dline-canonical-junction-")
        const workspace = path.join(root, "workspace")
        const external = path.join(root, "external")
        const junction = path.join(workspace, "linked-outside")
        await fs.mkdir(workspace)
        await fs.mkdir(external)
        await fs.symlink(external, junction, process.platform === "win32" ? "junction" : "dir")

        const result = await new CanonicalPathBoundary().review({
            targets: [path.join(junction, "proof.txt")],
            roots: [workspace],
        })

        expect(result).toMatchObject({ outcome: "confirmed", isExternal: true })
        if (result.outcome !== "confirmed") throw new Error("expected confirmed boundary")
        expect(result.canonicalTargets).toEqual([path.join(await fs.realpath(external), "proof.txt")])
    })

    it("treats a target set as external when any canonical target is outside every root", async () => {
        const root = await temporaryRoot("dline-canonical-multiple-")
        const workspace = path.join(root, "workspace")
        const external = path.join(root, "external")
        await fs.mkdir(workspace)
        await fs.mkdir(external)

        const result = await new CanonicalPathBoundary().review({
            targets: [path.join(workspace, "inside.txt"), path.join(external, "outside.txt")],
            roots: [workspace],
        })

        expect(result).toMatchObject({ outcome: "confirmed", isExternal: true })
    })

    it("fails closed when canonicalization cannot establish the boundary", async () => {
        const realpath = vi.fn(async () => {
            const error = new Error("denied") as NodeJS.ErrnoException
            error.code = "EACCES"
            throw error
        })
        const result = await new CanonicalPathBoundary({ realpath }).review({
            targets: [path.resolve("workspace", "target.txt")],
            roots: [path.resolve("workspace")],
        })

        expect(result).toEqual({ outcome: "failed", reason: "canonicalization_failed" })
        expect(realpath).toHaveBeenCalled()
    })
})

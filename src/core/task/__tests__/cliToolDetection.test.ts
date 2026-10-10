import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const childProcessMocks = vi.hoisted(() => ({
    execSync: vi.fn(),
}))

vi.mock("child_process", () => ({
    execSync: childProcessMocks.execSync,
}))

import { detectAvailableCliTools } from "../cli-tool-detector"

describe("detectAvailableCliTools", () => {
    let originalPath: string | undefined
    let originalPathExt: string | undefined
    let tempRoot: string | undefined

    beforeEach(() => {
        originalPath = process.env.PATH
        originalPathExt = process.env.PATHEXT
        childProcessMocks.execSync.mockReset()
    })

    afterEach(async () => {
        if (originalPath === undefined) delete process.env.PATH
        else process.env.PATH = originalPath
        if (originalPathExt === undefined) delete process.env.PATHEXT
        else process.env.PATHEXT = originalPathExt
        if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
        tempRoot = undefined
    })

    it("discovers PATH tools without spawning synchronous lookup processes", async () => {
        tempRoot = await mkdtemp(path.join(os.tmpdir(), "dline-cli-tools-"))
        const firstDir = path.join(tempRoot, "first")
        const secondDir = path.join(tempRoot, "second")
        await Promise.all([mkdir(firstDir), mkdir(secondDir)])

        const executableNames =
            process.platform === "win32"
                ? [
                      [path.join(firstDir, "GIT.CMD"), ""],
                      [path.join(secondDir, "npm.BAT"), ""],
                      [path.join(secondDir, "node.EXE"), ""],
                  ]
                : [
                      [path.join(firstDir, "git"), "#!/bin/sh\n"],
                      [path.join(secondDir, "npm"), "#!/bin/sh\n"],
                      [path.join(secondDir, "node"), "#!/bin/sh\n"],
                  ]

        for (const [filePath, content] of executableNames) {
            await writeFile(filePath, content, "utf8")
            if (process.platform !== "win32") await chmod(filePath, 0o755)
        }

        process.env.PATH = [firstDir, secondDir].join(path.delimiter)
        process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD"
        childProcessMocks.execSync.mockImplementation(() => {
            throw new Error("Synchronous command lookup must not run")
        })

        await expect(detectAvailableCliTools()).resolves.toEqual(["git", "npm", "node"])
        expect(childProcessMocks.execSync).not.toHaveBeenCalled()
    })
})

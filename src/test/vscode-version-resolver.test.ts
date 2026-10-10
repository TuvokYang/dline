import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { resolveVSCodeDownloadVersion } from "./e2e/utils/vscode-version-resolver"

const temporaryDirectories: string[] = []

function createCacheDirectory(): string {
    const directory = mkdtempSync(path.join(os.tmpdir(), "dline-vscode-cache-resolver-"))
    temporaryDirectories.push(directory)
    return directory
}

function createCachedVersion(cachePath: string, platform: string, version: string, complete: boolean): void {
    const directory = path.join(cachePath, `vscode-${platform}-${version}`)
    mkdirSync(directory, { recursive: true })
    if (complete) writeFileSync(path.join(directory, "is-complete"), "", "utf8")
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true })
    }
})

describe("VS Code E2E version resolver", () => {
    it("selects the newest complete stable cache for the requested platform", () => {
        const cachePath = createCacheDirectory()
        createCachedVersion(cachePath, "win32-x64-archive", "1.9.9", true)
        createCachedVersion(cachePath, "win32-x64-archive", "1.10.0", true)
        createCachedVersion(cachePath, "win32-x64-archive", "1.132.1", true)
        createCachedVersion(cachePath, "win32-x64-archive", "1.133.0", false)
        createCachedVersion(cachePath, "linux-x64", "1.200.0", true)

        expect(resolveVSCodeDownloadVersion("stable", cachePath, "win32-x64-archive")).toBe("1.132.1")
    })

    it("keeps stable resolution when no complete local cache exists", () => {
        const cachePath = createCacheDirectory()
        createCachedVersion(cachePath, "win32-x64-archive", "1.132.1", false)

        expect(resolveVSCodeDownloadVersion("stable", cachePath, "win32-x64-archive")).toBe("stable")
    })

    it("does not substitute a stable cache for the insiders channel", () => {
        const cachePath = createCacheDirectory()
        createCachedVersion(cachePath, "win32-x64-archive", "1.132.1", true)

        expect(resolveVSCodeDownloadVersion("insiders", cachePath, "win32-x64-archive")).toBe("insiders")
    })
})

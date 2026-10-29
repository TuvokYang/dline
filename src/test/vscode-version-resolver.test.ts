import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { E2E_VSCODE_STABLE_VERSION, resolveVSCodeDownloadVersion } from "./e2e/utils/vscode-version-resolver"

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
    it("pins stable to a concrete repository-configured build", () => {
        expect(E2E_VSCODE_STABLE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    })

    // Following whatever the cache held made runs on different machines test different VS Code builds.
    it("pins stable regardless of newer or older complete caches", () => {
        const cachePath = createCacheDirectory()
        createCachedVersion(cachePath, "win32-x64-archive", "1.9.9", true)
        createCachedVersion(cachePath, "win32-x64-archive", "1.999.0", true)
        createCachedVersion(cachePath, "win32-x64-archive", "1.1000.0", false)

        expect(resolveVSCodeDownloadVersion("stable", cachePath, "win32-x64-archive")).toBe(E2E_VSCODE_STABLE_VERSION)
    })

    it("pins stable rather than following the mutable channel when no complete cache exists", () => {
        const cachePath = createCacheDirectory()
        createCachedVersion(cachePath, "win32-x64-archive", "1.132.1", false)

        expect(resolveVSCodeDownloadVersion("stable", cachePath, "win32-x64-archive")).toBe(E2E_VSCODE_STABLE_VERSION)
    })

    it("does not substitute a stable cache for the insiders channel", () => {
        const cachePath = createCacheDirectory()
        createCachedVersion(cachePath, "win32-x64-archive", "1.132.1", true)

        expect(resolveVSCodeDownloadVersion("insiders", cachePath, "win32-x64-archive")).toBe("insiders")
    })
})

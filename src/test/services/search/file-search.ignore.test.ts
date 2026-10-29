import * as fileSearch from "@services/search/file-search"
import * as childProcess from "child_process"
import * as fs from "fs"
import { EventEmitter, Readable } from "stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HostProvider } from "@/hosts/host-provider"
import type { RipgrepScanRules } from "@/services/ripgrep/ignore-file"
import { resetWorkspaceWatchersForTesting, setWatchFactoryForTesting } from "@/services/search/workspace-enumeration-invalidator"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock("child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("child_process")>()
    return {
        ...actual,
        spawn: spawnMock,
    }
})

function stubRipgrepProcess(files: readonly string[]): childProcess.ChildProcess {
    const stdout = new Readable({ read() {} })
    const stderr = new Readable({ read() {} })
    const proc = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        kill: vi.fn(),
    }) as unknown as childProcess.ChildProcess

    setImmediate(() => {
        for (const file of files) {
            stdout.push(`${file}\n`)
        }
        stdout.push(null)
        stderr.push(null)
        proc.emit("exit", 0)
    })

    return proc
}

/** The arguments handed to ripgrep by the most recent spawn. */
function lastSpawnArgs(): string[] {
    const call = spawnMock.mock.calls.at(-1)
    if (!call) throw new Error("ripgrep was never spawned")
    return call[1] as string[]
}

/**
 * A stand-in for IgnoreController exposing only what the walk consumes.
 *
 * Structural typing is the point: the production instance satisfies
 * `RipgrepScanRules` without the service importing the concrete class.
 */
function stubScanRules(content: string | undefined): RipgrepScanRules {
    return { getIgnoreContent: () => content }
}

describe("file-search ignore rules", () => {
    beforeEach(() => {
        spawnMock.mockReset()
        const spawnWrapper: typeof childProcess.spawn = (command, options) => spawnMock(command, options)
        vi.spyOn(fileSearch, "getSpawnFunction").mockReturnValue(spawnWrapper)
        vi.spyOn(fs.promises, "access").mockResolvedValue(undefined as never)
        vi.spyOn(fs.promises, "lstat").mockResolvedValue({ isDirectory: () => false } as fs.Stats)

        setVscodeHostProviderMock()
        vi.spyOn(HostProvider.window, "getOpenTabs").mockResolvedValue({ paths: [] } as never)
        vi.spyOn(HostProvider.workspace, "searchWorkspaceItems").mockRejectedValue(
            new Error("searchWorkspaceItems is not implemented on the VS Code host"),
        )

        // Watching is irrelevant here and would otherwise touch the real filesystem.
        // `on` must return the watcher so ensureWorkspaceWatched can chain.
        const watcher: Record<string, unknown> = { close: async () => {} }
        watcher.on = () => watcher
        setWatchFactoryForTesting(() => watcher as never)
        fileSearch.clearWorkspaceEnumerationCache()
        spawnMock.mockImplementation(() => stubRipgrepProcess(["src/alpha.ts"]))
    })

    afterEach(() => {
        fileSearch.clearWorkspaceEnumerationCache()
        resetWorkspaceWatchersForTesting()
        setWatchFactoryForTesting(undefined)
        vi.restoreAllMocks()
    })

    it("hands the workspace scan rules to ripgrep as an ignore file", async () => {
        await fileSearch.executeRipgrepForFiles("/workspace", 5000, stubScanRules("secrets/\n"))

        const args = lastSpawnArgs()
        expect(args).toContain("--ignore-file")
        // The rules replace the built-in glob floor rather than stacking on it.
        expect(args).not.toContain("-g")
    })

    it("falls back to the built-in floor when no rules are available", async () => {
        await fileSearch.executeRipgrepForFiles("/workspace", 5000, undefined)

        const args = lastSpawnArgs()
        expect(args).not.toContain("--ignore-file")
        expect(args).toContain("-g")
    })

    it("treats empty rules as no rules", async () => {
        await fileSearch.executeRipgrepForFiles("/workspace", 5000, stubScanRules(undefined))

        expect(lastSpawnArgs()).not.toContain("--ignore-file")
    })

    it("asks the walk for the scan permission, not read", async () => {
        const getIgnoreContent = vi.fn().mockReturnValue("secrets/\n")

        await fileSearch.executeRipgrepForFiles("/workspace", 5000, { getIgnoreContent })

        expect(getIgnoreContent).toHaveBeenCalledWith("scan")
    })

    it("resolves the rules per root through the injected provider", async () => {
        const provider = vi.fn().mockResolvedValue(stubScanRules("secrets/\n"))

        await fileSearch.searchWorkspaceFiles("a", "/workspace", 20, undefined, undefined, provider)

        expect(provider).toHaveBeenCalledWith("/workspace")
        expect(lastSpawnArgs()).toContain("--ignore-file")
    })

    it("keeps enumerating when the provider fails", async () => {
        const provider = vi.fn().mockRejectedValue(new Error("rules unavailable"))

        const result = await fileSearch.searchWorkspaceFiles("a", "/workspace", 20, undefined, undefined, provider)

        expect(result.items.length).toBeGreaterThan(0)
        expect(lastSpawnArgs()).not.toContain("--ignore-file")
    })
})

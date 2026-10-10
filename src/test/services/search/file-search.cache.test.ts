import * as fileSearch from "@services/search/file-search"
import * as childProcess from "child_process"
import type { FSWatcher } from "chokidar"
import * as fs from "fs"
import * as path from "path"
import { EventEmitter, Readable } from "stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HostProvider } from "@/hosts/host-provider"
import {
    resetWorkspaceWatchersForTesting,
    setWatchFactoryForTesting,
    type WatchFactory,
} from "@/services/search/workspace-enumeration-invalidator"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock("child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("child_process")>()
    return {
        ...actual,
        spawn: spawnMock,
    }
})

/**
 * Builds a ripgrep stub that streams `files` and exits cleanly.
 *
 * Each invocation gets its own stream instances so repeated calls cannot
 * accidentally share an already-consumed Readable and appear to succeed.
 */
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

/**
 * A chokidar stand-in that lets a case fire file-set events on demand.
 *
 * Only the surface `ensureWorkspaceWatched` uses is implemented: chaining `on`
 * registrations and an awaitable `close`.
 */
function createFakeWatchFactory(): {
    factory: WatchFactory
    emit: (event: "add" | "unlink" | "addDir" | "unlinkDir", candidate: string) => void
    watchedPaths: string[][]
} {
    const listeners = new Map<string, Array<(candidate: string) => void>>()
    const watchedPaths: string[][] = []

    const watcher = {
        on(event: string, handler: (candidate: string) => void) {
            const existing = listeners.get(event) ?? []
            existing.push(handler)
            listeners.set(event, existing)
            return watcher
        },
        close: async () => {
            listeners.clear()
        },
    } as unknown as FSWatcher

    return {
        factory: (paths) => {
            watchedPaths.push([...paths])
            return watcher
        },
        emit: (event, candidate) => {
            for (const handler of listeners.get(event) ?? []) {
                handler(candidate)
            }
        },
        watchedPaths,
    }
}

describe("file-search workspace enumeration cache", () => {
    beforeEach(() => {
        spawnMock.mockReset()
        const spawnWrapper: typeof childProcess.spawn = (command, options) => spawnMock(command, options)
        vi.spyOn(fileSearch, "getSpawnFunction").mockReturnValue(spawnWrapper)
        vi.spyOn(fs.promises, "access").mockResolvedValue(undefined as any)
        vi.spyOn(fs.promises, "lstat").mockResolvedValue({ isDirectory: () => false } as fs.Stats)

        setVscodeHostProviderMock()
        vi.spyOn(HostProvider.window, "getOpenTabs").mockResolvedValue({ paths: [] } as any)
        // VS Code has no workspace index, so production always falls through to
        // ripgrep. Make that explicit instead of relying on the default stub.
        vi.spyOn(HostProvider.workspace, "searchWorkspaceItems").mockRejectedValue(
            new Error("searchWorkspaceItems is not implemented on the VS Code host"),
        )

        fileSearch.clearWorkspaceEnumerationCache()
    })

    afterEach(() => {
        fileSearch.clearWorkspaceEnumerationCache()
        resetWorkspaceWatchersForTesting()
        setWatchFactoryForTesting(undefined)
        vi.restoreAllMocks()
    })

    it("does not spawn one ripgrep process per keystroke for the same workspace", async () => {
        spawnMock.mockImplementation(() => stubRipgrepProcess(["src/alpha.ts", "src/beta.ts"]))

        // Mirrors a user typing "@al" — the debounce fires once per character.
        await fileSearch.searchWorkspaceFiles("a", "/workspace", 20)
        await fileSearch.searchWorkspaceFiles("al", "/workspace", 20)
        await fileSearch.searchWorkspaceFiles("alp", "/workspace", 20)

        expect(spawnMock).toHaveBeenCalledTimes(1)
    })

    it("returns identical results whether served from the cache or a fresh enumeration", async () => {
        spawnMock.mockImplementation(() => stubRipgrepProcess(["src/alpha.ts", "src/beta.ts"]))

        const fresh = await fileSearch.searchWorkspaceFiles("alpha", "/workspace", 20)
        const cached = await fileSearch.searchWorkspaceFiles("alpha", "/workspace", 20)

        expect(cached.items).toEqual(fresh.items)
        expect(cached.source).toEqual(fresh.source)
        expect(spawnMock).toHaveBeenCalledTimes(1)
    })

    it("collapses concurrent searches of the same workspace into a single enumeration", async () => {
        spawnMock.mockImplementation(() => stubRipgrepProcess(["src/alpha.ts"]))

        await Promise.all([
            fileSearch.searchWorkspaceFiles("a", "/workspace", 20),
            fileSearch.searchWorkspaceFiles("al", "/workspace", 20),
            fileSearch.searchWorkspaceFiles("alp", "/workspace", 20),
        ])

        expect(spawnMock).toHaveBeenCalledTimes(1)
    })

    it("keeps separate cache entries per workspace root", async () => {
        spawnMock.mockImplementation(() => stubRipgrepProcess(["src/alpha.ts"]))

        await fileSearch.searchWorkspaceFiles("a", "/workspace-one", 20)
        await fileSearch.searchWorkspaceFiles("a", "/workspace-two", 20)
        await fileSearch.searchWorkspaceFiles("a", "/workspace-one", 20)

        expect(spawnMock).toHaveBeenCalledTimes(2)
    })

    it("re-enumerates after the cache entry expires", async () => {
        spawnMock.mockImplementation(() => stubRipgrepProcess(["src/alpha.ts"]))

        // Only the clock is faked: ripgrep stubs rely on real `setImmediate`, so
        // faking timers wholesale would deadlock the stream teardown.
        const realNow = Date.now
        let clock = realNow()
        vi.spyOn(Date, "now").mockImplementation(() => clock)

        await fileSearch.searchWorkspaceFiles("a", "/workspace", 20)
        clock += fileSearch.WORKSPACE_ENUMERATION_CACHE_TTL_MS + 1
        await fileSearch.searchWorkspaceFiles("a", "/workspace", 20)

        expect(spawnMock).toHaveBeenCalledTimes(2)
    })

    it("does not cache failed enumerations", async () => {
        spawnMock.mockImplementationOnce(() => {
            const stdout = new Readable({ read() {} })
            const stderr = new Readable({ read() {} })
            const proc = Object.assign(new EventEmitter(), {
                stdout,
                stderr,
                kill: vi.fn(),
            }) as unknown as childProcess.ChildProcess
            setImmediate(() => {
                stdout.push(null)
                stderr.push("rg: fatal\n")
                stderr.push(null)
                proc.emit("exit", 2)
            })
            return proc
        })
        spawnMock.mockImplementation(() => stubRipgrepProcess(["src/alpha.ts"]))

        await expect(fileSearch.searchWorkspaceFiles("a", "/workspace", 20)).rejects.toThrow()

        const recovered = await fileSearch.searchWorkspaceFiles("a", "/workspace", 20)

        expect(recovered.items.length).toBeGreaterThan(0)
        expect(spawnMock).toHaveBeenCalledTimes(2)
    })

    it("does not enumerate at all when the host index serves the query", async () => {
        vi.mocked(HostProvider.workspace.searchWorkspaceItems).mockResolvedValue({
            items: [{ path: "src/alpha.ts", type: 1, label: "alpha.ts" }],
        } as any)

        const result = await fileSearch.searchWorkspaceFiles("alpha", "/workspace", 20)

        expect(result.source).toBe("host_index")
        expect(spawnMock).not.toHaveBeenCalled()
    })

    describe("invalidation on workspace changes", () => {
        // The TTL is long enough that only the watcher can keep the cache honest,
        // so these cases are what stop a new file from staying invisible.
        it("watches the enumerated root", async () => {
            const watch = createFakeWatchFactory()
            setWatchFactoryForTesting(watch.factory)
            spawnMock.mockImplementation(() => stubRipgrepProcess(["src/alpha.ts"]))

            await fileSearch.searchWorkspaceFiles("a", "/workspace", 20)

            expect(watch.watchedPaths).toEqual([[path.resolve("/workspace")]])
        })

        it.each([
            "add",
            "unlink",
            "addDir",
            "unlinkDir",
        ] as const)("re-enumerates after a %s event so the new file set is visible", async (event) => {
            const watch = createFakeWatchFactory()
            setWatchFactoryForTesting(watch.factory)
            spawnMock.mockImplementationOnce(() => stubRipgrepProcess(["src/alpha.ts"]))
            spawnMock.mockImplementation(() => stubRipgrepProcess(["src/alpha.ts", "src/beta.ts"]))

            const before = await fileSearch.searchWorkspaceFiles("", "/workspace", 20)
            expect(before.items.map((item) => item.path)).not.toContain("src\\beta.ts".replace("\\", path.sep))

            watch.emit(event, path.join(path.resolve("/workspace"), "src", "beta.ts"))

            const after = await fileSearch.searchWorkspaceFiles("", "/workspace", 20)

            expect(spawnMock).toHaveBeenCalledTimes(2)
            expect(after.items.some((item) => item.path.endsWith("beta.ts"))).toBe(true)
        })

        it("still serves from cache when nothing changed", async () => {
            const watch = createFakeWatchFactory()
            setWatchFactoryForTesting(watch.factory)
            spawnMock.mockImplementation(() => stubRipgrepProcess(["src/alpha.ts"]))

            await fileSearch.searchWorkspaceFiles("a", "/workspace", 20)
            await fileSearch.searchWorkspaceFiles("al", "/workspace", 20)

            expect(spawnMock).toHaveBeenCalledTimes(1)
        })

        it("keeps serving the workspace when the watcher cannot start", async () => {
            setWatchFactoryForTesting(() => {
                throw new Error("EMFILE: too many open files")
            })
            spawnMock.mockImplementation(() => stubRipgrepProcess(["src/alpha.ts"]))

            const result = await fileSearch.searchWorkspaceFiles("a", "/workspace", 20)

            expect(result.items.length).toBeGreaterThan(0)
            expect(spawnMock).toHaveBeenCalledTimes(1)
        })

        it("does not drop an in-flight walk, so no duplicate rg is spawned", async () => {
            const watch = createFakeWatchFactory()
            setWatchFactoryForTesting(watch.factory)

            let releaseFirstWalk!: () => void
            const firstWalkGate = new Promise<void>((resolve) => {
                releaseFirstWalk = resolve
            })
            spawnMock.mockImplementationOnce(() => {
                const stdout = new Readable({ read() {} })
                const stderr = new Readable({ read() {} })
                const proc = Object.assign(new EventEmitter(), {
                    stdout,
                    stderr,
                    kill: vi.fn(),
                }) as unknown as childProcess.ChildProcess
                void firstWalkGate.then(() => {
                    stdout.push("src/alpha.ts\n")
                    stdout.push(null)
                    stderr.push(null)
                    proc.emit("exit", 0)
                })
                return proc
            })
            spawnMock.mockImplementation(() => stubRipgrepProcess(["src/alpha.ts"]))

            const inFlight = fileSearch.searchWorkspaceFiles("a", "/workspace", 20)
            await Promise.resolve()

            // The event lands while the first walk is still running.
            watch.emit("add", path.join(path.resolve("/workspace"), "src", "beta.ts"))

            releaseFirstWalk()
            await inFlight

            expect(spawnMock).toHaveBeenCalledTimes(1)
        })
    })
})

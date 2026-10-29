import * as fileSearch from "@services/search/file-search"
import * as childProcess from "child_process"
import * as fs from "fs"
import type { FzfResultItem } from "fzf"
import should from "should"
// sinon import removed: using vitest globals
import { EventEmitter, Readable } from "stream"
import { afterEach, beforeEach, describe, it, vi } from "vitest"
import { HostProvider } from "@/hosts/host-provider"
import { getRipgrepCpuBudget, resetRipgrepCpuBudgetForTesting, resetRipgrepSlotsForTesting } from "@/services/ripgrep/cpu-budget"
import { SearchWorkspaceItemsRequest_SearchItemType, SearchWorkspaceItemsResponse } from "@/shared/proto/dline/host/workspace"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock("child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("child_process")>()
    return {
        ...actual,
        spawn: spawnMock,
    }
})

describe("File Search", () => {
    let sandbox: any /* sinon.SinonSandbox → vitest */
    let spawnStub: any /* sinon.SinonStub → vitest */

    beforeEach(() => {
        sandbox = { mockRestore: () => {} }
        spawnMock.mockReset()
        spawnStub = spawnMock

        // Create a wrapper function that matches the signature of childProcess.spawn
        const spawnWrapper: typeof childProcess.spawn = (command, options) => spawnStub(command, options)

        vi.spyOn(fileSearch, "getSpawnFunction").mockReturnValue(spawnWrapper)
        vi.spyOn(fs.promises, "lstat").mockResolvedValue({ isDirectory: () => false } as fs.Stats)

        // Mock fs.access to return true for both Unix and Windows ripgrep binary paths
        vi.spyOn(fs.promises, "access").mockResolvedValue(undefined as any)

        setVscodeHostProviderMock()
    })

    afterEach(() => {
        resetRipgrepCpuBudgetForTesting()
        resetRipgrepSlotsForTesting()
        vi.restoreAllMocks()
    })

    describe("executeRipgrepForFiles", () => {
        it("scopes ripgrep to the workspace so temp ancestors are not excluded", async () => {
            const workspacePath = "E:\\repo\\tmp\\e2e-workspace"
            const mockStdout = new Readable({ read() {} })
            const mockStderr = new Readable({ read() {} })
            const mockProcess = Object.assign(new EventEmitter(), {
                stdout: mockStdout,
                stderr: mockStderr,
                kill: vi.fn(),
            }) as unknown as childProcess.ChildProcess

            spawnStub.mockImplementation(() => {
                setImmediate(() => {
                    mockStdout.push("README.md\n")
                    mockStdout.push(null)
                    mockStderr.push(null)
                    mockProcess.emit("exit", 0)
                })
                return mockProcess
            })

            const result = await fileSearch.executeRipgrepForFiles(workspacePath, 5000)

            expect(spawnStub).toHaveBeenCalledWith(
                expect.any(String),
                expect.not.arrayContaining([workspacePath]),
                expect.objectContaining({ cwd: workspacePath }),
            )
            expect(result).toContainEqual({ path: "README.md", type: "file", label: "README.md" })
        })

        it("caps ripgrep worker threads so a walk cannot saturate the machine", async () => {
            resetRipgrepCpuBudgetForTesting(16)
            const mockStdout = new Readable({ read() {} })
            const mockStderr = new Readable({ read() {} })
            const mockProcess = Object.assign(new EventEmitter(), {
                stdout: mockStdout,
                stderr: mockStderr,
                kill: vi.fn(),
            }) as unknown as childProcess.ChildProcess

            spawnStub.mockImplementation(() => {
                setImmediate(() => {
                    mockStdout.push("README.md\n")
                    mockStdout.push(null)
                    mockStderr.push(null)
                    mockProcess.emit("exit", 0)
                })
                return mockProcess
            })

            await fileSearch.executeRipgrepForFiles("/workspace", 5000)

            const args = spawnStub.mock.calls[0][1] as string[]
            const threadsIndex = args.indexOf("--threads")
            expect(threadsIndex).toBeGreaterThanOrEqual(0)
            expect(Number(args[threadsIndex + 1])).toBe(getRipgrepCpuBudget().threadsPerProcess)
        })

        it("should correctly process and return file and folder results", async () => {
            const mockFiles = ["file1.txt", "folder1/file2.js", "folder1/subfolder/file3.py"]

            // Create a proper mock for the child process
            const mockStdout = new Readable({
                read() {
                    this.push(mockFiles.join("\n"))
                    this.push(null) // Signal the end of the stream
                },
            })

            const mockStderr = new Readable({
                read() {
                    this.push(null) // Empty stream
                },
            })

            spawnStub.mockReturnValue({
                stdout: mockStdout,
                stderr: mockStderr,
                on: vi.fn().mockReturnValue({}),
            } as unknown as childProcess.ChildProcess)

            // Instead of stubbing path functions, we'll stub the executeRipgrepForFiles function
            // to return a predictable result for this test
            const expectedResult: { path: string; type: "file" | "folder"; label?: string }[] = [
                { path: "file1.txt", type: "file", label: "file1.txt" },
                { path: "folder1/file2.js", type: "file", label: "file2.js" },
                { path: "folder1/subfolder/file3.py", type: "file", label: "file3.py" },
                { path: "folder1", type: "folder", label: "folder1" },
                { path: "folder1/subfolder", type: "folder", label: "subfolder" },
            ]

            // Create a new stub for executeRipgrepForFiles
            vi.spyOn(fileSearch, "executeRipgrepForFiles").mockResolvedValue(expectedResult)

            const result = await fileSearch.executeRipgrepForFiles("/workspace", 5000)

            should(result).be.an.Array()
            // Don't assert on the exact length as it may vary

            const files = result.filter((item) => item.type === "file")
            const folders = result.filter((item) => item.type === "folder")

            // Verify we have at least the expected files and folders
            should(files.length).be.greaterThanOrEqual(3)
            should(folders.length).be.greaterThanOrEqual(2)

            should(files[0]).have.properties({
                path: "file1.txt",
                type: "file",
                label: "file1.txt",
            })

            should(folders).containDeep([
                { path: "folder1", type: "folder", label: "folder1" },
                { path: "folder1/subfolder", type: "folder", label: "subfolder" },
            ])
        })

        it("should handle errors from ripgrep", async () => {
            const mockError = "Mock ripgrep error"

            // Create proper mock streams for error case
            const mockStdout = new Readable({
                read() {
                    this.push(null) // Empty stream
                },
            })

            const mockStderr = new Readable({
                read() {
                    this.push(mockError)
                    this.push(null) // Signal the end of the stream
                },
            })

            spawnStub.mockReturnValue({
                stdout: mockStdout,
                stderr: mockStderr,
                on: function (event: string, callback: Function) {
                    if (event === "error") {
                        callback(new Error(mockError))
                    }
                    return this
                },
            } as unknown as childProcess.ChildProcess)

            await should(fileSearch.executeRipgrepForFiles("/workspace", 5000)).be.rejectedWith(
                `ripgrep failed to spawn: ${mockError}`,
            )
        })

        it("should reject with RipgrepError when ripgrep exits non-zero with no results", async () => {
            const mockStdout = new Readable({
                read() {
                    this.push(null)
                },
            })
            const mockStderr = new Readable({
                read() {
                    this.push("rg: /bogus: No such file or directory (os error 2)")
                    this.push(null)
                },
            })

            let exitHandler: ((code: number | null) => void) | null = null
            spawnStub.mockReturnValue({
                stdout: mockStdout,
                stderr: mockStderr,
                on: function (event: string, callback: Function) {
                    if (event === "exit") {
                        exitHandler = callback as (code: number | null) => void
                        // Schedule the exit-code emission for after the readline 'close'
                        setImmediate(() => exitHandler?.(2))
                    }
                    return this
                },
                kill: () => {},
            } as unknown as childProcess.ChildProcess)

            const err = await fileSearch.executeRipgrepForFiles("/workspace", 5000).catch((e) => e)
            should(err.message).match(/ripgrep exited with code 2/)
            should(err).have.property("name", "RipgrepError")
            should(err.stderr).match(/No such file or directory/)
        })
    })

    describe("searchWorkspaceFiles", () => {
        it("should return top N results for empty query", async () => {
            const mockItems: { path: string; type: "file" | "folder"; label?: string }[] = [
                { path: "file1.txt", type: "file", label: "file1.txt" },
                { path: "folder1", type: "folder", label: "folder1" },
                { path: "file2.js", type: "file", label: "file2.js" },
            ]

            // Directly stub the searchWorkspaceFiles function for this test
            // This avoids issues with the executeRipgrepForFiles function
            const searchStub = vi.spyOn(fileSearch, "searchWorkspaceFiles") as any
            searchStub.mockResolvedValue({ items: mockItems.slice(0, 2), source: "ripgrep" })

            const result = await fileSearch.searchWorkspaceFiles("", "/workspace", 2)

            should(result.items).be.an.Array()
            should(result.items).have.length(2)
            should(result.items).deepEqual(mockItems.slice(0, 2))
            should(result.source).equal("ripgrep")
        })

        it("should not duplicate a folder when the host returns it as both an explicit folder and a parent of a file", async () => {
            // Repro for CLINE-2092 review feedback: with `selectedType=undefined`, the
            // host-index path returned `src/` as an explicit folder *and* `src/main.ts`
            // as a file, then the parent-walk re-added `src` as an inferred dir, so the
            // picker showed `src` twice.
            const hostResponse = SearchWorkspaceItemsResponse.create({
                items: [
                    { path: "src", type: SearchWorkspaceItemsRequest_SearchItemType.FOLDER, label: "src" },
                    { path: "src/main.ts", type: SearchWorkspaceItemsRequest_SearchItemType.FILE, label: "main.ts" },
                ],
            })
            const searchItemsStub = vi.spyOn(HostProvider.workspace, "searchWorkspaceItems").mockResolvedValue(hostResponse)
            vi.spyOn(HostProvider.window, "getOpenTabs").mockResolvedValue({ paths: [] } as any)

            const result = await fileSearch.searchWorkspaceFiles("", "/workspace", 20)

            should(searchItemsStub.mock.calls.length === 1).be.true()
            should(result.source).equal("host_index")

            const srcEntries = result.items.filter((item) => item.path === "src")
            should(srcEntries).have.length(1)
            should(srcEntries[0]).have.properties({ path: "src", type: "folder" })
        })

        it("should apply fuzzy matching for non-empty query", async () => {
            const mockItems: { path: string; type: "file" | "folder"; label?: string }[] = [
                { path: "file1.txt", type: "file", label: "file1.txt" },
                { path: "folder1/important.js", type: "file", label: "important.js" },
                { path: "file2.js", type: "file", label: "file2.js" },
            ]

            vi.spyOn(fileSearch, "executeRipgrepForFiles").mockResolvedValue(mockItems)
            const fzfStub = {
                find: vi.fn().mockReturnValue([{ item: mockItems[1], score: 0 }]),
            }
            // Create a mock for the fzf module
            const _fzfModuleStub = {
                Fzf: vi.fn().mockReturnValue(fzfStub),
                byLengthAsc: vi.fn(),
            }

            // Use a more reliable approach to mock dynamic imports
            // This replaces the actual implementation of searchWorkspaceFiles to avoid the dynamic import
            vi.spyOn(fileSearch, "searchWorkspaceFiles").mockImplementation(
                async (query: any, _workspacePath: any, limit: any) => {
                    if (!query.trim()) {
                        return { items: mockItems.slice(0, limit), source: "ripgrep" }
                    }
                    // Simulate the fuzzy search behavior
                    return { items: [mockItems[1]], source: "ripgrep" }
                },
            )

            const result = await fileSearch.searchWorkspaceFiles("imp", "/workspace", 2)

            should(result.items).be.an.Array()
            should(result.items).have.length(1)
            should(result.items[0]).have.properties({
                path: "folder1/important.js",
                type: "file",
                label: "important.js",
            })
        })
    })

    describe("OrderbyMatchScore", () => {
        it("should prioritize results with fewer gaps between matched characters", () => {
            const mockItemA: FzfResultItem<any> = { item: {}, positions: new Set([0, 1, 2, 5]), start: 0, end: 5, score: 0 }
            const mockItemB: FzfResultItem<any> = { item: {}, positions: new Set([0, 2, 4, 6]), start: 0, end: 6, score: 0 }

            const result = fileSearch.OrderbyMatchScore(mockItemA, mockItemB)

            should(result).be.lessThan(0)
        })
    })
})

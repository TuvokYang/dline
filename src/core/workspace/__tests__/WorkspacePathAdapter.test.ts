import { toPosixPath } from "@/utils/path"
/**
 * Unit tests for WorkspacePathAdapter
 * Tests the core functionality of path resolution in single and multi-root workspaces
 */

import { VcsType, WorkspaceRoot } from "@shared/multi-root/types"
import { expect } from "chai"
import * as path from "path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"
// sinon import removed
import { Logger } from "@/shared/services/Logger"
import { createWorkspacePathAdapter, WorkspacePathAdapter } from "../WorkspacePathAdapter"
import { WorkspaceRootManager } from "../WorkspaceRootManager"

describe("WorkspacePathAdapter", () => {
    let consoleWarnStub: any /* sinon.SinonStub → vitest */

    beforeEach(() => {
        consoleWarnStub = vi.spyOn(Logger, "warn")
    })

    afterEach(() => {
        consoleWarnStub.mockRestore()
    })

    describe("Single-Root Mode", () => {
        const testCwd = "/test/workspace"
        let adapter: WorkspacePathAdapter

        beforeEach(() => {
            adapter = new WorkspacePathAdapter({
                cwd: testCwd,
                isMultiRootEnabled: false,
            })
        })

        it("should resolve relative paths", () => {
            const result = adapter.resolvePath("src/file.ts")
            expect(result).to.equal(path.resolve(testCwd, "src/file.ts"))
        })

        it("should handle absolute paths", () => {
            const absolutePath = "/absolute/path/file.ts"
            const result = adapter.resolvePath(absolutePath)
            if (process.platform === "win32") {
                // On Windows, the leading "/" is stripped, resolved relative to cwd
                expect(result).to.equal(path.resolve(testCwd, "absolute/path/file.ts"))
            } else {
                expect(result).to.equal(path.resolve(testCwd, absolutePath))
            }
        })

        it("should get workspace for path within cwd", () => {
            const workspace = adapter.getWorkspaceForPath("/test/workspace/src/file.ts")
            expect(workspace).to.deep.equal({
                name: "workspace",
                path: testCwd,
            })
        })

        it("should return undefined for path outside cwd", () => {
            const workspace = adapter.getWorkspaceForPath("/other/path/file.ts")
            expect(workspace).to.be.undefined
        })

        it("should get relative path from cwd", () => {
            const result = adapter.getRelativePath("/test/workspace/src/file.ts")
            expect(toPosixPath(result)).to.equal("src/file.ts")
        })

        it("should return single workspace root", () => {
            const roots = adapter.getWorkspaceRoots()
            expect(roots).to.have.length(1)
            expect(roots[0]).to.deep.equal({
                name: "workspace",
                path: testCwd,
            })
        })

        it("should report multi-root as disabled", () => {
            expect(adapter.isMultiRootEnabled()).to.be.false
        })
    })

    describe("Multi-Root Mode", () => {
        const roots: WorkspaceRoot[] = [
            { path: "/workspace/frontend", name: "frontend", vcs: VcsType.Git },
            { path: "/workspace/backend", name: "backend", vcs: VcsType.Git },
            { path: "/workspace/shared", name: "shared", vcs: VcsType.None },
        ]
        let adapter: WorkspacePathAdapter
        let mockManager: WorkspaceRootManager

        beforeEach(() => {
            mockManager = new WorkspaceRootManager(roots, 0)
            adapter = new WorkspacePathAdapter({
                cwd: "/workspace/frontend",
                isMultiRootEnabled: true,
                workspaceManager: mockManager,
            })
        })

        it("should resolve path with workspace hint by name", () => {
            const result = adapter.resolvePath("src/index.ts", "backend")
            expect(toPosixPath(result)).to.equal("/workspace/backend/src/index.ts")
        })

        it("should resolve path with workspace hint by path", () => {
            const result = adapter.resolvePath("src/index.ts", "/workspace/shared")
            expect(toPosixPath(result)).to.equal("/workspace/shared/src/index.ts")
        })

        it("should default to primary workspace without hint", () => {
            const result = adapter.resolvePath("src/index.ts")
            expect(toPosixPath(result)).to.equal("/workspace/frontend/src/index.ts")
        })

        it("should handle absolute paths belonging to a workspace", () => {
            const absolutePath = "/workspace/backend/src/api.ts"
            const result = adapter.resolvePath(absolutePath)
            if (process.platform === "win32") {
                // On Windows, the leading "/" is stripped, path becomes workspace-relative
                // and resolves against the primary workspace via path.join
                expect(toPosixPath(result)).to.equal("/workspace/frontend/workspace/backend/src/api.ts")
            } else {
                expect(result).to.equal(absolutePath)
            }
        })

        it("should warn for absolute paths outside workspaces", () => {
            const absolutePath = "/other/path/file.ts"
            const result = adapter.resolvePath(absolutePath)

            if (process.platform === "win32") {
                // On Windows, the leading "/" is stripped, path becomes workspace-relative
                expect(toPosixPath(result)).to.equal("/workspace/frontend/other/path/file.ts")
            } else {
                expect(result).to.equal(absolutePath)
                expect(consoleWarnStub.mock.calls.length === 1).to.be.true
                expect(consoleWarnStub.mock.calls[0][0]).to.include("doesn't belong to any workspace")
            }
        })

        it("should get all possible paths across workspaces", () => {
            const paths = adapter.getAllPossiblePaths("src/config.ts")
            expect(paths).to.have.length(3)
            // Normalize each path for cross-platform comparison
            const normalizedPaths = paths.map((p) => toPosixPath(p))
            expect(normalizedPaths).to.deep.equal([
                "/workspace/frontend/src/config.ts",
                "/workspace/backend/src/config.ts",
                "/workspace/shared/src/config.ts",
            ])
        })

        it("should identify workspace for path", () => {
            const workspace = adapter.getWorkspaceForPath("/workspace/backend/src/api.ts")
            expect(workspace).to.deep.equal({
                name: "backend",
                path: "/workspace/backend",
            })
        })

        it("should get relative path from appropriate workspace", () => {
            const result = adapter.getRelativePath("/workspace/backend/src/api.ts")
            expect(toPosixPath(result)).to.equal("src/api.ts")
        })

        it("should return all workspace roots", () => {
            const workspaceRoots = adapter.getWorkspaceRoots()
            expect(workspaceRoots).to.have.length(3)
            expect(workspaceRoots[0].name).to.equal("frontend")
            expect(workspaceRoots[1].name).to.equal("backend")
            expect(workspaceRoots[2].name).to.equal("shared")
        })

        it("should get primary workspace", () => {
            const primary = adapter.getPrimaryWorkspace()
            expect(primary).to.deep.equal({
                name: "frontend",
                path: "/workspace/frontend",
            })
        })

        it("should warn for invalid workspace hint", () => {
            const result = adapter.resolvePath("src/file.ts", "nonexistent")

            expect(toPosixPath(result)).to.equal("/workspace/frontend/src/file.ts") // Falls back to primary
            expect(consoleWarnStub.mock.calls.length === 1).to.be.true
            expect(consoleWarnStub.mock.calls[0][0]).to.include("not found")
        })
    })

    describe("Edge Cases", () => {
        it("should handle empty workspace manager gracefully", () => {
            const mockManager = new WorkspaceRootManager([], 0)
            const adapter = new WorkspacePathAdapter({
                cwd: "/fallback",
                isMultiRootEnabled: true,
                workspaceManager: mockManager,
            })

            const result = adapter.resolvePath("src/file.ts")
            expect(toPosixPath(result)).to.include("/fallback/src/file.ts")
            expect(consoleWarnStub.mock.calls.length > 0).to.be.true
        })

        it("should handle paths with special characters", () => {
            const adapter = new WorkspacePathAdapter({
                cwd: "/test/workspace",
                isMultiRootEnabled: false,
            })

            const specialPath = "src/file with spaces & symbols!.ts"
            const result = adapter.resolvePath(specialPath)
            expect(result).to.equal(path.resolve("/test/workspace", specialPath))
        })
    })

    describe("Factory Function", () => {
        it("should create adapter using factory function", () => {
            const adapter = createWorkspacePathAdapter({
                cwd: "/test/workspace",
                isMultiRootEnabled: false,
            })

            expect(adapter).to.be.instanceOf(WorkspacePathAdapter)
            expect(adapter.isMultiRootEnabled()).to.be.false
        })
    })

    describe("Windows Drive Letter Case Sensitivity", () => {
        // These tests only run on Windows since drive letters are a Windows concept.
        // On POSIX, path.relative is case-sensitive but drive letters don't exist.
        const runWinOnly = process.platform === "win32" ? describe : describe.skip

        runWinOnly("resolvePath with case-mismatched drive letter (multi-root)", () => {
            const winCwd = "E:\\workspace\\vscode\\dline"
            const winRoots: WorkspaceRoot[] = [{ path: "E:\\workspace\\vscode\\dline", name: "dline", vcs: VcsType.Git }]

            it("should NOT warn when absolute path uses lowercase drive letter with forward slashes", () => {
                const manager = new WorkspaceRootManager(winRoots, 0)
                const adapter = new WorkspacePathAdapter({
                    cwd: winCwd,
                    isMultiRootEnabled: true,
                    workspaceManager: manager,
                })

                // Simulate path coming from Node.js module resolution: lowercase 'e', forward slashes
                const absolutePath = "e:/workspace/vscode/dline/src/core/api/providers/models/xai.ts"
                const result = adapter.resolvePath(absolutePath)

                // Should return the path as-is (already absolute) and NOT warn
                expect(toPosixPath(result)).to.equal("e:/workspace/vscode/dline/src/core/api/providers/models/xai.ts")

                // The key assertion: no "doesn't belong" warning should fire
                const warnCalls = consoleWarnStub.mock.calls.filter(
                    (call: string[]) => typeof call[0] === "string" && call[0].includes("doesn't belong"),
                )
                expect(warnCalls).to.have.lengthOf(0)
            })

            it("should NOT warn when absolute path uses forward slashes with matching drive letter", () => {
                const manager = new WorkspaceRootManager(winRoots, 0)
                const adapter = new WorkspacePathAdapter({
                    cwd: winCwd,
                    isMultiRootEnabled: true,
                    workspaceManager: manager,
                })

                const absolutePath = "E:/workspace/vscode/dline/src/file.ts"
                const result = adapter.resolvePath(absolutePath)

                expect(toPosixPath(result)).to.equal("E:/workspace/vscode/dline/src/file.ts")

                const warnCalls = consoleWarnStub.mock.calls.filter(
                    (call: string[]) => typeof call[0] === "string" && call[0].includes("doesn't belong"),
                )
                expect(warnCalls).to.have.lengthOf(0)
            })
        })

        runWinOnly("getWorkspaceForPath with case-mismatched drive letter", () => {
            const winCwd = "E:\\workspace\\vscode\\dline"

            it("should find workspace when path uses lowercase drive letter (multi-root)", () => {
                const winRoots: WorkspaceRoot[] = [{ path: "E:\\workspace\\vscode\\dline", name: "dline", vcs: VcsType.Git }]
                const manager = new WorkspaceRootManager(winRoots, 0)
                const adapter = new WorkspacePathAdapter({
                    cwd: winCwd,
                    isMultiRootEnabled: true,
                    workspaceManager: manager,
                })

                const workspace = adapter.getWorkspaceForPath("e:/workspace/vscode/dline/src/core/api/providers/models/xai.ts")
                expect(workspace).to.not.be.undefined
                expect(workspace!.name).to.equal("dline")
            })

            it("should find workspace when path uses lowercase drive letter (single-root)", () => {
                const adapter = new WorkspacePathAdapter({
                    cwd: winCwd,
                    isMultiRootEnabled: false,
                })

                const workspace = adapter.getWorkspaceForPath("e:/workspace/vscode/dline/src/core/api/providers/models/xai.ts")
                expect(workspace).to.not.be.undefined
                expect(workspace!.name).to.equal("dline")
            })
        })

        runWinOnly("getRelativePath with case-mismatched drive letter", () => {
            const winCwd = "E:\\workspace\\vscode\\dline"

            it("should return relative path (not absolute) for case-mismatched input (multi-root)", () => {
                const winRoots: WorkspaceRoot[] = [{ path: "E:\\workspace\\vscode\\dline", name: "dline", vcs: VcsType.Git }]
                const manager = new WorkspaceRootManager(winRoots, 0)
                const adapter = new WorkspacePathAdapter({
                    cwd: winCwd,
                    isMultiRootEnabled: true,
                    workspaceManager: manager,
                })

                const relative = adapter.getRelativePath("e:/workspace/vscode/dline/src/core/api/providers/models/xai.ts")
                // Should be a relative path, not an absolute path (which would indicate failure)
                expect(path.isAbsolute(relative)).to.be.false
            })

            it("should return relative path (not absolute) for case-mismatched input (single-root)", () => {
                const adapter = new WorkspacePathAdapter({
                    cwd: winCwd,
                    isMultiRootEnabled: false,
                })

                const relative = adapter.getRelativePath("e:/workspace/vscode/dline/src/core/api/providers/models/xai.ts")
                expect(path.isAbsolute(relative)).to.be.false
            })
        })

        runWinOnly("WorkspaceRootManager.resolvePathToRoot with case-mismatched drive letter", () => {
            it("should find root when absolute path has different drive letter case", () => {
                const winRoots: WorkspaceRoot[] = [{ path: "E:\\workspace\\vscode\\dline", name: "dline", vcs: VcsType.Git }]
                const manager = new WorkspaceRootManager(winRoots, 0)

                const root = manager.resolvePathToRoot("e:/workspace/vscode/dline/src/core/api/providers/models/xai.ts")
                expect(root).to.not.be.undefined
                expect(root!.name).to.equal("dline")
            })

            it("should find root when path uses forward slashes but matching drive letter", () => {
                const winRoots: WorkspaceRoot[] = [{ path: "E:\\workspace\\vscode\\dline", name: "dline", vcs: VcsType.Git }]
                const manager = new WorkspaceRootManager(winRoots, 0)

                const root = manager.resolvePathToRoot("E:/workspace/vscode/dline/src/file.ts")
                expect(root).to.not.be.undefined
                expect(root!.name).to.equal("dline")
            })

            it("should handle multiple roots with mixed case", () => {
                const winRoots: WorkspaceRoot[] = [
                    { path: "E:\\workspace\\frontend", name: "frontend", vcs: VcsType.Git },
                    { path: "E:\\workspace\\backend", name: "backend", vcs: VcsType.Git },
                ]
                const manager = new WorkspaceRootManager(winRoots, 0)

                // Path in backend workspace with lowercase drive letter
                const root = manager.resolvePathToRoot("e:/workspace/backend/src/api.ts")
                expect(root).to.not.be.undefined
                expect(root!.name).to.equal("backend")
            })
        })

        runWinOnly("resolvePath with empty or mismatched roots (multi-root)", () => {
            it("SHOULD warn when roots array is empty", () => {
                const manager = new WorkspaceRootManager([], 0)
                const adapter = new WorkspacePathAdapter({
                    cwd: "E:\\workspace\\vscode\\dline",
                    isMultiRootEnabled: true,
                    workspaceManager: manager,
                })

                const absolutePath = "e:/workspace/vscode/dline/src/core/api/providers/models/xai.ts"
                const result = adapter.resolvePath(absolutePath)

                // Result should still be returned (path passed through)
                expect(toPosixPath(result)).to.equal("e:/workspace/vscode/dline/src/core/api/providers/models/xai.ts")

                // BUG: warning fires when roots is empty
                const warnCalls = consoleWarnStub.mock.calls.filter(
                    (call: string[]) => typeof call[0] === "string" && call[0].includes("doesn't belong"),
                )
                expect(warnCalls).to.have.lengthOf(1)
            })

            it("SHOULD warn when roots don't contain the target path (different root)", () => {
                const winRoots: WorkspaceRoot[] = [{ path: "D:\\other\\project", name: "other", vcs: VcsType.Git }]
                const manager = new WorkspaceRootManager(winRoots, 0)
                const adapter = new WorkspacePathAdapter({
                    cwd: "E:\\workspace\\vscode\\dline",
                    isMultiRootEnabled: true,
                    workspaceManager: manager,
                })

                const absolutePath = "e:/workspace/vscode/dline/src/core/api/providers/models/xai.ts"
                adapter.resolvePath(absolutePath)

                const warnCalls = consoleWarnStub.mock.calls.filter(
                    (call: string[]) => typeof call[0] === "string" && call[0].includes("doesn't belong"),
                )
                expect(warnCalls).to.have.lengthOf(1)
            })
        })
    })
})

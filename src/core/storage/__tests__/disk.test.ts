import { afterEach, beforeEach, describe, it, vi } from "vitest"
import "should"
import * as fsUtils from "@utils/fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { getAllHooksDirs, getWorkspaceHooksDirs, setRuntimeHooksDir } from "../disk"
import { StateManager } from "../StateManager"

describe("disk - hooks functionality", () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `disk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
		await fs.mkdir(tempDir, { recursive: true })
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		setRuntimeHooksDir(undefined)
		try {
			await fs.rm(tempDir, { recursive: true, force: true })
		} catch (_error) {
			// Ignore cleanup errors
		}
	})

	describe("getWorkspaceHooksDirs", () => {
		it("should return empty array when no workspace roots exist", async () => {
			vi.spyOn(StateManager, "get").mockReturnValue({
				getGlobalStateKey: () => undefined,
			} as any)

			const result = await getWorkspaceHooksDirs()
			result.should.be.an.Array()
			result.length.should.equal(0)
		})

		it("should return empty array when workspace roots is empty array", async () => {
			vi.spyOn(StateManager, "get").mockReturnValue({
				getGlobalStateKey: () => [],
			} as any)

			const result = await getWorkspaceHooksDirs()
			result.should.be.an.Array()
			result.length.should.equal(0)
		})

		it("should return empty array when no hooks directories exist", async () => {
			const workspaceRoot = path.join(tempDir, "workspace1")
			await fs.mkdir(workspaceRoot, { recursive: true })

			vi.spyOn(StateManager, "get").mockReturnValue({
				getGlobalStateKey: () => [{ path: workspaceRoot }],
			} as any)

			const result = await getWorkspaceHooksDirs()
			result.should.be.an.Array()
			result.length.should.equal(0)
		})

		it("should return hooks directory when it exists", async () => {
			const workspaceRoot = path.join(tempDir, "workspace1")
			const hooksDir = path.join(workspaceRoot, ".agents", "hooks")
			await fs.mkdir(hooksDir, { recursive: true })

			vi.spyOn(StateManager, "get").mockReturnValue({
				getGlobalStateKey: () => [{ path: workspaceRoot }],
			} as any)

			const result = await getWorkspaceHooksDirs()
			result.should.be.an.Array()
			result.length.should.equal(1)
			result[0].should.equal(hooksDir)
		})

		it("should not return hooks directory if it's a file instead of directory", async () => {
			const workspaceRoot = path.join(tempDir, "workspace1")
			const hooksPath = path.join(workspaceRoot, ".agents", "hooks")
			await fs.mkdir(path.dirname(hooksPath), { recursive: true })
			await fs.writeFile(hooksPath, "not a directory")

			vi.spyOn(StateManager, "get").mockReturnValue({
				getGlobalStateKey: () => [{ path: workspaceRoot }],
			} as any)

			const result = await getWorkspaceHooksDirs()
			result.should.be.an.Array()
			result.length.should.equal(0)
		})

		it("should return multiple hooks directories for multi-root workspace", async () => {
			const workspaceRoot1 = path.join(tempDir, "workspace1")
			const workspaceRoot2 = path.join(tempDir, "workspace2")
			const hooksDir1 = path.join(workspaceRoot1, ".agents", "hooks")
			const hooksDir2 = path.join(workspaceRoot2, ".agents", "hooks")

			await fs.mkdir(hooksDir1, { recursive: true })
			await fs.mkdir(hooksDir2, { recursive: true })

			vi.spyOn(StateManager, "get").mockReturnValue({
				getGlobalStateKey: () => [{ path: workspaceRoot1 }, { path: workspaceRoot2 }],
			} as any)

			const result = await getWorkspaceHooksDirs()
			result.should.be.an.Array()
			result.length.should.equal(2)
			result.should.containEql(hooksDir1)
			result.should.containEql(hooksDir2)
		})

		it("should return only existing hooks directories in multi-root workspace", async () => {
			const workspaceRoot1 = path.join(tempDir, "workspace1")
			const workspaceRoot2 = path.join(tempDir, "workspace2")
			const workspaceRoot3 = path.join(tempDir, "workspace3")
			const hooksDir1 = path.join(workspaceRoot1, ".agents", "hooks")
			const hooksDir3 = path.join(workspaceRoot3, ".agents", "hooks")

			await fs.mkdir(hooksDir1, { recursive: true })
			await fs.mkdir(workspaceRoot2, { recursive: true })
			await fs.mkdir(hooksDir3, { recursive: true })

			vi.spyOn(StateManager, "get").mockReturnValue({
				getGlobalStateKey: () => [{ path: workspaceRoot1 }, { path: workspaceRoot2 }, { path: workspaceRoot3 }],
			} as any)

			const result = await getWorkspaceHooksDirs()
			result.should.be.an.Array()
			result.length.should.equal(2)
			result.should.containEql(hooksDir1)
			result.should.containEql(hooksDir3)
			result.should.not.containEql(path.join(workspaceRoot2, ".agents", "hooks"))
		})

		it("should propagate errors when checking directory fails", async () => {
			const workspaceRoot = path.join(tempDir, "workspace1")
			await fs.mkdir(workspaceRoot, { recursive: true })

			vi.spyOn(StateManager, "get").mockReturnValue({
				getGlobalStateKey: () => [{ path: workspaceRoot }],
			} as any)

			vi.spyOn(fsUtils, "isDirectory").mockRejectedValue(new Error("Permission denied"))

			try {
				await getWorkspaceHooksDirs()
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.message.should.equal("Permission denied")
			}
		})

		it("should use correct path joining for hooks directory", async () => {
			const workspaceRoot = path.join(tempDir, "workspace1")
			const expectedHooksDir = path.join(workspaceRoot, ".agents", "hooks")
			await fs.mkdir(expectedHooksDir, { recursive: true })

			vi.spyOn(StateManager, "get").mockReturnValue({
				getGlobalStateKey: () => [{ path: workspaceRoot }],
			} as any)

			const result = await getWorkspaceHooksDirs()
			result[0].should.equal(expectedHooksDir)
		})

		it("should handle workspace roots with trailing slashes", async () => {
			const workspaceRoot = path.join(tempDir, "workspace1")
			const workspaceRootWithSlash = workspaceRoot + path.sep
			const hooksDir = path.join(workspaceRoot, ".agents", "hooks")
			await fs.mkdir(hooksDir, { recursive: true })

			vi.spyOn(StateManager, "get").mockReturnValue({
				getGlobalStateKey: () => [{ path: workspaceRootWithSlash }],
			} as any)

			const result = await getWorkspaceHooksDirs()
			result.should.be.an.Array()
			result.length.should.equal(1)
			result[0].should.equal(hooksDir)
		})
	})

	describe("getAllHooksDirs", () => {
		it("should include the runtime hooks directory when it exists", async () => {
			const runtimeHooksDir = path.join(tempDir, "runtime-hooks")
			await fs.mkdir(runtimeHooksDir, { recursive: true })

			vi.spyOn(os, "homedir").mockReturnValue(tempDir)
			vi.spyOn(StateManager, "get").mockReturnValue({
				getGlobalStateKey: () => [],
			} as any)

			vi.spyOn(fsUtils, "isDirectory").mockImplementation(async (targetPath: string) => targetPath === runtimeHooksDir)

			setRuntimeHooksDir(runtimeHooksDir)

			const result = await getAllHooksDirs()
			result.should.containEql(runtimeHooksDir)
		})

		it("should not include the runtime hooks directory when it does not exist", async () => {
			const runtimeHooksDir = path.join(tempDir, "missing-runtime-hooks")

			vi.spyOn(os, "homedir").mockReturnValue(tempDir)
			vi.spyOn(StateManager, "get").mockReturnValue({
				getGlobalStateKey: () => [],
			} as any)

			vi.spyOn(fsUtils, "isDirectory").mockResolvedValue(false)

			setRuntimeHooksDir(runtimeHooksDir)

			const result = await getAllHooksDirs()
			result.should.not.containEql(runtimeHooksDir)
		})
	})
})

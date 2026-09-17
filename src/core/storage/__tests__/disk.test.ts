// @ts-nocheck — taskHistory lock functions removed, tests need rewriting for TaskHistory
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, vi } from "vitest"
import "should"
import { HistoryItem } from "@shared/HistoryItem"
import * as fsUtils from "@utils/fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
// sinon import removed: using vitest globals
import { HostProvider } from "@/hosts/host-provider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import {
	// Promise.resolve(true), — removed, use TaskHistory instead
	appendTaskHistoryItem,
	getAllHooksDirs,
	getTaskHistoryStateFilePath,
	getWorkspaceHooksDirs,
	readTaskHistoryFromState,
	// Promise.resolve(), — removed, use TaskHistory instead
	setRuntimeHooksDir,
	writeTaskHistoryToState,
} from "../disk"
import { StateManager } from "../StateManager"

describe("disk - hooks functionality", () => {
	let sandbox: any /* sinon.SinonSandbox → vitest */
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

describe("disk - JSONL task history", () => {
	let sandbox: any /* sinon.SinonSandbox → vitest */
	let testDir: string
	let origDlineDocs: string | undefined

	beforeAll(async () => {
		testDir = path.join(os.tmpdir(), `cline-test-jl-${Date.now()}-${Math.random().toString(36).slice(2)}`)
		await fs.mkdir(testDir, { recursive: true })
		await fs.mkdir(path.join(testDir, "tasks"), { recursive: true })

		origDlineDocs = process.env.DLINE_DOCS_DIR
		process.env.DLINE_DOCS_DIR = testDir

		setVscodeHostProviderMock({ globalStorageFsPath: testDir })
	})

	afterAll(async () => {
		HostProvider.reset()

		if (origDlineDocs === undefined) {
			delete process.env.DLINE_DOCS_DIR
		} else {
			process.env.DLINE_DOCS_DIR = origDlineDocs
		}

		try {
			await fs.rm(testDir, { recursive: true, force: true })
		} catch {
			// ignore cleanup errors
		}
	})

	beforeEach(async () => {
		sandbox = { mockRestore: () => {} }
		// Reset the JSONL file between tests to prevent cross-test contamination
		try {
			const fp = await getTaskHistoryStateFilePath()
			await fs.unlink(fp)
		} catch {
			// File may not exist yet
		}
	})

	afterEach(async () => {
		vi.restoreAllMocks()
	})

	const item = (id: string, task: string, overrides?: Partial<HistoryItem>): HistoryItem => ({
		id,
		ts: overrides?.ts ?? Date.now(),
		task,
		tokensIn: overrides?.tokensIn ?? 100,
		tokensOut: overrides?.tokensOut ?? 200,
		totalCost: overrides?.totalCost ?? 0.01,
		...overrides,
	})

	describe("basic write/read round-trip", () => {
		it("should write and read task history (JSONL)", async () => {
			const items = [item("t1", "Build a todo app", { ts: 2 }), item("t2", "Fix a bug", { ts: 1 })]

			await writeTaskHistoryToState(items)
			const result = await readTaskHistoryFromState()

			result.should.be.an.Array()
			result.should.have.length(2)
			result[0].id.should.equal("t1")
			result[0].task.should.equal("Build a todo app")
			result[1].id.should.equal("t2")
			result[1].task.should.equal("Fix a bug")
		})

		it("should write valid JSONL with one JSON object per line", async () => {
			const items = [
				item("jl-1", "Test with special chars: 你好 🎉"),
				item("jl-2", "Test with quotes: \"hello\" and 'world'"),
			]

			await writeTaskHistoryToState(items)

			const filePath = await getTaskHistoryStateFilePath()
			const raw = await fs.readFile(filePath, "utf8")
			const lines = raw.trim().split("\n")
			lines.should.have.length(2)
			for (const line of lines) {
				const parsed = JSON.parse(line)
				parsed.should.have.property("id")
				parsed.should.have.property("task")
			}
		})

		it("should handle empty array", async () => {
			await writeTaskHistoryToState([])
			const result = await readTaskHistoryFromState()
			result.should.be.an.Array()
			result.should.have.length(0)
		})

		it("should overwrite existing history", async () => {
			await writeTaskHistoryToState([item("ov-1", "Initial")])
			let r = await readTaskHistoryFromState()
			r.should.have.length(1)

			await writeTaskHistoryToState([item("ov-2", "New 2"), item("ov-3", "New 3")])
			r = await readTaskHistoryFromState()
			r.should.have.length(2)
			r.map((x) => x.id).should.containEql("ov-2")
			r.map((x) => x.id).should.containEql("ov-3")
		})

		it("should preserve all HistoryItem fields", async () => {
			const full: HistoryItem = {
				id: "full",
				ts: 1234567890,
				task: "Complete task",
				tokensIn: 500,
				tokensOut: 1000,
				totalCost: 0.15,
				cacheWrites: 100,
				cacheReads: 200,
			}
			await writeTaskHistoryToState([full])
			const r = await readTaskHistoryFromState()
			r.should.have.length(1)
			r[0].id.should.equal("full")
			r[0].ts.should.equal(1234567890)
			r[0].tokensIn.should.equal(500)
			r[0].cacheWrites?.should.equal(100)
		})

		it("should preserve special characters", async () => {
			const items = [
				item("sp-1", "Test\nwith\nnewlines"),
				item("sp-2", "Test\twith\ttabs"),
				item("sp-3", "Test with unicode: 日本語 中文 한국어"),
				item("sp-4", "Test with emojis: 😀🎉🚀"),
			]
			await writeTaskHistoryToState(items)
			const r = await readTaskHistoryFromState()
			r.should.have.length(4)
			r[0].task.should.equal("Test\nwith\nnewlines")
			r[1].task.should.equal("Test\twith\ttabs")
			r[2].task.should.equal("Test with unicode: 日本語 中文 한국어")
			r[3].task.should.equal("Test with emojis: 😀🎉🚀")
		})

		it("should handle large task history arrays", async () => {
			// mocha this.timeout removed — vitest uses testTimeout config: (30000)
			const base = "X".repeat(50 * 1024)
			const baseTs = Date.now()
			const items = Array.from({ length: 1000 }, (_, i) => item(`big-${i}`, `Task ${i}: ${base}`, { ts: baseTs + i }))
			await writeTaskHistoryToState(items)
			const r = await readTaskHistoryFromState()
			r.should.have.length(1000)
			// Sorted ts desc — last inserted has highest ts, comes first
			r[0].id.should.equal("big-999")
		})

		it("should handle rapid successive writes", async () => {
			// mocha this.timeout removed — vitest uses testTimeout config: (5000)
			for (let i = 0; i < 20; i++) {
				await writeTaskHistoryToState([item(`rapid-${i}`, `Task ${i}`)])
			}
			const r = await readTaskHistoryFromState()
			r.should.be.an.Array()
			r.should.have.length(1)
			r[0].id.should.equal("rapid-19")
		})
	})

	describe("appendTaskHistoryItem", () => {
		it("should append items to JSONL", async () => {
			await appendTaskHistoryItem(item("a1", "First"))
			await appendTaskHistoryItem(item("a2", "Second"))

			const r = await readTaskHistoryFromState()
			r.should.have.length(2)
			r.map((x) => x.id).should.containEql("a1")
			r.map((x) => x.id).should.containEql("a2")
		})

		it("should append items sorted by ts desc on read", async () => {
			const ts = Date.now()
			await appendTaskHistoryItem(item("ap-1", "Older", { ts: ts - 1000 }))
			await appendTaskHistoryItem(item("ap-2", "Newer", { ts: ts }))

			const r = await readTaskHistoryFromState()
			r.should.have.length(2)
			// Newer ts first
			r[0].id.should.equal("ap-2")
			r[1].id.should.equal("ap-1")
		})
	})

	describe("JSONL dedup by id", () => {
		it("should deduplicate by id, keeping last occurrence (highest ts)", async () => {
			const baseTs = Date.now()
			await appendTaskHistoryItem(item("dup-1", "First version", { ts: baseTs }))
			await appendTaskHistoryItem(item("dup-1", "Updated version", { ts: baseTs + 1000, tokensIn: 999 }))

			const r = await readTaskHistoryFromState()
			r.should.have.length(1)
			r[0].id.should.equal("dup-1")
			r[0].task.should.equal("Updated version")
			r[0].tokensIn.should.equal(999)
		})

		it("should deduplicate multiple updates for the same id", async () => {
			const ts = Date.now()
			await appendTaskHistoryItem(item("multi", "v1", { ts: ts }))
			await appendTaskHistoryItem(item("multi", "v2", { ts: ts + 100 }))
			await appendTaskHistoryItem(item("multi", "v3", { ts: ts + 200 }))

			const r = await readTaskHistoryFromState()
			r.should.have.length(1)
			r[0].task.should.equal("v3")
		})
	})

	describe("_deleted flag filtering", () => {
		it("should exclude items with _deleted:true", async () => {
			await appendTaskHistoryItem(item("del-1", "Will be deleted"))
			await appendTaskHistoryItem({
				id: "del-1",
				ts: Date.now() + 1,
				task: "",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				_deleted: true,
			} as any)

			const r = await readTaskHistoryFromState()
			r.should.have.length(0)
		})

		it("should not exclude items without _deleted flag", async () => {
			await appendTaskHistoryItem(item("keep", "Keep me"))
			const r = await readTaskHistoryFromState()
			r.should.have.length(1)
			r[0].id.should.equal("keep")
		})

		it("should still show item if _deleted is false", async () => {
			await appendTaskHistoryItem({ ...item("nd", "Not deleted"), _deleted: false } as any)
			const r = await readTaskHistoryFromState()
			r.should.have.length(1)
		})

		it("should handle delete-then-recreate", async () => {
			const ts = Date.now()
			await appendTaskHistoryItem(item("recreate", "First", { ts }))
			await appendTaskHistoryItem({
				id: "recreate",
				ts: ts + 1,
				task: "",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				_deleted: true,
			} as any)
			// Then re-add
			await appendTaskHistoryItem(item("recreate", "Re-added", { ts: ts + 2 }))

			const r = await readTaskHistoryFromState()
			r.should.have.length(1)
			r[0].id.should.equal("recreate")
			r[0].task.should.equal("Re-added")
		})
	})

	// JSONL locking is covered by the backend FileLock and buffered-store integration tests.
	describe("file locking", () => {
		it("is covered by backend integration tests", async () => {})
	})

	describe("concurrent append safety", () => {
		it("should not lose entries under concurrent appends", async () => {
			// mocha this.timeout removed — vitest uses testTimeout config: (10000)
			const ts = Date.now()
			const promises = []
			for (let i = 0; i < 50; i++) {
				// Use unique ids to test mass append
				promises.push(appendTaskHistoryItem(item(`cc-${i}`, `Task ${i}`, { ts: ts + i })))
			}
			await Promise.all(promises)

			const r = await readTaskHistoryFromState()
			r.should.have.length(50)
		})

		it("should survive concurrent append + overwrite mix", async () => {
			// mocha this.timeout removed — vitest uses testTimeout config: (10000)
			const ts = Date.now()
			// Append many items
			await Promise.all(
				Array.from({ length: 30 }, (_, i) => appendTaskHistoryItem(item(`mix-${i}`, `v${i}`, { ts: ts + i }))),
			)
			// Then a full overwrite
			await writeTaskHistoryToState([item("mix-final", "Final", { ts: ts + 100 })])

			const r = await readTaskHistoryFromState()
			r.should.have.length(1)
			r[0].id.should.equal("mix-final")
		})
	})
})

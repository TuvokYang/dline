import type { FSWatcher } from "chokidar"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Logger } from "@/shared/services/Logger"
import { ensureTaskDirectoryExists } from "../../../storage/disk"
import { TaskState } from "../../TaskState"
import { createFocusChainMarkdownContent, getFocusChainFilePath } from "../file-utils"
import { FocusChainManager } from "../index"

const UNCHANGED_WATCH_EVENT_LOG = "File watcher triggered but content unchanged"

/** The model's own formatting: blank lines that the persisted file representation does not keep. */
const MODEL_CHECKLIST = `# Build Feature

## Setup

- [ ] Install dependencies
- [ ] Configure lint`

describe("FocusChainManager - user modification detection", () => {
	let tempDocumentsDir: string
	let taskId: string
	let focusChainFilePath: string
	let manager: FocusChainManager | undefined

	beforeEach(async () => {
		tempDocumentsDir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-focus-chain-user-edit-"))
		vi.stubEnv("DLINE_DOCS_DIR", tempDocumentsDir)
		taskId = `test-${Date.now()}`
		const taskDir = await ensureTaskDirectoryExists(taskId)
		focusChainFilePath = getFocusChainFilePath(taskDir, taskId)
	})

	afterEach(async () => {
		manager?.dispose()
		manager = undefined
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		await fs.rm(tempDocumentsDir, { recursive: true, force: true })
	})

	async function startWatchedManager(taskState: TaskState, postStateToWebview: () => Promise<void>) {
		manager = new FocusChainManager({
			taskId,
			taskState,
			getMode: () => "act",
			stateManager: {} as any,
			postStateToWebview,
			say: vi.fn().mockResolvedValue(undefined),
			focusChainSettings: { enabled: true, remindClineInterval: 10 },
		})
		await manager.setupFocusChainFileWatcher()
		const watcher = (manager as unknown as { focusChainFileWatcher?: FSWatcher }).focusChainFileWatcher
		if (!watcher) throw new Error("focus chain watcher was not started")
		await new Promise<void>((resolve) => watcher.once("ready", () => resolve()))
		return manager
	}

	it("does not report its own write of a reformatted checklist as a user modification", async () => {
		const logSpy = vi.spyOn(Logger, "log")
		const taskState = new TaskState()
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const watched = await startWatchedManager(taskState, postStateToWebview)

		await watched.updateFCListFromToolResponse(MODEL_CHECKLIST)
		expect(taskState.currentFocusChainChecklist).toBe(MODEL_CHECKLIST)

		// The runtime's own write always echoes through the watcher; wait until that echo is handled
		// either as unchanged content or as a (false) user modification.
		await expect
			.poll(
				() =>
					postStateToWebview.mock.calls.length > 0 ||
					logSpy.mock.calls.some(([message]) => String(message).includes(UNCHANGED_WATCH_EVENT_LOG)),
				{ timeout: 10_000 },
			)
			.toBe(true)

		expect(taskState.todoListWasUpdatedByUser).toBe(false)
		expect(taskState.currentFocusChainChecklist).toBe(MODEL_CHECKLIST)
		expect(watched.generateFocusChainInstructions()).not.toContain("The user has modified this todo list")
	})

	it("still reports a real item edit made in the checklist file", async () => {
		const logSpy = vi.spyOn(Logger, "log")
		const taskState = new TaskState()
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const watched = await startWatchedManager(taskState, postStateToWebview)

		await watched.updateFCListFromToolResponse(MODEL_CHECKLIST)
		await expect
			.poll(
				() =>
					postStateToWebview.mock.calls.length > 0 ||
					logSpy.mock.calls.some(([message]) => String(message).includes(UNCHANGED_WATCH_EVENT_LOG)),
				{ timeout: 10_000 },
			)
			.toBe(true)

		const userEditedChecklist = "# Build Feature\n## Setup\n- [x] Install dependencies\n- [ ] Configure prettier"
		await fs.writeFile(focusChainFilePath, createFocusChainMarkdownContent(taskId, userEditedChecklist), "utf8")

		await expect.poll(() => taskState.currentFocusChainChecklist, { timeout: 10_000 }).toBe(userEditedChecklist)
		expect(taskState.todoListWasUpdatedByUser).toBe(true)
		expect(watched.generateFocusChainInstructions()).toContain("The user has modified this todo list")
	})
})

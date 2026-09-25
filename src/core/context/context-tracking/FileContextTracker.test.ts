import { afterEach, beforeEach, describe, it, vi, expect as vitestExpect } from "vitest"

const { mockGetTask, mockSaveTask, mockGetCwd } = vi.hoisted(() => ({
	mockGetTask: vi.fn(),
	mockSaveTask: vi.fn(),
	mockGetCwd: vi.fn().mockResolvedValue("/mock/workspace"),
}))

vi.mock("@core/storage/disk", () => ({
	getTaskMetadata: mockGetTask,
	saveTaskMetadata: mockSaveTask,
}))

vi.mock("@/utils/path", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/utils/path")>()
	return {
		...actual,
		getCwd: mockGetCwd,
	}
})

import { expect } from "chai"
import chokidar from "chokidar"
import * as path from "path"
// sinon import removed
import * as vscode from "vscode"
import { Controller } from "@/core/controller"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import type { FileMetadataEntry, TaskMetadata } from "./ContextTrackerTypes"
import { FileContextTracker } from "./FileContextTracker"
import { WorkspaceFileContextRegistry } from "./WorkspaceFileContextRegistry"

describe("FileContextTracker", () => {
	const filePath = "src/test-file.ts"
	const taskId = "test-task-id"

	let sandbox: any /* sinon.SinonSandbox → vitest */
	let _mockWorkspace: any /* sinon.SinonStub → vitest */
	let mockFileSystemWatcher: any
	let chokidarWatchStub: any /* sinon.SinonStub → vitest */
	let tracker: FileContextTracker
	let registry: WorkspaceFileContextRegistry
	let mockTaskMetadata: TaskMetadata
	let getTaskMetadataStub: any /* sinon.SinonStub → vitest */
	let saveTaskMetadataStub: any /* sinon.SinonStub → vitest */

	beforeEach(() => {
		// Mock vscode workspace
		Object.defineProperty(vscode.workspace, "workspaceFolders", {
			get: () => [
				{
					uri: { fsPath: "/mock/workspace" },
					name: "mock",
					index: 0,
				} as vscode.WorkspaceFolder,
			],
			configurable: true,
		})

		// Mock chokidar file watcher
		mockFileSystemWatcher = {
			close: vi.fn().mockResolvedValue(undefined),
			on: vi.fn(),
		}
		// Return the watcher itself for chaining
		mockFileSystemWatcher.on.mockReturnValue(mockFileSystemWatcher)

		// Stub chokidar.watch to return our mock watcher
		chokidarWatchStub = vi.spyOn(chokidar, "watch").mockReturnValue(mockFileSystemWatcher as any)

		// Mock disk module functions + getCwd (vitest restoreMocks resets these)
		mockTaskMetadata = { files_in_context: [], model_usage: [], environment_history: [] }
		mockGetCwd.mockResolvedValue("/mock/workspace")
		getTaskMetadataStub = mockGetTask.mockResolvedValue(mockTaskMetadata)
		saveTaskMetadataStub = mockSaveTask.mockResolvedValue(undefined)

		setVscodeHostProviderMock()

		// Each test gets its own registry so shared watchers never leak between cases
		registry = new WorkspaceFileContextRegistry()
		tracker = new FileContextTracker({} as Controller, taskId, registry)
	})

	afterEach(() => {
		// Clear mock history between tests without restoring vi.mock-based mocks
		vi.clearAllMocks()
	})

	it("should add a record when a file is read by a tool", async () => {
		await tracker.trackFileContext(filePath, "read_tool")

		// Verify getTaskMetadata was called
		expect(getTaskMetadataStub.mock.calls.length === 1).to.be.true
		expect(getTaskMetadataStub.mock.calls[0][0]).to.equal(taskId)

		// Verify saveTaskMetadata was called with the correct data
		expect(saveTaskMetadataStub.mock.calls.length === 1).to.be.true

		const savedMetadata = saveTaskMetadataStub.mock.calls[0][1]
		expect(savedMetadata.files_in_context.length).to.equal(1)

		const fileEntry = savedMetadata.files_in_context[0]
		expect(fileEntry.path).to.equal(filePath)
		expect(fileEntry.record_state).to.equal("active")
		expect(fileEntry.record_source).to.equal("read_tool")
		expect(fileEntry.cline_read_date).to.be.a("number")
		expect(fileEntry.cline_edit_date).to.be.null
	})

	it("should add a record when a file is edited by Cline", async () => {
		await tracker.trackFileContext(filePath, "cline_edited")

		// Verify saveTaskMetadata was called with the correct data
		expect(saveTaskMetadataStub.mock.calls.length === 1).to.be.true
		const savedMetadata = saveTaskMetadataStub.mock.calls[0][1]

		// Check that we have at least one entry in files_in_context
		expect(savedMetadata.files_in_context).to.be.an("array").that.is.not.empty

		// Find the active entry for this file
		const activeEntry = savedMetadata.files_in_context.find(
			(entry: FileMetadataEntry) => entry.path === filePath && entry.record_state === "active",
		)

		// Assert that we found an active entry
		expect(activeEntry).to.exist

		// Now check the properties of the active entry
		expect(activeEntry.path).to.equal(filePath)
		expect(activeEntry.record_state).to.equal("active")
		expect(activeEntry.record_source).to.equal("cline_edited")
		expect(activeEntry.cline_read_date).to.be.a("number")
		expect(activeEntry.cline_edit_date).to.be.a("number")
	})

	it("should add a record when a file is mentioned", async () => {
		await tracker.trackFileContext(filePath, "file_mentioned")

		// Verify saveTaskMetadata was called with the correct data
		const savedMetadata = saveTaskMetadataStub.mock.calls[0][1]
		const fileEntry = savedMetadata.files_in_context[0]

		expect(fileEntry.path).to.equal(filePath)
		expect(fileEntry.record_state).to.equal("active")
		expect(fileEntry.record_source).to.equal("file_mentioned")
		expect(fileEntry.cline_read_date).to.be.a("number")
		expect(fileEntry.cline_edit_date).to.be.null
	})

	it("should add a record when a file is edited by the user", async () => {
		await tracker.trackFileContext(filePath, "user_edited")

		// Verify saveTaskMetadata was called with the correct data
		const savedMetadata = saveTaskMetadataStub.mock.calls[0][1]
		const fileEntry = savedMetadata.files_in_context[0]

		expect(fileEntry.path).to.equal(filePath)
		expect(fileEntry.record_state).to.equal("active")
		expect(fileEntry.record_source).to.equal("user_edited")
		expect(fileEntry.user_edit_date).to.be.a("number")

		// Verify the file was added to recentlyModifiedFiles
		const modifiedFiles = tracker.getAndClearRecentlyModifiedFiles()
		expect(modifiedFiles).to.include(filePath)
	})

	it("should mark existing entries as stale when adding a new entry for the same file", async () => {
		// Add an initial entry
		mockTaskMetadata.files_in_context = [
			{
				path: filePath,
				record_state: "active",
				record_source: "read_tool",
				cline_read_date: Date.now() - 1000, // 1 second ago
				cline_edit_date: null,
				user_edit_date: null,
			},
		]

		// Track a new operation on the same file
		await tracker.trackFileContext(filePath, "cline_edited")

		// Verify the metadata now has two entries - one stale and one active
		const savedMetadata = saveTaskMetadataStub.mock.calls[0][1]
		expect(savedMetadata.files_in_context.length).to.equal(2)

		// First entry should be marked as stale
		expect(savedMetadata.files_in_context[0].record_state).to.equal("stale")

		// New entry should be active
		const newEntry = savedMetadata.files_in_context[1]
		expect(newEntry.record_state).to.equal("active")
		expect(newEntry.record_source).to.equal("cline_edited")
	})

	it("should setup a file watcher for tracked files", async () => {
		await tracker.trackFileContext(filePath, "read_tool")

		// Verify chokidar.watch was called
		expect(chokidarWatchStub.mock.calls.length > 0).to.be.true

		// Verify change listener was set up
		expect(mockFileSystemWatcher.on.mock.calls.length > 0).to.be.true
	})

	it("should track user edits when file watcher detects changes", async () => {
		// First track the file to set up the watcher
		await tracker.trackFileContext(filePath, "read_tool")

		// Reset the stubs to check the next calls
		getTaskMetadataStub.mockClear()
		saveTaskMetadataStub.mockClear()

		// Create a spy on trackFileContext to verify it's called with the right parameters
		const trackFileContextSpy = vi.spyOn(tracker, "trackFileContext")

		// Get the callback that was registered with chokidar "change" event
		const callback = mockFileSystemWatcher.on.mock.calls[0][1]

		// Directly call the callback to simulate a file change event
		callback(vscode.Uri.file(path.resolve("/mock/workspace", filePath)))

		// Verify trackFileContext was called with the right parameters
		vitestExpect(trackFileContextSpy).toHaveBeenCalledWith(filePath, "user_edited")

		// Verify the file was added to recentlyModifiedFiles
		const modifiedFiles = tracker.getAndClearRecentlyModifiedFiles()
		expect(modifiedFiles).to.include(filePath)
	})

	it("should not track Cline edits as user edits", async () => {
		// First track the file to set up the watcher
		await tracker.trackFileContext(filePath, "read_tool")

		// Mark the file as edited by Cline
		tracker.markFileAsEditedByCline(filePath)

		// Reset the stubs to check the next calls
		getTaskMetadataStub.mockClear()
		saveTaskMetadataStub.mockClear()

		// Create a spy on trackFileContext to verify it's not called
		const trackFileContextSpy = vi.spyOn(tracker, "trackFileContext")

		// Get the callback that was registered with chokidar "change" event
		const callback = mockFileSystemWatcher.on.mock.calls[0][1]

		// Directly call the callback to simulate a file change event
		callback(vscode.Uri.file(path.resolve("/mock/workspace", filePath)))

		// Verify trackFileContext was not called with user_edited
		vitestExpect(trackFileContextSpy).not.toHaveBeenCalledWith(filePath, "user_edited")

		// Verify the file was not added to recentlyModifiedFiles
		const modifiedFiles = tracker.getAndClearRecentlyModifiedFiles()
		expect(modifiedFiles).to.not.include(filePath)
	})

	it("peeks recently modified files without consuming them", async () => {
		await tracker.trackFileContext(filePath, "user_edited")

		const firstSnapshot = tracker.peekRecentlyModifiedFiles()
		const secondSnapshot = tracker.peekRecentlyModifiedFiles()

		expect(firstSnapshot.files).to.deep.equal([filePath])
		expect(secondSnapshot).to.deep.equal(firstSnapshot)
	})

	it("acknowledges only the exact recently modified snapshot", async () => {
		await tracker.trackFileContext(filePath, "user_edited")
		const snapshot = tracker.peekRecentlyModifiedFiles()

		await tracker.trackFileContext(filePath, "user_edited")
		tracker.acknowledgeRecentlyModifiedFiles(snapshot)

		expect(tracker.peekRecentlyModifiedFiles().files).to.deep.equal([filePath])
	})

	it("restores checkpoint revisions without overwriting newer file edits", async () => {
		await tracker.trackFileContext(filePath, "user_edited")
		const checkpoint = tracker.peekRecentlyModifiedFiles()
		await tracker.trackFileContext(filePath, "user_edited")

		tracker.restoreRecentlyModifiedFiles({
			files: [...checkpoint.files, "src/restored.ts"],
			revisions: { ...checkpoint.revisions, "src/restored.ts": 7 },
		})

		const restored = tracker.peekRecentlyModifiedFiles()
		expect(restored.files).to.include(filePath)
		expect(restored.files).to.include("src/restored.ts")
		expect(restored.revisions[filePath]).to.be.greaterThan(checkpoint.revisions[filePath])
		expect(restored.revisions["src/restored.ts"]).to.equal(7)
	})

	it("should dispose file watchers when dispose is called", async () => {
		// Track a file to set up the watcher
		await tracker.trackFileContext(filePath, "read_tool")

		// Call dispose
		await tracker.dispose()

		// Verify the watcher was closed
		expect(mockFileSystemWatcher.close.mock.calls.length > 0).to.be.true
	})

	describe("multiple tasks tracking the same workspace file", () => {
		const otherTaskId = "other-task-id"

		/** Fires the shared watcher's change handler once. */
		const emitWatcherChange = () => {
			const changeHandler = mockFileSystemWatcher.on.mock.calls.find(([event]: [string]) => event === "change")?.[1]
			expect(changeHandler, "expected a change handler to be registered").to.exist
			changeHandler()
		}

		let otherTracker: FileContextTracker

		beforeEach(async () => {
			otherTracker = new FileContextTracker({} as Controller, otherTaskId, registry)
			await tracker.trackFileContext(filePath, "read_tool")
			await otherTracker.trackFileContext(filePath, "read_tool")
			getTaskMetadataStub.mockClear()
			saveTaskMetadataStub.mockClear()
		})

		it("shares a single watcher across both trackers", () => {
			expect(chokidarWatchStub.mock.calls.length).to.equal(1)
		})

		it("makes an external edit visible to both trackers", () => {
			emitWatcherChange()

			expect(tracker.peekRecentlyModifiedFiles().files).to.deep.equal([filePath])
			expect(otherTracker.peekRecentlyModifiedFiles().files).to.deep.equal([filePath])
		})

		it("keeps the edit visible to the other tracker after one acknowledges it", () => {
			emitWatcherChange()

			expect(tracker.getAndClearRecentlyModifiedFiles()).to.deep.equal([filePath])

			expect(tracker.peekRecentlyModifiedFiles().files).to.be.empty
			expect(otherTracker.peekRecentlyModifiedFiles().files).to.deep.equal([filePath])
		})

		it("records the external edit in task metadata exactly once", async () => {
			emitWatcherChange()
			await vi.waitFor(() => {
				vitestExpect(saveTaskMetadataStub).toHaveBeenCalled()
			})

			const userEditedSaves = saveTaskMetadataStub.mock.calls.filter(([, metadata]: [string, TaskMetadata]) =>
				metadata.files_in_context.some(
					(entry: FileMetadataEntry) => entry.record_source === "user_edited" && entry.path === filePath,
				),
			)
			expect(userEditedSaves.length).to.equal(1)
		})

		it("keeps notifying the remaining tracker after the other disposes", async () => {
			await otherTracker.dispose()
			emitWatcherChange()

			expect(tracker.peekRecentlyModifiedFiles().files).to.deep.equal([filePath])
			expect(mockFileSystemWatcher.close.mock.calls.length).to.equal(0)
		})

		it("hides a Dline-authored edit from every tracker", () => {
			tracker.markFileAsEditedByCline(filePath)
			emitWatcherChange()

			expect(tracker.peekRecentlyModifiedFiles().files).to.be.empty
			expect(otherTracker.peekRecentlyModifiedFiles().files).to.be.empty
		})

		it("advances only one revision per observed change", async () => {
			emitWatcherChange()

			// The author callback records metadata asynchronously; a second publish
			// would only appear after that chain settles.
			await vi.waitFor(() => {
				vitestExpect(saveTaskMetadataStub).toHaveBeenCalled()
			})
			await vi.waitFor(() => {
				vitestExpect(registry.getRevision("/mock/workspace", filePath)).toBe(1)
			})

			const snapshot = tracker.peekRecentlyModifiedFiles()
			expect(snapshot.revisions[filePath]).to.equal(1)
			expect(otherTracker.peekRecentlyModifiedFiles().revisions[filePath]).to.equal(1)
		})
	})

	it("reports one path for relative and absolute spellings of the same file", async () => {
		await tracker.trackFileContext(filePath, "read_tool")
		await tracker.trackFileContext(path.resolve("/mock/workspace", filePath), "cline_edited")
		expect(chokidarWatchStub.mock.calls.length).to.equal(1)

		const changeHandler = mockFileSystemWatcher.on.mock.calls.find(([event]: [string]) => event === "change")?.[1]
		changeHandler()

		expect(tracker.getAndClearRecentlyModifiedFiles()).to.deep.equal([filePath])
		expect(tracker.peekRecentlyModifiedFiles().files).to.be.empty
	})

	it("settles a Dline write so a later change is reported again", async () => {
		await tracker.trackFileContext(filePath, "read_tool")
		tracker.markFileAsEditedByCline(filePath)
		const changeHandler = mockFileSystemWatcher.on.mock.calls.find(([event]: [string]) => event === "change")?.[1]
		changeHandler()
		expect(tracker.peekRecentlyModifiedFiles().files).to.be.empty

		tracker.settleClineEdit(filePath)
		changeHandler()
		expect(tracker.peekRecentlyModifiedFiles().files).to.deep.equal([filePath])
	})

	it("hides a first write from a task that has not tracked anything yet", async () => {
		// Another task already watches the file through the shared registry.
		const otherTracker = new FileContextTracker({} as Controller, "other-task-id", registry)
		await otherTracker.trackFileContext(filePath, "read_tool")

		// A brand new task writes that file as its very first action.
		const writer = new FileContextTracker({} as Controller, "writer-task-id", registry)
		await vi.waitFor(() => {
			vitestExpect(mockGetCwd).toHaveBeenCalled()
		})
		writer.markFileAsEditedByCline(filePath)

		const changeHandler = mockFileSystemWatcher.on.mock.calls.find(([event]: [string]) => event === "change")?.[1]
		expect(changeHandler, "expected a change handler to be registered").to.exist
		changeHandler()

		expect(otherTracker.peekRecentlyModifiedFiles().files).to.be.empty
	})

	it("keeps a later real edit visible after restoring a snapshot before any subscription", async () => {
		tracker.restoreRecentlyModifiedFiles({ files: [filePath], revisions: { [filePath]: 7 } })
		expect(tracker.getAndClearRecentlyModifiedFiles()).to.deep.equal([filePath])

		await tracker.trackFileContext(filePath, "read_tool")
		const changeHandler = mockFileSystemWatcher.on.mock.calls.find(([event]: [string]) => event === "change")?.[1]
		expect(changeHandler, "expected a change handler to be registered").to.exist
		changeHandler()

		expect(tracker.peekRecentlyModifiedFiles().files).to.deep.equal([filePath])
	})

	it("does not swallow a real edit when a Dline write happened before any watcher existed", async () => {
		// Track an unrelated file first so the workspace root is known and the mark
		// reaches the registry, which must ignore it because no watcher exists yet.
		await tracker.trackFileContext("src/other-file.ts", "read_tool")

		tracker.markFileAsEditedByCline(filePath)
		await tracker.trackFileContext(filePath, "cline_edited")

		// The shared mock watcher is reused for every path, so take the handler
		// registered for the file under test rather than the first one.
		const changeHandlers = mockFileSystemWatcher.on.mock.calls.filter(([event]: [string]) => event === "change")
		expect(changeHandlers.length, "expected a change handler per watched path").to.equal(2)
		changeHandlers[changeHandlers.length - 1][1]()

		expect(tracker.peekRecentlyModifiedFiles().files).to.deep.equal([filePath])
	})

	it("should clean orphaned warnings from the initialized task history", async () => {
		const getDeduplicated = vi.fn().mockResolvedValue([{ id: "existing-task" }])
		const setWorkspaceState = vi.fn()
		const stateManager = {
			taskHistory: { getDeduplicated },
			getAllWorkspaceStateEntries: () => ({
				"pendingFileContextWarning_existing-task": { files: [] },
				"pendingFileContextWarning_orphaned-task": { files: [] },
				unrelatedWorkspaceState: true,
			}),
			setWorkspaceState,
		}

		await FileContextTracker.cleanupOrphanedWarnings(stateManager as any)

		vitestExpect(getDeduplicated).toHaveBeenCalledOnce()
		vitestExpect(setWorkspaceState).toHaveBeenCalledOnce()
		vitestExpect(setWorkspaceState).toHaveBeenCalledWith("pendingFileContextWarning_orphaned-task", undefined)
	})
})

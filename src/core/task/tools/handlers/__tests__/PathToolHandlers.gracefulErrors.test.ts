import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AGENT_IGNORE_FILE, type IgnoreController } from "@core/ignore/IgnoreController"
import { RipgrepSearchTimeoutError } from "@services/ripgrep"
import { ClineDefaultTool } from "@shared/tools"
import * as pathUtils from "@utils/path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"
// sinon import removed: using vitest globals
import { TaskState } from "../../../TaskState"
import { ToolValidator } from "../../ToolValidator"
import type { TaskConfig } from "../../types/TaskConfig"
import { ListCodeDefinitionNamesToolHandler } from "../ListCodeDefinitionNamesToolHandler"
import { ListFilesToolHandler } from "../ListFilesToolHandler"
import { SearchFilesToolHandler } from "../SearchFilesToolHandler"

/**
 * End-to-end tests for path-based tool handlers' error recovery.
 *
 * These exercise the actual handlers with a mock TaskConfig (following the
 * SubagentToolHandler.test.ts pattern), verifying that:
 *
 *   1. Non-existent paths return a tool error (not a thrown exception)
 *   2. consecutiveMistakeCount increments on failure
 *   3. Repeated failures accumulate across calls
 *   4. A successful operation resets consecutiveMistakeCount to 0
 *   5. Missing parameters increment the counter
 *   6. Forced exceptions from core operations are caught gracefully
 */

let tmpDir: string

type SearchFilesHandlerTestAccess = { determineSearchPaths: () => never }

function createConfig() {
	const taskState = new TaskState()

	const callbacks = {
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		saveCheckpoint: vi.fn().mockResolvedValue(undefined),
		sayAndCreateMissingParamError: vi.fn().mockResolvedValue("missing"),
		shouldAutoApproveToolWithPath: vi.fn().mockResolvedValue(true),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		cancelTask: vi.fn().mockResolvedValue(undefined),
		updateTaskHistory: vi.fn().mockResolvedValue([]),
		switchToActMode: vi.fn().mockResolvedValue(false),
		setActiveHookExecution: vi.fn().mockResolvedValue(undefined),
		clearActiveHookExecution: vi.fn().mockResolvedValue(undefined),
		getActiveHookExecution: vi.fn().mockResolvedValue(undefined),
		runUserPromptSubmitHook: vi.fn().mockResolvedValue({}),
		executeCommandTool: vi
			.fn()
			.mockResolvedValue({ userRejected: false, result: "ok", completed: true, exitCode: 0, signal: null }),
		cancelRunningCommandTool: vi.fn().mockResolvedValue(false),
		doesLatestTaskCompletionHaveNewChanges: vi.fn().mockResolvedValue(false),
		updateFCListFromToolResponse: vi.fn().mockResolvedValue(undefined),
		shouldAutoApproveTool: vi.fn().mockReturnValue([true, true]),
		reinitExistingTaskFromId: vi.fn().mockResolvedValue(undefined),
		applyLatestBrowserSettings: vi.fn().mockResolvedValue(undefined),
	}

	const config = {
		taskId: "task-1",
		ulid: "ulid-1",
		cwd: tmpDir,
		mode: "act",
		strictPlanModeEnabled: false,
		yoloModeToggled: true,
		doubleCheckCompletionEnabled: false,
		vscodeTerminalExecutionMode: "backgroundExec",
		enableParallelToolCalling: true,
		isSubagentExecution: true, // skip UI calls and approval flow
		taskState,
		messageState: {},
		api: {
			getModel: () => ({ id: "test-model", info: { supportsImages: false } }),
		},
		autoApprovalSettings: {
			enableNotifications: false,
			actions: { executeSafeCommands: false, executeAllCommands: false },
		},
		autoApprover: {
			shouldAutoApproveTool: vi.fn().mockReturnValue([true, true]),
		},
		browserSettings: {},
		focusChainSettings: {},
		services: {
			stateManager: {
				getGlobalStateKey: () => undefined,
				getGlobalSettingsKey: (key: string) => {
					if (key === "mode") return "act"
					if (key === "hooksEnabled") return false
					return undefined
				},
				getApiConfiguration: () => ({
					planModeProfile: "openai",
					actModeProfile: "openai",
				}),
			},
			fileContextTracker: {
				trackFileContext: vi.fn().mockResolvedValue(undefined),
			},
			mcpHub: {},
			browserSession: {},
			urlContentFetcher: {},
			diffViewProvider: {},
			ignoreController: { validateAccess: () => true, filterPaths: (paths: string[]) => paths },
			commandPermissionController: {},
			contextManager: {},
		},
		callbacks,
		coordinator: { getHandler: vi.fn() },
	} as unknown as TaskConfig

	const validator = new ToolValidator({ validateAccess: () => true } as unknown as IgnoreController)

	return { config, callbacks, taskState, validator }
}

// ─── ListCodeDefinitionNamesToolHandler ─────────────────────────────────────

describe("ListCodeDefinitionNamesToolHandler.execute – error recovery", () => {
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cline-listdef-test-"))
		vi.spyOn(pathUtils, "isLocatedInWorkspace").mockResolvedValue(true)
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	function makeBlock(relPath?: string) {
		return {
			type: "tool_use" as const,
			function_id: "test_list_code_def",
			dline_tid: "test_tid_list_code_def",
			name: ClineDefaultTool.LIST_CODE_DEF,
			params: relPath !== undefined ? { path: relPath } : {},
			partial: false,
			ts: Date.now(),
		}
	}

	it("returns a tool result (not a thrown exception) for a non-existent directory", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new ListCodeDefinitionNamesToolHandler(validator)

		const result = await handler.execute(config, makeBlock("no-such-dir"))

		// parseSourceCodeForDefinitionsTopLevel returns a descriptive string for
		// non-existent directories rather than throwing. The handler now detects
		// this error condition and increments the counter.
		assert.equal(typeof result, "string")
		assert.ok((result as string).includes("does not exist or you do not have permission"))
		assert.equal(taskState.consecutiveMistakeCount, 1)
	})

	it("returns a graceful message for a file path (not a directory)", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new ListCodeDefinitionNamesToolHandler(validator)

		const filePath = "not-a-dir.txt"
		await fs.writeFile(path.join(tmpDir, filePath), "content")

		const result = await handler.execute(config, makeBlock(filePath))

		assert.equal(typeof result, "string")
		assert.ok((result as string).includes("file, not a directory"))
		assert.equal(taskState.consecutiveMistakeCount, 1)
	})

	it("increments consecutiveMistakeCount when path parameter is missing", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new ListCodeDefinitionNamesToolHandler(validator)

		const result = await handler.execute(config, makeBlock())

		assert.equal(result, "missing")
		assert.equal(taskState.consecutiveMistakeCount, 1)
	})

	it("resets consecutiveMistakeCount to 0 after a successful operation", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new ListCodeDefinitionNamesToolHandler(validator)

		// Accumulate failures via missing params
		await handler.execute(config, makeBlock())
		await handler.execute(config, makeBlock())
		assert.equal(taskState.consecutiveMistakeCount, 2)

		// Create a real directory and list definitions (will find none, but succeeds)
		const dirName = "real-dir"
		await fs.mkdir(path.join(tmpDir, dirName))

		await handler.execute(config, makeBlock(dirName))
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})

	it("catches a thrown exception from the core operation and returns a tool error", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new ListCodeDefinitionNamesToolHandler(validator)

		// Stub parseSourceCodeForDefinitionsTopLevel to throw
		const treeSitter = await import("@services/tree-sitter")
		vi.spyOn(treeSitter, "parseSourceCodeForDefinitionsTopLevel").mockRejectedValue(new Error("tree-sitter crashed"))

		const result = await handler.execute(config, makeBlock("some-dir"))

		assert.equal(typeof result, "string")
		assert.ok((result as string).includes("Error"))
		assert.ok((result as string).includes("tree-sitter crashed"))
		assert.equal(taskState.consecutiveMistakeCount, 1)
	})

	it("accumulates failures when the core operation throws repeatedly", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new ListCodeDefinitionNamesToolHandler(validator)

		const treeSitter = await import("@services/tree-sitter")
		vi.spyOn(treeSitter, "parseSourceCodeForDefinitionsTopLevel").mockRejectedValue(new Error("boom"))

		await handler.execute(config, makeBlock("dir-1"))
		assert.equal(taskState.consecutiveMistakeCount, 1)

		await handler.execute(config, makeBlock("dir-2"))
		assert.equal(taskState.consecutiveMistakeCount, 2)

		await handler.execute(config, makeBlock("dir-3"))
		assert.equal(taskState.consecutiveMistakeCount, 3)
	})

	it("accumulates failures for repeated non-existent directory calls", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new ListCodeDefinitionNamesToolHandler(validator)

		await handler.execute(config, makeBlock("nonexistent-1"))
		assert.equal(taskState.consecutiveMistakeCount, 1)

		await handler.execute(config, makeBlock("nonexistent-2"))
		assert.equal(taskState.consecutiveMistakeCount, 2)

		await handler.execute(config, makeBlock("nonexistent-3"))
		assert.equal(taskState.consecutiveMistakeCount, 3)
	})

	it("accumulates failures for repeated file-path (not directory) calls", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new ListCodeDefinitionNamesToolHandler(validator)

		const filePath1 = "file1.txt"
		const filePath2 = "file2.txt"
		const filePath3 = "file3.txt"
		await fs.writeFile(path.join(tmpDir, filePath1), "content")
		await fs.writeFile(path.join(tmpDir, filePath2), "content")
		await fs.writeFile(path.join(tmpDir, filePath3), "content")

		await handler.execute(config, makeBlock(filePath1))
		assert.equal(taskState.consecutiveMistakeCount, 1)

		await handler.execute(config, makeBlock(filePath2))
		assert.equal(taskState.consecutiveMistakeCount, 2)

		await handler.execute(config, makeBlock(filePath3))
		assert.equal(taskState.consecutiveMistakeCount, 3)
	})
})

// ─── ListFilesToolHandler ───────────────────────────────────────────────────

describe("ListFilesToolHandler.execute – error recovery", () => {
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cline-listfiles-test-"))
		vi.spyOn(pathUtils, "isLocatedInWorkspace").mockResolvedValue(true)
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	function makeBlock(relPath?: string, recursive?: string) {
		const params: Record<string, string> = {}
		if (relPath !== undefined) params.path = relPath
		if (recursive !== undefined) params.recursive = recursive
		return {
			type: "tool_use" as const,
			function_id: "test_list_files",
			dline_tid: "test_tid_list_files",
			name: ClineDefaultTool.LIST_FILES,
			params,
			partial: false,
			ts: Date.now(),
		}
	}

	it("returns a tool result (not a thrown exception) for a non-existent directory", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new ListFilesToolHandler(validator)

		const result = await handler.execute(config, makeBlock("no-such-dir"))

		// listFiles returns empty for non-existent directories, so the handler
		// should succeed rather than throw.
		assert.equal(typeof result, "string")
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})

	it("increments consecutiveMistakeCount when path parameter is missing", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new ListFilesToolHandler(validator)

		const result = await handler.execute(config, makeBlock())

		assert.equal(result, "missing")
		assert.equal(taskState.consecutiveMistakeCount, 1)
	})

	it("repeated missing-param failures accumulate", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new ListFilesToolHandler(validator)

		await handler.execute(config, makeBlock())
		await handler.execute(config, makeBlock())
		await handler.execute(config, makeBlock())
		assert.equal(taskState.consecutiveMistakeCount, 3)
	})

	it("resets consecutiveMistakeCount to 0 after a successful list", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new ListFilesToolHandler(validator)

		// Accumulate failures
		await handler.execute(config, makeBlock())
		await handler.execute(config, makeBlock())
		assert.equal(taskState.consecutiveMistakeCount, 2)

		// Create a real directory with a file
		const dirName = "real-dir"
		await fs.mkdir(path.join(tmpDir, dirName))
		await fs.writeFile(path.join(tmpDir, dirName, "file.txt"), "content")

		const result = await handler.execute(config, makeBlock(dirName))
		assert.equal(typeof result, "string")
		assert.ok((result as string).includes("file.txt"))
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})

	it("catches a thrown exception from listFiles and returns a tool error", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new ListFilesToolHandler(validator)

		// Stub listFiles to throw
		const listFilesModule = await import("@services/glob/list-files")
		vi.spyOn(listFilesModule, "listFiles").mockRejectedValue(new Error("cwd must be a directory"))

		const result = await handler.execute(config, makeBlock("some-dir"))

		assert.equal(typeof result, "string")
		assert.ok((result as string).includes("Error"))
		assert.ok((result as string).includes("cwd must be a directory"))
		// Tool result error (not a tool crash) — counter should NOT increment
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})

	it("does NOT increment counter for repeated tool result errors", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new ListFilesToolHandler(validator)

		const listFilesModule = await import("@services/glob/list-files")
		vi.spyOn(listFilesModule, "listFiles").mockRejectedValue(new Error("boom"))

		await handler.execute(config, makeBlock("dir-1"))
		assert.equal(taskState.consecutiveMistakeCount, 0)

		await handler.execute(config, makeBlock("dir-2"))
		assert.equal(taskState.consecutiveMistakeCount, 0)

		await handler.execute(config, makeBlock("dir-3"))
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})

	it("increments consecutiveMistakeCount on ignore denial", async () => {
		const { config, taskState } = createConfig()
		// Create a validator whose ignoreController blocks all paths
		const blockingValidator = new ToolValidator({ validateAccess: () => false } as unknown as IgnoreController)
		const handler = new ListFilesToolHandler(blockingValidator)

		const result = await handler.execute(config, makeBlock("blocked-dir"))

		assert.equal(typeof result, "string")
		assert.ok((result as string).includes(AGENT_IGNORE_FILE))
		assert.equal(taskState.consecutiveMistakeCount, 1)
	})

	it("accumulates ignore denials across repeated calls", async () => {
		const { config, taskState } = createConfig()
		const blockingValidator = new ToolValidator({ validateAccess: () => false } as unknown as IgnoreController)
		const handler = new ListFilesToolHandler(blockingValidator)

		await handler.execute(config, makeBlock("blocked-1"))
		await handler.execute(config, makeBlock("blocked-2"))
		await handler.execute(config, makeBlock("blocked-3"))
		assert.equal(taskState.consecutiveMistakeCount, 3)
	})
})

// ─── SearchFilesToolHandler ─────────────────────────────────────────────────

describe("SearchFilesToolHandler.execute – error recovery", () => {
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cline-search-test-"))
		vi.spyOn(pathUtils, "isLocatedInWorkspace").mockResolvedValue(true)
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	function makeBlock(relPath?: string, regex?: string, filePattern?: string) {
		const params: Record<string, string> = {}
		if (relPath !== undefined) params.path = relPath
		if (regex !== undefined) params.regex = regex
		if (filePattern !== undefined) params.file_pattern = filePattern
		return {
			type: "tool_use" as const,
			function_id: "test_search_files",
			dline_tid: "test_tid_search_files",
			name: ClineDefaultTool.SEARCH,
			params,
			partial: false,
			ts: Date.now(),
		}
	}

	it("returns a tool result (not a thrown exception) for a non-existent directory", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new SearchFilesToolHandler(validator)

		const result = await handler.execute(config, makeBlock("no-such-dir", "pattern"))

		// regexSearchFiles throws for non-existent directories, executeSearch catches it,
		// returns success=false. This is a tool result error (not a tool crash), so
		// consecutiveMistakeCount should NOT increment.
		assert.equal(typeof result, "string")
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})

	it("increments consecutiveMistakeCount when path parameter is missing", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new SearchFilesToolHandler(validator)

		const result = await handler.execute(config, makeBlock(undefined, "pattern"))

		assert.equal(result, "missing")
		assert.equal(taskState.consecutiveMistakeCount, 1)
	})

	it("increments consecutiveMistakeCount when regex parameter is missing", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new SearchFilesToolHandler(validator)

		const result = await handler.execute(config, makeBlock("some-dir"))

		assert.equal(result, "missing")
		assert.equal(taskState.consecutiveMistakeCount, 1)
	})

	it("repeated missing-param failures accumulate", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new SearchFilesToolHandler(validator)

		await handler.execute(config, makeBlock()) // missing path
		await handler.execute(config, makeBlock("dir")) // missing regex
		await handler.execute(config, makeBlock()) // missing path again
		assert.equal(taskState.consecutiveMistakeCount, 3)
	})

	it("resets consecutiveMistakeCount to 0 after a successful search", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new SearchFilesToolHandler(validator)

		// Accumulate failures
		await handler.execute(config, makeBlock())
		await handler.execute(config, makeBlock("dir"))
		assert.equal(taskState.consecutiveMistakeCount, 2)

		// Stub regexSearchFiles to return a successful result
		const ripgrepModule = await import("@services/ripgrep")
		vi.spyOn(ripgrepModule, "regexSearchFiles").mockResolvedValue("Found 0 results.\n\n")

		// Search in tmpDir (exists, will find 0 results but should succeed)
		const result = await handler.execute(config, makeBlock(".", "nonexistent-pattern-xyz"))
		assert.equal(typeof result, "string")
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})

	it("catches a thrown exception from path resolution and returns a tool error", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new SearchFilesToolHandler(validator)

		// Stub determineSearchPaths to throw (simulating a bad workspace config)
		vi.spyOn(handler as unknown as SearchFilesHandlerTestAccess, "determineSearchPaths").mockImplementation(() => {
			throw new Error("invalid workspace hint")
		})

		const result = await handler.execute(config, makeBlock("some-dir", "pattern"))

		assert.equal(typeof result, "string")
		assert.ok((result as string).includes("Error"))
		assert.ok((result as string).includes("invalid workspace hint"))
		// Tool result error (not a tool crash) — counter should NOT increment
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})

	it("does NOT increment counter for repeated path resolution errors", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new SearchFilesToolHandler(validator)

		vi.spyOn(handler as unknown as SearchFilesHandlerTestAccess, "determineSearchPaths").mockImplementation(() => {
			throw new Error("boom")
		})

		await handler.execute(config, makeBlock("dir-1", "pat"))
		assert.equal(taskState.consecutiveMistakeCount, 0)

		await handler.execute(config, makeBlock("dir-2", "pat"))
		assert.equal(taskState.consecutiveMistakeCount, 0)

		await handler.execute(config, makeBlock("dir-3", "pat"))
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})

	it("does NOT increment when regexSearchFiles throws (tool result error)", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new SearchFilesToolHandler(validator)

		// Stub regexSearchFiles to throw
		const ripgrepModule = await import("@services/ripgrep")
		vi.spyOn(ripgrepModule, "regexSearchFiles").mockRejectedValue(new Error("ripgrep crashed"))

		const result = await handler.execute(config, makeBlock(".", "pattern"))

		// Tool result error (not a tool crash) — counter should NOT increment
		assert.equal(typeof result, "string")
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})

	it("returns an actionable message when ripgrep reaches the search deadline", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new SearchFilesToolHandler(validator)
		const ripgrepModule = await import("@services/ripgrep")
		vi.spyOn(ripgrepModule, "regexSearchFiles").mockRejectedValue(new RipgrepSearchTimeoutError())

		const result = await handler.execute(config, makeBlock(".", "pattern", "*"))

		assert.equal(typeof result, "string")
		assert.match(result as string, /timed out after 10 minutes/i)
		assert.match(result as string, /Narrow the search path or file_pattern/)
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})

	it("does NOT increment for repeated regexSearchFiles errors", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new SearchFilesToolHandler(validator)

		const ripgrepModule = await import("@services/ripgrep")
		vi.spyOn(ripgrepModule, "regexSearchFiles").mockRejectedValue(new Error("boom"))

		await handler.execute(config, makeBlock("dir-1", "pat"))
		assert.equal(taskState.consecutiveMistakeCount, 0)

		await handler.execute(config, makeBlock("dir-2", "pat"))
		assert.equal(taskState.consecutiveMistakeCount, 0)

		await handler.execute(config, makeBlock("dir-3", "pat"))
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})

	it("resets consecutiveMistakeCount to 0 after success following param errors", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new SearchFilesToolHandler(validator)

		// Accumulate failures via missing params (model misuse, still counts)
		await handler.execute(config, makeBlock()) // missing path
		await handler.execute(config, makeBlock("dir")) // missing regex
		assert.equal(taskState.consecutiveMistakeCount, 2)

		// Stub regexSearchFiles for a successful call
		const ripgrepModule = await import("@services/ripgrep")
		vi.spyOn(ripgrepModule, "regexSearchFiles").mockResolvedValue("Found 0 results.\n\n")

		await handler.execute(config, makeBlock("dir-3", "pat"))
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})
})

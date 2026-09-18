/**
 * Tests for SearchFilesToolHandler path resolution:
 * - absolute paths should not be prepended with cwd
 * - workspace hint (@workspace:path) should resolve correctly
 * - relative paths should resolve against cwd
 */
import { strict as assert } from "node:assert"
import { createTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import * as path from "path"
import { describe, it } from "vitest"
import type { TaskConfig } from "../../types/TaskConfig"
// Access private determineSearchPaths via prototype
import { SearchFilesToolHandler } from "../SearchFilesToolHandler"

function createMockConfig(cwd: string, overrides: Partial<TaskConfig> = {}): TaskConfig {
	return {
		taskId: "test-task",
		ulid: "test-ulid",
		cwd,
		mode: "act" as any,
		strictPlanModeEnabled: false,
		yoloModeToggled: false,
		doubleCheckCompletionEnabled: false,
		vscodeTerminalExecutionMode: "vscodeTerminal",
		enableParallelToolCalling: false,
		isSubagentExecution: false,
		isMultiRootEnabled: false,
		taskState: {} as any,
		taskController: { rejectActiveBlock: () => {}, reset: () => {}, hasAnyRejection: () => false } as any,
		messageState: {} as any,
		api: {} as any,
		services: {} as any,
		autoApprovalSettings: {} as any,
		browserSettings: {} as any,
		focusChainSettings: {} as any,
		interactions: {} as any,
		callbacks: {} as any,
		coordinator: {} as any,
		identityFactory: {
			/** Return a stable function identity for this fixture. */
			nextFunctionId: () => "dline_function_search_test",
			/** Return a stable trace identity for this fixture. */
			nextTraceId: () => "dline_tid_search_test",
		},
		...overrides,
		capabilityToggles: overrides.capabilityToggles ?? createTaskCapabilityToggles({}),
	}
}

type DetermineSearchPathsFn = (
	config: TaskConfig,
	parsedPath: string,
	workspaceHint: string | undefined,
	originalPath: string,
) => Array<{ absolutePath: string; workspaceName?: string; workspaceRoot?: string }>

describe("SearchFilesToolHandler path resolution", () => {
	it("should NOT prepend cwd for absolute Windows path", () => {
		const handler = new SearchFilesToolHandler({} as any)
		const fn = (handler as any).determineSearchPaths.bind(handler) as DetermineSearchPathsFn
		const cwd = path.resolve("e:\\cline_test")
		const config = createMockConfig(cwd)
		const absPath = path.resolve("e:\\cline_test")

		const result = fn(config, absPath, undefined, absPath)

		assert.equal(result.length, 1)
		assert.equal(result[0].absolutePath, absPath)
	})

	it("should NOT prepend cwd for absolute Unix path on non-Windows", () => {
		if (process.platform === "win32") {
			return
		}
		const handler = new SearchFilesToolHandler({} as any)
		const fn = (handler as any).determineSearchPaths.bind(handler) as DetermineSearchPathsFn
		const cwd = "/home/user/project"
		const config = createMockConfig(cwd)
		const absPath = "/tmp/test_dir"

		const result = fn(config, absPath, undefined, absPath)

		assert.equal(result.length, 1)
		assert.equal(result[0].absolutePath, absPath)
	})

	it("should resolve relative path against cwd", () => {
		const handler = new SearchFilesToolHandler({} as any)
		const fn = (handler as any).determineSearchPaths.bind(handler) as DetermineSearchPathsFn
		const cwd = path.resolve("e:\\workspace\\test")
		const config = createMockConfig(cwd)

		const result = fn(config, ".", undefined, ".")

		assert.equal(result.length, 1)
		assert.equal(result[0].absolutePath, cwd)
	})

	it("should NOT prepend cwd for absolute path with double backslashes (XML encoded)", () => {
		const handler = new SearchFilesToolHandler({} as any)
		const fn = (handler as any).determineSearchPaths.bind(handler) as DetermineSearchPathsFn
		const cwd = "e:\\cline_test"
		const config = createMockConfig(cwd)
		const rawPath = "e:\\\\cline_test"

		const result = fn(config, rawPath, undefined, rawPath)

		if (process.platform === "win32") {
			assert.equal(result.length, 1)
			assert.ok(
				result[0].absolutePath === "e:\\cline_test" || path.isAbsolute(result[0].absolutePath),
				`Expected absolute path, got: ${result[0].absolutePath}`,
			)
			assert.ok(
				!result[0].absolutePath.includes("\\e:\\\\cline_test"),
				`Path should not contain cwd concatenation, got: ${result[0].absolutePath}`,
			)
		}
	})

	it("should resolve dot-dot relative path correctly", () => {
		if (process.platform !== "win32") {
			return
		}
		const handler = new SearchFilesToolHandler({} as any)
		const fn = (handler as any).determineSearchPaths.bind(handler) as DetermineSearchPathsFn
		const cwd = path.resolve("e:\\workspace\\test")
		const config = createMockConfig(cwd)
		const expectedPath = path.resolve("e:\\workspace")

		const result = fn(config, "..", undefined, "..")

		assert.equal(result.length, 1)
		assert.equal(result[0].absolutePath, expectedPath)
	})

	it("should handle @workspace_name:absolute_path in single-root mode", () => {
		const handler = new SearchFilesToolHandler({} as any)
		const fn = (handler as any).determineSearchPaths.bind(handler) as DetermineSearchPathsFn
		const cwd = "e:\\cline_test"
		const config = createMockConfig(cwd)
		// AI sends @workspace_name:absolute_path to target specific workspace
		const rawPath = "@cline_test:e:\\cline_test"
		const parsedPath = "e:\\cline_test"
		const hint = "cline_test"

		const result = fn(config, parsedPath, hint, rawPath)

		assert.equal(result.length, 1)
		if (process.platform === "win32") {
			assert.ok(path.isAbsolute(result[0].absolutePath), `Expected absolute path, got: ${result[0].absolutePath}`)
			// The path should be e:\cline_test, not e:\cline_test\e:\cline_test
			const normalized = path.resolve(result[0].absolutePath)
			assert.equal(normalized, path.resolve("e:\\cline_test"))
		}
	})
})

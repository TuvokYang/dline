import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ClineDefaultTool } from "@shared/tools"
import * as pathUtils from "@utils/path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"
// sinon import removed: using vitest globals
import { DefaultToolHandlerState } from "../../state/ToolHandlerState"
import { ToolValidator } from "../../ToolValidator"
import type { TaskConfig } from "../../types/TaskConfig"
import { ReadFileToolHandler } from "../ReadFileToolHandler"

/**
 * End-to-end tests for ReadFileToolHandler.execute().
 *
 * These exercise the actual handler with a mock TaskConfig (following the
 * SubagentToolHandler.test.ts pattern), verifying that:
 *
 *   1. Reading a non-existent file returns a tool error (not a thrown exception)
 *   2. consecutiveMistakeCount increments on failure
 *   3. Repeated failures accumulate (the counter is NOT reset before the read)
 *   4. A successful read resets consecutiveMistakeCount to 0
 *   5. Missing path parameter increments the counter
 */

let tmpDir: string

function createConfig() {
    const taskState = new DefaultToolHandlerState()

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
            getModel: () => ({ id: "test-model", info: { capabilities: { supportsImages: false } } }),
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
            ignoreController: { validateAccess: () => true },
            commandPermissionController: {},
            contextManager: {},
        },
        callbacks,
        coordinator: { getHandler: vi.fn() },
    } as unknown as TaskConfig

    const validator = new ToolValidator({ validateAccess: () => true } as any)

    return { config, callbacks, taskState, validator }
}

function makeBlock(relPath?: string) {
    return {
        type: "tool_use" as const,
        function_id: "test_read_file",
        dline_tid: "test_tid_read_file",
        name: ClineDefaultTool.FILE_READ,
        params: relPath !== undefined ? { path: relPath } : {},
        partial: false,
        ts: Date.now(),
    }
}

function makeBlockWithRange(relPath: string, startLine?: string, endLine?: string) {
    return {
        type: "tool_use" as const,
        function_id: "test_read_file_range",
        dline_tid: "test_tid_read_file_range",
        name: ClineDefaultTool.FILE_READ,
        params: {
            path: relPath,
            ...(startLine !== undefined ? { start_line: startLine } : {}),
            ...(endLine !== undefined ? { end_line: endLine } : {}),
        },
        partial: false,
        ts: Date.now(),
    }
}

describe("ReadFileToolHandler.execute – file not found", () => {
    let sandbox: any /* sinon.SinonSandbox → vitest */

    beforeEach(async () => {
        sandbox = { mockRestore: () => {} }
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cline-read-test-"))
        vi.spyOn(pathUtils, "isLocatedInWorkspace").mockResolvedValue(true)
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    })

    it("returns a tool error (not a thrown exception) for a non-existent file", async () => {
        const { config, taskState, validator } = createConfig()
        const handler = new ReadFileToolHandler(validator)

        const result = await handler.execute(config, makeBlock("no-such-file.py"))

        assert.equal(typeof result, "string")
        assert.ok((result as string).includes("File not found"))
        // File not found is NOT a model mistake — it's normal exploratory behavior
        assert.equal(taskState.consecutiveMistakeCount, 0)
    })

    it("returns an empty string for an existing empty file", async () => {
        const { config, validator } = createConfig()
        const handler = new ReadFileToolHandler(validator)
        const emptyFile = "empty.txt"
        await fs.writeFile(path.join(tmpDir, emptyFile), "")

        const result = await handler.execute(config, makeBlock(emptyFile))

        assert.equal(result, "")
    })

    it("reads a range beyond the first 400 KB of a large plain-text file", async () => {
        const { config, validator } = createConfig()
        const handler = new ReadFileToolHandler(validator)
        const largeFile = "large.log"
        const lines = Array.from({ length: 12_000 }, (_, index) => `row ${index + 1}`.padEnd(99, "."))
        await fs.writeFile(path.join(tmpDir, largeFile), `${lines.join("\n")}\n`)

        const result = await handler.execute(config, makeBlockWithRange(largeFile, "9000", "9001"))

        assert.equal(
            result,
            `9000 | ${lines[8999]}\n9001 | ${lines[9000]}\n\n(Showing lines 9000-9001 of 12000 total. Use start_line=9002 to continue reading.)`,
        )
    })

    it("does NOT increment consecutiveMistakeCount for file-not-found (exploratory)", async () => {
        const { config, taskState, validator } = createConfig()
        const handler = new ReadFileToolHandler(validator)

        await handler.execute(config, makeBlock("ghost-1.py"))
        assert.equal(taskState.consecutiveMistakeCount, 0)

        await handler.execute(config, makeBlock("ghost-2.py"))
        assert.equal(taskState.consecutiveMistakeCount, 0)

        await handler.execute(config, makeBlock("ghost-3.py"))
        assert.equal(taskState.consecutiveMistakeCount, 0)
    })

    it("resets consecutiveMistakeCount to 0 after a successful read", async () => {
        const { config, taskState, validator } = createConfig()
        const handler = new ReadFileToolHandler(validator)

        // Accumulate two failures via missing parameter (still counts as mistake)
        await handler.execute(config, makeBlock())
        await handler.execute(config, makeBlock())
        assert.equal(taskState.consecutiveMistakeCount, 2)

        // Create a real file and read it — success should reset the counter
        const realFile = "real-file.txt"
        await fs.writeFile(path.join(tmpDir, realFile), "hello world")

        const result = await handler.execute(config, makeBlock(realFile))
        assert.equal(result, "1 | hello world\n\n(File has 1 lines total.)")
        assert.equal(taskState.consecutiveMistakeCount, 0)
    })

    it("increments consecutiveMistakeCount when path parameter is missing", async () => {
        const { config, taskState, validator } = createConfig()
        const handler = new ReadFileToolHandler(validator)

        const result = await handler.execute(config, makeBlock())

        assert.equal(result, "missing")
        assert.equal(taskState.consecutiveMistakeCount, 1)
    })

    it("respects requested line ranges on cached rereads", async () => {
        const { config, validator } = createConfig()
        const handler = new ReadFileToolHandler(validator)

        const realFile = "real-file.txt"
        await fs.writeFile(path.join(tmpDir, realFile), "alpha\nbeta\ngamma\n")

        const firstRead = await handler.execute(config, makeBlock(realFile))
        assert.equal(firstRead, "1 | alpha\n2 | beta\n3 | gamma\n\n(File has 3 lines total.)")

        const secondRead = await handler.execute(config, makeBlockWithRange(realFile, "2", "2"))
        assert.equal(
            secondRead,
            "[File already read] The file 'real-file.txt' was already read earlier in this conversation. Returning content:\n2 | beta\n\n(Showing lines 2-2 of 3 total. Use start_line=3 to continue reading.)",
        )
    })
})

import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { TaskActivityStore } from "@core/task/activity/TaskActivityStore"
import { DlineRuntimeFileManager } from "@services/runtime-files"
import { EventEmitter } from "events"
import { describe, it, vi } from "vitest"
import { Logger } from "@/shared/services/Logger"
import { CommandExecutor } from "../CommandExecutor"
import { StandaloneTerminalManager } from "../standalone/StandaloneTerminalManager"
import type {
	BackgroundCommand,
	CommandExecutorCallbacks,
	ITerminalManager,
	TerminalCompletionDetails,
	TerminalInfo,
	TerminalManagerConfiguration,
	TerminalProcessEvents,
	TerminalProcessResultPromise,
} from "../types"

const terminalConfiguration: TerminalManagerConfiguration = {
	shellIntegrationTimeout: 4000,
	terminalReuseEnabled: true,
	terminalOutputLineLimit: 500,
	defaultTerminalProfile: "default",
}

class FakeTerminalProcess extends EventEmitter<TerminalProcessEvents> {
	isHot = false
	waitForShellIntegration = false
	readonly terminate = vi.fn()
	private readonly resultPromise: Promise<void>
	private resolveResult!: () => void
	private rejectResult!: (error: Error) => void

	constructor() {
		super()
		this.resultPromise = new Promise<void>((resolve, reject) => {
			this.resolveResult = resolve
			this.rejectResult = reject
		})
	}

	continue(): void {
		this.emit("continue")
		this.resolveResult()
	}

	getUnretrievedOutput(): string {
		return ""
	}

	getCompletionDetails(): TerminalCompletionDetails {
		return {}
	}

	complete(details: TerminalCompletionDetails): void {
		this.emit("completed", details)
	}

	fail(error: Error): void {
		this.emit("error", error)
		this.rejectResult(error)
	}

	asResultPromise(): TerminalProcessResultPromise {
		const process = this as unknown as FakeTerminalProcess & Partial<TerminalProcessResultPromise>
		process.then = this.resultPromise.then.bind(this.resultPromise)
		process.catch = this.resultPromise.catch.bind(this.resultPromise)
		process.finally = this.resultPromise.finally.bind(this.resultPromise)
		return process as TerminalProcessResultPromise
	}
}

function createTerminalManager(outputLineLimit = terminalConfiguration.terminalOutputLineLimit): ITerminalManager {
	return {
		configure: vi.fn(() => ({ closedCount: 0, busyTerminals: [] })),
		disposeAll: vi.fn(),
		getConfiguration: vi.fn(() => ({ ...terminalConfiguration, terminalOutputLineLimit: outputLineLimit })),
		getOrCreateTerminal: vi.fn(),
		ensureWarm: vi.fn(async () => undefined),
		getTerminals: vi.fn(() => []),
		getUnretrievedOutput: vi.fn(() => ""),
		isProcessHot: vi.fn(() => false),
		processOutput: vi.fn((lines: string[]) => lines.join("\n")),
		runCommand: vi.fn(),
	}
}

function createCallbacks(): CommandExecutorCallbacks {
	return {
		addToUserMessageContent: vi.fn(),
		ask: vi.fn(async () => ({ response: "messageResponse" })),
		getClineMessages: () => [],
		say: vi.fn(async () => undefined),
		updateBackgroundCommandState: vi.fn(),
		updateClineMessage: vi.fn(async () => undefined),
	}
}

/**
 * Wire the activity callbacks to a real store.
 *
 * A mock pair records calls in whatever order they arrive, which cannot tell a
 * correct sequence from one where the update was dropped: `create` throws on a
 * duplicate id and `update` silently discards an unknown one, and only the real
 * store reproduces both. Returning it lets a test assert the status the panel
 * would actually show.
 */
function createActivityCallbacks(taskId = "task-1"): {
	store: TaskActivityStore
	callbacks: Pick<CommandExecutorCallbacks, "createCommandActivity" | "updateCommandActivity">
} {
	const store = new TaskActivityStore(taskId)
	return {
		store,
		callbacks: {
			createCommandActivity: ({ activityId, command, timeoutSeconds, executionMode, cancellationOwner, cancel }) => {
				store.create({
					activityId,
					kind: "command",
					title: command,
					executionMode,
					cancellationOwner,
					timeoutSeconds,
					cancel,
				})
			},
			updateCommandActivity: (activityId, patch) => {
				store.update(activityId, patch)
			},
		},
	}
}

describe("CommandExecutor explicit background execution", () => {
	it("initializes a persistent terminal separately and wraps every user command with preCommands and postCommand", async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), "dline-command-environment-"))
		const platform = process.platform
		const profile = platform === "win32" ? "powershell-legacy" : "bash"
		const configuredTerminal = { ...terminalConfiguration, defaultTerminalProfile: profile }
		const processResult = new FakeTerminalProcess()
		const terminalInfo: TerminalInfo = {
			id: 1,
			terminal: {
				dispose: vi.fn(),
				hide: vi.fn(),
				name: "Configured terminal",
				processId: Promise.resolve(1),
				sendText: vi.fn(),
				show: vi.fn(),
			},
			busy: false,
			lastActive: Date.now(),
			lastCommand: "",
		}
		try {
			await mkdir(path.join(workspace, ".agents"), { recursive: true })
			const startupScript = platform === "win32" ? "setup.ps1" : "setup.sh"
			await writeFile(
				path.join(workspace, ".agents", "bashrc.yml"),
				`version: 1\nplatforms:\n  ${platform}:\n    profiles:\n      ${profile}:\n        environment:\n          DLINE_TEST_ENV: configured\n        startupScripts:\n          - ./${startupScript}\n        preCommands:\n          - Initialize-DlineShell\n        postCommand: Finalize-DlineShell\n`,
				"utf8",
			)
			const terminalManager = createTerminalManager()
			vi.mocked(terminalManager.getOrCreateTerminal).mockResolvedValue(terminalInfo)
			vi.mocked(terminalManager.runCommand).mockReturnValue(processResult.asResultPromise())
			const executor = new CommandExecutor(
				{
					cwd: workspace,
					workspaceRoots: [workspace],
					taskId: "task-environment",
					terminalExecutionMode: "vscodeTerminal",
					terminalManager,
					terminalConfiguration: configuredTerminal,
					ulid: "task-environment-ulid",
				},
				createCallbacks(),
			)

			const execution = executor.execute("Run-Configured-Command", 30, { synchronous: true, workdirectory: workspace })
			await vi.waitFor(() => assert.equal(vi.mocked(terminalManager.runCommand).mock.calls.length, 1))
			processResult.complete({ exitCode: 0, signal: null })
			processResult.continue()
			await execution

			const launchConfiguration = vi.mocked(terminalManager.getOrCreateTerminal).mock.calls[0]?.[1]
			assert.equal(launchConfiguration?.environment?.DLINE_TEST_ENV, "configured")
			assert.equal(typeof launchConfiguration?.configurationId, "string")
			assert.match(launchConfiguration?.initializationCommand ?? "", new RegExp(startupScript.replace(".", "\\.")))
			assert.equal(typeof launchConfiguration?.initializationDiagnosticsPath, "string")
			const wrappedCommand = vi.mocked(terminalManager.runCommand).mock.calls[0]?.[1] ?? ""
			assert.match(wrappedCommand, /Initialize-DlineShell/)
			assert.match(wrappedCommand, /Run-Configured-Command/)
			assert.match(wrappedCommand, /Finalize-DlineShell/)
			assert.doesNotMatch(wrappedCommand, new RegExp(startupScript.replace(".", "\\.")))
			assert.equal(terminalInfo.lastCommand, "Run-Configured-Command")
		} finally {
			await rm(workspace, { recursive: true, force: true })
		}
	})

	it("logs an invalid bashrc.yml and executes the original command without project configuration", async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), "dline-command-invalid-environment-"))
		const processResult = new FakeTerminalProcess()
		const terminalInfo: TerminalInfo = {
			id: 1,
			terminal: {
				dispose: vi.fn(),
				hide: vi.fn(),
				name: "Unconfigured terminal",
				processId: Promise.resolve(1),
				sendText: vi.fn(),
				show: vi.fn(),
			},
			busy: false,
			lastActive: Date.now(),
			lastCommand: "",
		}
		try {
			await mkdir(path.join(workspace, ".agents"), { recursive: true })
			await writeFile(
				path.join(workspace, ".agents", "bashrc.yml"),
				"version: 1\nplatforms:\n  win32:\n    profiles:\n      default:\n        commands:\n          - legacy-command\n",
				"utf8",
			)
			const logger = vi.spyOn(Logger, "error").mockImplementation(() => undefined)
			const terminalManager = createTerminalManager()
			vi.mocked(terminalManager.getOrCreateTerminal).mockResolvedValue(terminalInfo)
			vi.mocked(terminalManager.runCommand).mockReturnValue(processResult.asResultPromise())
			const executor = new CommandExecutor(
				{
					cwd: workspace,
					workspaceRoots: [workspace],
					taskId: "task-invalid-environment",
					terminalExecutionMode: "vscodeTerminal",
					terminalManager,
					terminalConfiguration,
					ulid: "task-invalid-environment-ulid",
				},
				createCallbacks(),
			)

			const execution = executor.execute("Run-Original-Command", 30, { synchronous: true })
			await vi.waitFor(() => assert.equal(vi.mocked(terminalManager.runCommand).mock.calls.length, 1))
			processResult.complete({ exitCode: 0, signal: null })
			processResult.continue()
			await execution

			assert.equal(vi.mocked(terminalManager.getOrCreateTerminal).mock.calls[0]?.[1], undefined)
			assert.equal(vi.mocked(terminalManager.runCommand).mock.calls[0]?.[1], "Run-Original-Command")
			assert.ok(
				logger.mock.calls.some(([message]) => String(message).includes("continuing without it")),
				"invalid configuration should be reported only through the extension logger",
			)
		} finally {
			vi.restoreAllMocks()
			await rm(workspace, { recursive: true, force: true })
		}
	})

	it("defers prewarming until terminal configuration changes after construction", async () => {
		const firstRoot = path.resolve("C:\\workspace-a")
		const secondRoot = path.resolve("C:\\workspace-b")
		const primaryManager = createTerminalManager()
		const executor = new CommandExecutor(
			{
				cwd: firstRoot,
				workspaceRoots: [firstRoot, secondRoot],
				taskId: "task-prewarm",
				terminalExecutionMode: "vscodeTerminal",
				terminalManager: primaryManager,
				terminalConfiguration,
				ulid: "task-prewarm-ulid",
			},
			createCallbacks(),
		)

		await new Promise((resolve) => setTimeout(resolve, 50))
		assert.equal(vi.mocked(primaryManager.ensureWarm!).mock.calls.length, 0)

		executor.configure(terminalConfiguration)
		await vi.waitFor(() => assert.equal(vi.mocked(primaryManager.ensureWarm!).mock.calls.length, 2))
		for (const [cwd, launchConfiguration] of vi.mocked(primaryManager.ensureWarm!).mock.calls) {
			assert.equal(launchConfiguration?.workspaceRoot, cwd)
			assert.equal(launchConfiguration?.profileId, "default")
			assert.equal(launchConfiguration?.environmentFingerprint, "default")
		}
	})

	it("applies one configuration to both primary and background terminal managers", () => {
		const primaryManager = createTerminalManager()
		const standaloneConfigure = vi.spyOn(StandaloneTerminalManager.prototype, "configure")
		try {
			new CommandExecutor(
				{
					cwd: "C:\\workspace",
					taskId: "task-1",
					terminalExecutionMode: "vscodeTerminal",
					terminalManager: primaryManager,
					terminalConfiguration,
					ulid: "task-ulid",
				},
				createCallbacks(),
			)

			assert.deepEqual(vi.mocked(primaryManager.configure).mock.calls, [[terminalConfiguration]])
			assert.deepEqual(standaloneConfigure.mock.calls, [[terminalConfiguration]])
		} finally {
			standaloneConfigure.mockRestore()
		}
	})

	it("prewarms the replacement partition after configuration changes and manual reinitialization", async () => {
		const workspace = path.resolve("C:\\workspace")
		const primaryManager = createTerminalManager()
		primaryManager.reinitializeTerminals = vi.fn(() => ({ closedCount: 3, busyTerminals: [] }))
		const executor = new CommandExecutor(
			{
				cwd: workspace,
				workspaceRoots: [workspace],
				taskId: "task-rewarm",
				terminalExecutionMode: "vscodeTerminal",
				terminalManager: primaryManager,
				terminalConfiguration,
				ulid: "task-rewarm-ulid",
			},
			createCallbacks(),
		)
		assert.equal(vi.mocked(primaryManager.ensureWarm!).mock.calls.length, 0)

		executor.configure({ ...terminalConfiguration, defaultTerminalProfile: "powershell" })
		await vi.waitFor(() => assert.equal(vi.mocked(primaryManager.ensureWarm!).mock.calls.length, 1))
		assert.equal(vi.mocked(primaryManager.ensureWarm!).mock.calls[0]?.[1]?.profileId, "powershell")

		executor.reinitializeTerminals()
		await vi.waitFor(() => assert.equal(vi.mocked(primaryManager.ensureWarm!).mock.calls.length, 2))
	})

	it("reinitializes every owned terminal manager without forcing busy terminals closed", () => {
		const primaryManager = createTerminalManager()
		primaryManager.reinitializeTerminals = vi.fn(() => ({
			closedCount: 2,
			busyTerminals: [],
		}))
		const standaloneReinitialize = vi.spyOn(StandaloneTerminalManager.prototype, "reinitializeTerminals").mockReturnValue({
			closedCount: 1,
			busyTerminals: [],
		})
		try {
			const executor = new CommandExecutor(
				{
					cwd: "C:\\workspace",
					taskId: "task-reinitialize",
					terminalExecutionMode: "vscodeTerminal",
					terminalManager: primaryManager,
					terminalConfiguration,
					ulid: "task-reinitialize-ulid",
				},
				createCallbacks(),
			)

			assert.deepEqual(executor.reinitializeTerminals(), { closedCount: 3, busyTerminals: [] })
			assert.equal(vi.mocked(primaryManager.reinitializeTerminals).mock.calls.length, 1)
			assert.equal(standaloneReinitialize.mock.calls.length, 1)
		} finally {
			standaloneReinitialize.mockRestore()
		}
	})

	it.each<readonly [string, TerminalCompletionDetails, "completed" | "failed"]>([
		["explicit zero exit", { exitCode: 0, signal: null }, "completed"],
		["unknown exit code", { exitCode: undefined, signal: null }, "failed"],
	])("routes through a hidden standalone terminal for %s", async (_caseName, completionDetails, expectedStatus) => {
		const process = new FakeTerminalProcess()
		const processPromise = process.asResultPromise()
		const hide = vi.fn()
		const show = vi.fn()
		const terminalInfo: TerminalInfo = {
			id: 1,
			terminal: {
				dispose: vi.fn(),
				hide,
				name: "Background terminal",
				processId: Promise.resolve(1),
				sendText: vi.fn(),
				show,
			},
			busy: false,
			lastActive: Date.now(),
			lastCommand: "",
		}
		const messages: Array<{
			ask: string
			commandStatus: "pending" | "running" | "completed" | "failed"
			logPath?: string
			text: string
			ts: number
		}> = [{ ask: "command", commandStatus: "pending", text: "serve", ts: 101 }]
		const createCommandActivity = vi.fn()
		const updateCommandActivity = vi.fn()
		const callbacks: CommandExecutorCallbacks = {
			addToUserMessageContent: vi.fn(),
			ask: vi.fn(async () => ({ response: "messageResponse" })),
			createCommandActivity,
			getClineMessages: () => messages,
			say: vi.fn(async () => undefined),
			updateBackgroundCommandState: vi.fn(),
			updateClineMessage: vi.fn(async (index, patch) => {
				Object.assign(messages[index], patch)
			}),
			updateCommandActivity,
		}
		const primaryManager = createTerminalManager()
		const executor = new CommandExecutor(
			{
				cwd: "C:\\workspace",
				taskId: "task-1",
				terminalExecutionMode: "vscodeTerminal",
				terminalManager: primaryManager,
				terminalConfiguration,
				ulid: "task-ulid",
			},
			callbacks,
		)
		const standaloneManager = (executor as unknown as { standaloneManager: StandaloneTerminalManager }).standaloneManager
		const getOrCreateTerminal = vi.spyOn(standaloneManager, "getOrCreateTerminal").mockResolvedValue(terminalInfo)
		const runCommand = vi.spyOn(standaloneManager, "runCommand").mockReturnValue(processPromise)
		const backgroundCommand: BackgroundCommand = {
			command: "serve",
			id: "command_101_1",
			origin: "explicit_background",
			cancellationOwner: "explicit",
			injectionState: "pending",
			lineCount: 0,
			logFilePath: "C:\\Temp\\command_101_1.log",
			process: processPromise,
			startTime: Date.now(),
			status: "running",
		}
		const trackBackgroundCommand = vi.spyOn(standaloneManager, "trackBackgroundCommand").mockReturnValue(backgroundCommand)

		const result = await executor.execute("serve", 30, {
			commandTs: 101,
			startInBackground: true,
			workdirectory: "C:\\workspace\\service",
		})

		assert.equal(vi.mocked(primaryManager.getOrCreateTerminal).mock.calls.length, 0)
		assert.equal(getOrCreateTerminal.mock.calls.length, 1)
		assert.equal(getOrCreateTerminal.mock.calls[0]?.[0], "C:\\workspace\\service")
		assert.equal(runCommand.mock.calls.length, 1)
		assert.equal(hide.mock.calls.length, 1)
		assert.equal(show.mock.calls.length, 0)
		assert.equal(trackBackgroundCommand.mock.calls.length, 1)
		assert.equal(trackBackgroundCommand.mock.calls[0]?.[2], "command_101_1")
		const ownership = trackBackgroundCommand.mock.calls[0]?.[4]
		assert.deepEqual(
			{ origin: ownership?.origin, cancellationOwner: ownership?.cancellationOwner },
			{
				origin: "explicit_background",
				cancellationOwner: "explicit",
			},
		)
		assert.equal(typeof ownership?.startedAt, "number")
		assert.equal(typeof ownership?.deadlineAt, "number")
		assert.equal(result.completed, false)
		assert.equal(result.backgroundCommandId, "command_101_1")
		assert.equal(result.logFilePath, "C:\\Temp\\command_101_1.log")
		assert.equal(messages[0].logPath, "C:\\Temp\\command_101_1.log")
		assert.equal(createCommandActivity.mock.calls[0]?.[0].executionMode, "background")
		assert.equal(createCommandActivity.mock.calls[0]?.[0].timeoutSeconds, 30)
		assert.ok(
			updateCommandActivity.mock.calls.some(
				([, patch]) => patch.executionMode === "background" && patch.logPath === "C:\\Temp\\command_101_1.log",
			),
		)

		process.complete(completionDetails)
		await vi.waitFor(() => {
			assert.ok(updateCommandActivity.mock.calls.some(([, patch]) => patch.status === expectedStatus))
		})
	})

	it("updates the command message when foreground execution automatically moves to the background", async () => {
		vi.useFakeTimers()
		const process = new FakeTerminalProcess()
		const processPromise = process.asResultPromise()
		const terminalInfo: TerminalInfo = {
			id: 1,
			terminal: {
				dispose: vi.fn(),
				hide: vi.fn(),
				name: "Foreground terminal",
				processId: Promise.resolve(1),
				sendText: vi.fn(),
				show: vi.fn(),
			},
			busy: false,
			lastActive: Date.now(),
			lastCommand: "",
		}
		const messages: Array<Record<string, unknown>> = [{ ask: "command", text: "watch", ts: 202 }]
		const callbacks: CommandExecutorCallbacks = {
			addToUserMessageContent: vi.fn(),
			ask: vi.fn(async () => ({ response: "messageResponse" })),
			getClineMessages: () => messages,
			say: vi.fn(async () => undefined),
			updateBackgroundCommandState: vi.fn(),
			updateClineMessage: vi.fn(async (index, patch) => {
				Object.assign(messages[index], patch)
			}),
		}
		const terminalManager = createTerminalManager()
		vi.mocked(terminalManager.getOrCreateTerminal).mockResolvedValue(terminalInfo)
		vi.mocked(terminalManager.runCommand).mockReturnValue(processPromise)
		const executor = new CommandExecutor(
			{
				cwd: "C:\\workspace",
				taskId: "task-foreground-handoff",
				terminalExecutionMode: "vscodeTerminal",
				terminalManager,
				terminalConfiguration,
				ulid: "task-foreground-handoff-ulid",
			},
			callbacks,
		)
		const standaloneManager = (executor as unknown as { standaloneManager: StandaloneTerminalManager }).standaloneManager
		const backgroundCommand: BackgroundCommand = {
			command: "watch",
			id: "command_202_1",
			origin: "foreground",
			cancellationOwner: "task",
			lineCount: 0,
			logFilePath: "C:\\Temp\\command_202_1.log",
			process: processPromise,
			startTime: Date.now(),
			status: "running",
		}
		vi.spyOn(standaloneManager, "trackBackgroundCommand").mockReturnValue(backgroundCommand)

		try {
			const execution = executor.execute("watch", 30, { commandTs: 202 })
			await vi.waitFor(() => assert.equal(messages[0].commandExecutionMode, "foreground"))

			await vi.advanceTimersByTimeAsync(10_000)
			const result = await execution

			assert.equal(result.backgroundCommandId, "command_202_1")
			assert.equal(messages[0].commandExecutionMode, "background")
		} finally {
			process.complete({ exitCode: 0, signal: null })
			vi.useRealTimers()
		}
	})

	it("keeps explicit background work alive during Task cancellation and cancels it only explicitly", async () => {
		const process = new FakeTerminalProcess()
		const processPromise = process.asResultPromise()
		const executor = new CommandExecutor(
			{
				cwd: "C:\\workspace",
				taskId: "task-1",
				terminalExecutionMode: "vscodeTerminal",
				terminalManager: createTerminalManager(),
				terminalConfiguration,
				ulid: "task-ulid",
			},
			createCallbacks(),
		)
		const internals = executor as unknown as {
			currentProcess: TerminalProcessResultPromise | null
			processes: Map<string, TerminalProcessResultPromise>
			cancellationOwners: Map<string, "explicit" | "task">
		}
		internals.currentProcess = processPromise
		internals.processes.set("explicit-1", processPromise)
		internals.cancellationOwners.set("explicit-1", "explicit")

		assert.equal(executor.hasTaskOwnedCommand(), false)
		assert.equal(await executor.cancelTaskOwnedCommands(), false)
		assert.equal(process.terminate.mock.calls.length, 0)
		assert.equal(await executor.cancelBackgroundCommand(), true)
		assert.equal(process.terminate.mock.calls.length, 1)
	})

	it("terminates task-owned detached foreground work exactly once and waits for process exit", async () => {
		const process = new FakeTerminalProcess()
		let resolveTermination: (() => void) | undefined
		process.terminate.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resolveTermination = resolve
				}),
		)
		const processPromise = process.asResultPromise()
		const executor = new CommandExecutor(
			{
				cwd: "C:\\workspace",
				taskId: "task-1",
				terminalExecutionMode: "vscodeTerminal",
				terminalManager: createTerminalManager(),
				terminalConfiguration,
				ulid: "task-ulid",
			},
			createCallbacks(),
		)
		const standalone = (executor as unknown as { standaloneManager: StandaloneTerminalManager }).standaloneManager
		const command: BackgroundCommand = {
			id: "detached-1",
			command: "watch",
			startTime: Date.now(),
			status: "running",
			origin: "foreground",
			cancellationOwner: "task",
			taskId: "task-1",
			logFilePath: "C:\\Temp\\detached-1.log",
			lineCount: 0,
			process: processPromise,
		}
		vi.spyOn(standalone, "getRunningBackgroundCommands").mockImplementation((scope) => {
			// Mirror the real manager: owner and task are both exact filters, so a
			// command only matches a scope that names its own task.
			const { cancellationOwner, taskId } =
				typeof scope === "string" ? { cancellationOwner: scope, taskId: undefined } : (scope ?? {})
			if (command.status !== "running") return []
			if (cancellationOwner && cancellationOwner !== command.cancellationOwner) return []
			if (taskId && taskId !== command.taskId) return []
			return [command]
		})
		vi.spyOn(standalone, "cancelBackgroundCommand").mockImplementation(async () => {
			if (command.status !== "running") return false
			command.status = "cancelled"
			await process.terminate()
			return true
		})
		const internals = executor as unknown as {
			currentProcess: TerminalProcessResultPromise | null
			processes: Map<string, TerminalProcessResultPromise>
			cancellationOwners: Map<string, "explicit" | "task">
		}
		internals.currentProcess = processPromise
		internals.processes.set(command.id, processPromise)
		internals.cancellationOwners.set(command.id, "task")

		assert.equal(executor.hasTaskOwnedCommand(), true)
		let cancellationSettled = false
		const cancellation = executor.cancelTaskOwnedCommands().then((result) => {
			cancellationSettled = true
			return result
		})
		await vi.waitFor(() => assert.equal(process.terminate.mock.calls.length, 1))
		assert.equal(command.status, "cancelled")
		assert.equal(cancellationSettled, false)

		resolveTermination?.()
		assert.equal(await cancellation, true)
		assert.equal(cancellationSettled, true)
		assert.equal(await executor.cancelTaskOwnedCommands(), false)
		assert.equal(process.terminate.mock.calls.length, 1)
	})

	it("cancels by canonical function identity and returns the existing log path", async () => {
		const process = new FakeTerminalProcess()
		const processPromise = process.asResultPromise()
		const terminalManager = createTerminalManager(1)
		vi.mocked(terminalManager.getOrCreateTerminal).mockResolvedValue({
			id: 1,
			terminal: {
				dispose: vi.fn(),
				hide: vi.fn(),
				name: "Foreground terminal",
				processId: Promise.resolve(1),
				sendText: vi.fn(),
				show: vi.fn(),
			},
			busy: false,
			lastActive: Date.now(),
			lastCommand: "",
		})
		vi.mocked(terminalManager.runCommand).mockReturnValue(processPromise)
		const updateCommandActivity = vi.fn()
		const updateClineMessage = vi.fn(async () => undefined)
		const executor = new CommandExecutor(
			{
				cwd: "C:\\workspace",
				taskId: "task-1",
				terminalExecutionMode: "vscodeTerminal",
				terminalManager,
				terminalConfiguration,
				ulid: "task-ulid",
			},
			{
				...createCallbacks(),
				getClineMessages: () => [{ ask: "command", text: "watch", ts: 77 }],
				updateClineMessage,
				updateCommandActivity,
			},
		)
		const expectedLogPath = DlineRuntimeFileManager.createTempFilePath("command_77_1")

		try {
			const execution = executor.execute("watch", undefined, { commandTs: 77, functionId: "call-watch" })
			await vi.waitFor(() => expect(executor.hasTaskOwnedCommand()).toBe(true))
			process.emit("line", "first line before cancellation", "stdout")
			process.emit("line", "second line before cancellation", "stderr")
			expect(await executor.cancelCommandByFunctionId("call-unknown")).toEqual({ cancelled: false })
			expect(await executor.cancelCommandByFunctionId("call-watch")).toEqual({
				activityId: "command_77_1",
				cancelled: true,
				command: "watch",
			})
			process.emit("error", new Error("terminated"))
			process.continue()
			const result = await execution

			expect(await executor.cancelCommandByFunctionId("call-watch")).toEqual({ cancelled: false })
			expect(process.terminate).toHaveBeenCalledTimes(1)
			expect(updateCommandActivity).toHaveBeenCalledWith("command_77_1", expect.objectContaining({ status: "cancelled" }))
			expect(updateCommandActivity).not.toHaveBeenCalledWith("command_77_1", expect.objectContaining({ status: "failed" }))
			expect(updateClineMessage).not.toHaveBeenCalledWith(0, expect.objectContaining({ commandStatus: "failed" }))
			expect(result.logFilePath).toBe(expectedLogPath)
			expect((result.result as string).split("\n").at(-1)).toBe(`Full output saved to: ${expectedLogPath}`)
		} finally {
			await rm(expectedLogPath, { force: true })
		}
	})

	it("records a terminal status for a command that finishes while the chat row is still being linked", async () => {
		// The command is already running before the activity exists. Linking the
		// chat row to it is asynchronous, and a fast command can finish inside
		// that gap. Completion arrives as an event and is never replayed, so if
		// the terminal-status listeners are installed after the await, the
		// activity is left claiming to run for the rest of the session.
		const process = new FakeTerminalProcess()
		const processPromise = process.asResultPromise()
		const terminalManager = createTerminalManager()
		vi.mocked(terminalManager.getOrCreateTerminal).mockResolvedValue({
			id: 1,
			terminal: {
				dispose: vi.fn(),
				hide: vi.fn(),
				name: "Foreground terminal",
				processId: Promise.resolve(1),
				sendText: vi.fn(),
				show: vi.fn(),
			},
			busy: false,
			lastActive: Date.now(),
			lastCommand: "",
		})
		vi.mocked(terminalManager.runCommand).mockReturnValue(processPromise)

		const activity = createActivityCallbacks()
		// Hold the chat-row update open, and complete the command while it is
		// still pending. This is the production ordering: the update waits on
		// message state and a Webview round trip, either of which can outlast a
		// short command.
		let releaseChatRowUpdate!: () => void
		let signalChatRowUpdateStarted!: () => void
		const chatRowUpdateGate = new Promise<void>((release) => {
			releaseChatRowUpdate = release
		})
		const chatRowUpdateStarted = new Promise<void>((started) => {
			signalChatRowUpdateStarted = started
		})
		const updateClineMessage = vi.fn(async () => {
			signalChatRowUpdateStarted()
			await chatRowUpdateGate
		})

		const executor = new CommandExecutor(
			{
				cwd: "C:\\workspace",
				taskId: "task-1",
				terminalExecutionMode: "vscodeTerminal",
				terminalManager,
				terminalConfiguration,
				ulid: "task-ulid",
			},
			{
				...createCallbacks(),
				getClineMessages: () => [{ ask: "command", text: "fast", ts: 42 }],
				updateClineMessage,
				...activity.callbacks,
			},
		)

		const execution = executor.execute("fast", undefined, { commandTs: 42 })
		await chatRowUpdateStarted

		// The activity has to exist before completion can be recorded against it:
		// the store discards a patch for an unknown id, so an update that raced
		// ahead of creation would vanish rather than fail loudly.
		const [runningActivity] = activity.store.list()
		assert.equal(runningActivity?.status, "running", "the activity must exist while the chat row is still linking")

		process.complete({ exitCode: 0 })
		releaseChatRowUpdate()
		process.continue()
		await execution

		const [finishedActivity] = activity.store.list()
		assert.equal(
			finishedActivity?.status,
			"completed",
			"a command that finished during the chat-row update must still report a terminal status",
		)
	})

	// Skipped pending BUGFIX-069.
	//
	// This documents a confirmed defect rather than a passing contract. The
	// activity records the terminal status, but the chat row and the tool
	// result do not: instrumenting `updateClineMessage` shows only the activity
	// link and the running patch, never the terminal patch from
	// `clearCommandState`.
	//
	// The cause is not the listener order inside `orchestrateCommandExecution`.
	// The orchestrator is called after `CommandExecutor` awaits the chat-row
	// update, so a command that finishes in that window emits `completed`
	// before the orchestrator installs any listener, and moving its listeners
	// earlier was verified not to help. Closing this needs an owned terminal
	// status that both consumers read, which is a larger change than this
	// regression pass and is tracked separately.
	it("reports the same terminal status to the activity, the chat row, and the model", async () => {
		const process = new FakeTerminalProcess()
		const processPromise = process.asResultPromise()
		const terminalManager = createTerminalManager()
		vi.mocked(terminalManager.getOrCreateTerminal).mockResolvedValue({
			id: 1,
			terminal: {
				dispose: vi.fn(),
				hide: vi.fn(),
				name: "Foreground terminal",
				processId: Promise.resolve(1),
				sendText: vi.fn(),
				show: vi.fn(),
			},
			busy: false,
			lastActive: Date.now(),
			lastCommand: "",
		})
		vi.mocked(terminalManager.runCommand).mockReturnValue(processPromise)

		const activity = createActivityCallbacks()
		// Apply the patches instead of only recording them: the chat row's
		// terminal status is the value the user reads, and a recording mock
		// cannot tell an applied status apart from a dropped one.
		const messages: Array<{ ask?: string; text?: string; ts: number; commandStatus?: string; exitCode?: number }> = [
			{ ask: "command", text: "fast", ts: 42, commandStatus: "pending" },
		]
		let releaseChatRowUpdate!: () => void
		let signalChatRowUpdateStarted!: () => void
		const chatRowUpdateGate = new Promise<void>((release) => {
			releaseChatRowUpdate = release
		})
		const chatRowUpdateStarted = new Promise<void>((started) => {
			signalChatRowUpdateStarted = started
		})
		let chatRowLinked = false
		const updateClineMessage = vi.fn(async (index: number, patch: Record<string, unknown>) => {
			// Merge the fields before suspending, mirroring
			// `MessageStateHandler.updateClineMessage`, which delegates to
			// `uiMessage.updateMessage` and merges per field rather than
			// writing back a snapshot captured before the await. Applying the
			// patch after the gate instead would let this mock invent an
			// overwrite that production cannot produce.
			Object.assign(messages[index], patch)
			// Only the activity link is held open, reproducing a chat-row update
			// that outlives a short command. The orchestrator's running patch must
			// remain free to install completion ownership first.
			if (!chatRowLinked && "activityId" in patch) {
				chatRowLinked = true
				signalChatRowUpdateStarted()
				await chatRowUpdateGate
			}
		})

		const executor = new CommandExecutor(
			{
				cwd: "C:\\workspace",
				taskId: "task-1",
				terminalExecutionMode: "vscodeTerminal",
				terminalManager,
				terminalConfiguration,
				ulid: "task-ulid",
			},
			{
				...createCallbacks(),
				getClineMessages: () => messages,
				updateClineMessage,
				...activity.callbacks,
			},
		)

		const execution = executor.execute("fast", undefined, { commandTs: 42 })
		await chatRowUpdateStarted

		process.complete({ exitCode: 0 })
		releaseChatRowUpdate()
		process.continue()
		const result = await execution

		const [finishedActivity] = activity.store.list()
		assert.equal(finishedActivity?.status, "completed", "the activity must record the terminal status")
		assert.equal(messages[0].commandStatus, "completed", "the chat row must record the same terminal status")
		assert.equal(result.completed, true, "the model must be told the command finished, not that it is still running")
	})

	it("records a failure for a command that errors while the chat row is still being linked", async () => {
		// Same window as the completion case. Both terminal listeners were moved,
		// so both need to be held to the same guarantee.
		const process = new FakeTerminalProcess()
		const processPromise = process.asResultPromise()
		const terminalManager = createTerminalManager()
		vi.mocked(terminalManager.getOrCreateTerminal).mockResolvedValue({
			id: 1,
			terminal: {
				dispose: vi.fn(),
				hide: vi.fn(),
				name: "Foreground terminal",
				processId: Promise.resolve(1),
				sendText: vi.fn(),
				show: vi.fn(),
			},
			busy: false,
			lastActive: Date.now(),
			lastCommand: "",
		})
		vi.mocked(terminalManager.runCommand).mockReturnValue(processPromise)

		const activity = createActivityCallbacks()
		let releaseChatRowUpdate!: () => void
		let signalChatRowUpdateStarted!: () => void
		const chatRowUpdateGate = new Promise<void>((release) => {
			releaseChatRowUpdate = release
		})
		const chatRowUpdateStarted = new Promise<void>((started) => {
			signalChatRowUpdateStarted = started
		})
		const updateClineMessage = vi.fn(async () => {
			signalChatRowUpdateStarted()
			await chatRowUpdateGate
		})

		const executor = new CommandExecutor(
			{
				cwd: "C:\\workspace",
				taskId: "task-1",
				terminalExecutionMode: "vscodeTerminal",
				terminalManager,
				terminalConfiguration,
				ulid: "task-ulid",
			},
			{
				...createCallbacks(),
				getClineMessages: () => [{ ask: "command", text: "doomed", ts: 42 }],
				updateClineMessage,
				...activity.callbacks,
			},
		)

		const execution = executor.execute("doomed", undefined, { commandTs: 42 })
		await chatRowUpdateStarted
		process.fail(new Error("shell integration stream failed"))
		releaseChatRowUpdate()
		await execution.catch(() => undefined)

		const [failedActivity] = activity.store.list()
		assert.equal(failedActivity?.status, "failed", "an error during the chat-row update must still be recorded")
	})

	it("cancels a command that is still linking its chat row", async () => {
		// Moving the activity ahead of the chat-row await opened a window where
		// the panel can offer cancellation before that link exists. The maps
		// cancellation depends on are written before the activity, so the request
		// has to reach the process and end as cancelled rather than completed.
		const process = new FakeTerminalProcess()
		const processPromise = process.asResultPromise()
		const terminalManager = createTerminalManager()
		vi.mocked(terminalManager.getOrCreateTerminal).mockResolvedValue({
			id: 1,
			terminal: {
				dispose: vi.fn(),
				hide: vi.fn(),
				name: "Foreground terminal",
				processId: Promise.resolve(1),
				sendText: vi.fn(),
				show: vi.fn(),
			},
			busy: false,
			lastActive: Date.now(),
			lastCommand: "",
		})
		vi.mocked(terminalManager.runCommand).mockReturnValue(processPromise)

		const activity = createActivityCallbacks()
		let releaseChatRowUpdate!: () => void
		let signalChatRowUpdateStarted!: () => void
		const chatRowUpdateGate = new Promise<void>((release) => {
			releaseChatRowUpdate = release
		})
		const chatRowUpdateStarted = new Promise<void>((started) => {
			signalChatRowUpdateStarted = started
		})
		const updateClineMessage = vi.fn(async () => {
			signalChatRowUpdateStarted()
			await chatRowUpdateGate
		})

		const executor = new CommandExecutor(
			{
				cwd: "C:\\workspace",
				taskId: "task-1",
				terminalExecutionMode: "vscodeTerminal",
				terminalManager,
				terminalConfiguration,
				ulid: "task-ulid",
			},
			{
				...createCallbacks(),
				getClineMessages: () => [{ ask: "command", text: "slow", ts: 42 }],
				updateClineMessage,
				...activity.callbacks,
			},
		)

		const execution = executor.execute("slow", undefined, { commandTs: 42 })
		await chatRowUpdateStarted

		const [pending] = activity.store.list()
		assert.ok(pending, "the activity must be cancellable before the chat row is linked")
		const cancellation = activity.store.cancel([pending.activityId])

		releaseChatRowUpdate()
		process.complete({ exitCode: 130 })
		process.continue()
		await cancellation
		await execution

		assert.equal(process.terminate.mock.calls.length > 0, true, "cancellation must reach the running process")
		const [cancelledActivity] = activity.store.list()
		assert.equal(cancelledActivity?.status, "cancelled", "a cancelled command must not be recorded as completed")
	})

	it("clears a ready handoff and preserves cancelled state when a synchronous command rejects during termination", async () => {
		vi.useFakeTimers()
		const process = new FakeTerminalProcess()
		const processPromise = process.asResultPromise()
		const terminalInfo: TerminalInfo = {
			id: 1,
			terminal: {
				dispose: vi.fn(),
				hide: vi.fn(),
				name: "Standalone terminal",
				processId: Promise.resolve(1),
				sendText: vi.fn(),
				show: vi.fn(),
			},
			busy: false,
			lastActive: Date.now(),
			lastCommand: "",
		}
		const messages: Array<Record<string, unknown>> = [{ ask: "command", text: "watch", ts: 88 }]
		const updateCommandActivity = vi.fn()
		const onHandoffAvailabilityChanged = vi.fn()
		const callbacks: CommandExecutorCallbacks = {
			addToUserMessageContent: vi.fn(),
			ask: vi.fn(async () => ({ response: "messageResponse" })),
			getClineMessages: () => messages,
			say: vi.fn(async () => undefined),
			updateBackgroundCommandState: vi.fn(),
			updateClineMessage: vi.fn(async (index, patch) => {
				Object.assign(messages[index], patch)
			}),
			updateCommandActivity,
			onHandoffAvailabilityChanged,
		}
		const executor = new CommandExecutor(
			{
				cwd: "C:\\workspace",
				taskId: "task-cancel-resume",
				terminalExecutionMode: "backgroundExec",
				terminalManager: createTerminalManager(),
				terminalConfiguration,
				ulid: "task-cancel-resume-ulid",
			},
			callbacks,
		)
		const standaloneManager = (executor as unknown as { standaloneManager: StandaloneTerminalManager }).standaloneManager
		vi.spyOn(standaloneManager, "getOrCreateTerminal").mockResolvedValue(terminalInfo)
		vi.spyOn(standaloneManager, "runCommand").mockReturnValue(processPromise)

		const executionOutcome = executor.execute("watch", undefined, { commandTs: 88, synchronous: true }).then(
			(result) => ({ result }),
			(error: unknown) => ({ error }),
		)
		await vi.waitFor(() => assert.equal(vi.mocked(standaloneManager.runCommand).mock.calls.length, 1))
		await vi.advanceTimersByTimeAsync(10_000)
		assert.equal(executor.getReadyBackgroundHandoffActivityId(), "command_88_1")

		const cancellation = executor.cancelTaskOwnedCommands()
		assert.equal(executor.getReadyBackgroundHandoffActivityId(), undefined)
		assert.equal(messages[0].commandStatus, "cancelled")
		process.fail(new Error("terminated"))
		await vi.advanceTimersByTimeAsync(300)
		assert.equal(await cancellation, true)
		const outcome = await executionOutcome
		if (!("result" in outcome)) throw outcome.error
		const { result } = outcome

		assert.equal(result.userRejected, true)
		assert.match(result.result as string, /Command was cancelled by the user/)
		assert.equal(executor.isBackgroundHandoffRequested("command_88_1"), false)
		assert.equal(onHandoffAvailabilityChanged.mock.calls.length, 2)
		assert.ok(
			updateCommandActivity.mock.calls.some(
				([activityId, patch]) =>
					activityId === "command_88_1" &&
					typeof patch === "object" &&
					patch !== null &&
					"status" in patch &&
					patch.status === "cancelled",
			),
		)
		assert.equal(
			updateCommandActivity.mock.calls.some(
				([activityId, patch]) =>
					activityId === "command_88_1" &&
					typeof patch === "object" &&
					patch !== null &&
					"status" in patch &&
					patch.status === "failed",
			),
			false,
		)
	})

	it("cleans command identity and activity state when automatic background tracking fails", async () => {
		vi.useFakeTimers()
		const process = new FakeTerminalProcess()
		const processPromise = process.asResultPromise()
		const terminalInfo: TerminalInfo = {
			id: 1,
			terminal: {
				dispose: vi.fn(),
				hide: vi.fn(),
				name: "Foreground terminal",
				processId: Promise.resolve(1),
				sendText: vi.fn(),
				show: vi.fn(),
			},
			busy: false,
			lastActive: Date.now(),
			lastCommand: "",
		}
		const messages: Array<Record<string, unknown>> = [{ ask: "command", text: "watch", ts: 606 }]
		const updateCommandActivity = vi.fn()
		const callbacks: CommandExecutorCallbacks = {
			addToUserMessageContent: vi.fn(),
			ask: vi.fn(async () => ({ response: "messageResponse" })),
			getClineMessages: () => messages,
			say: vi.fn(async () => undefined),
			updateBackgroundCommandState: vi.fn(),
			updateClineMessage: vi.fn(async (index, patch) => {
				Object.assign(messages[index], patch)
			}),
			updateCommandActivity,
		}
		const terminalManager = createTerminalManager()
		vi.mocked(terminalManager.getOrCreateTerminal).mockResolvedValue(terminalInfo)
		vi.mocked(terminalManager.runCommand).mockReturnValue(processPromise)
		const executor = new CommandExecutor(
			{
				cwd: "C:\\workspace",
				taskId: "task-handoff-failure",
				terminalExecutionMode: "vscodeTerminal",
				terminalManager,
				terminalConfiguration,
				ulid: "task-handoff-failure-ulid",
			},
			callbacks,
		)
		const standaloneManager = (executor as unknown as { standaloneManager: StandaloneTerminalManager }).standaloneManager
		vi.spyOn(standaloneManager, "trackBackgroundCommand").mockImplementation(() => {
			throw new Error("background log unavailable")
		})

		const execution = executor.execute("watch", 60, { commandTs: 606, functionId: "call-handoff-failure" })
		const rejected = assert.rejects(
			execution,
			/Background handoff failed\. Termination was requested to prevent an untracked process/,
		)
		await vi.waitFor(() => assert.equal(vi.mocked(terminalManager.runCommand).mock.calls.length, 1))
		await vi.advanceTimersByTimeAsync(10_000)
		await rejected
		assert.equal(process.terminate.mock.calls.length, 1)
		assert.equal(executor.hasTaskOwnedCommand(), false)
		assert.deepEqual(await executor.cancelCommandByFunctionId("call-handoff-failure"), { cancelled: false })
		assert.equal(executor.getReadyBackgroundHandoffActivityId(), undefined)
		assert.equal(standaloneManager.getAllBackgroundCommands().length, 0)
		assert.equal(messages[0].commandStatus, "failed")
		assert.ok(
			updateCommandActivity.mock.calls.some(
				([activityId, patch]) =>
					activityId === "command_606_1" &&
					typeof patch === "object" &&
					patch !== null &&
					"status" in patch &&
					patch.status === "failed",
			),
		)
	})

	it("publishes footer handoff readiness after the wait and moves the synchronous command on request", async () => {
		vi.useFakeTimers()
		const process = new FakeTerminalProcess()
		const processPromise = process.asResultPromise()
		const terminalInfo: TerminalInfo = {
			id: 1,
			terminal: {
				dispose: vi.fn(),
				hide: vi.fn(),
				name: "Standalone terminal",
				processId: Promise.resolve(1),
				sendText: vi.fn(),
				show: vi.fn(),
			},
			busy: false,
			lastActive: Date.now(),
			lastCommand: "",
		}
		const messages: Array<Record<string, unknown>> = [{ ask: "command", text: "watch", ts: 505 }]
		const updateCommandActivity = vi.fn()
		const onHandoffAvailabilityChanged = vi.fn()
		const callbacks: CommandExecutorCallbacks = {
			addToUserMessageContent: vi.fn(),
			ask: vi.fn(async () => ({ response: "messageResponse" })),
			getClineMessages: () => messages,
			say: vi.fn(async () => undefined),
			updateBackgroundCommandState: vi.fn(),
			updateClineMessage: vi.fn(async (index, patch) => {
				Object.assign(messages[index], patch)
			}),
			updateCommandActivity,
			onHandoffAvailabilityChanged,
		}
		const executor = new CommandExecutor(
			{
				cwd: "C:\\workspace",
				taskId: "task-manual-handoff",
				terminalExecutionMode: "backgroundExec",
				terminalManager: createTerminalManager(),
				terminalConfiguration,
				ulid: "task-manual-handoff-ulid",
			},
			callbacks,
		)
		const standaloneManager = (executor as unknown as { standaloneManager: StandaloneTerminalManager }).standaloneManager
		vi.spyOn(standaloneManager, "getOrCreateTerminal").mockResolvedValue(terminalInfo)
		vi.spyOn(standaloneManager, "runCommand").mockReturnValue(processPromise)

		try {
			const execution = executor.execute("watch", undefined, { commandTs: 505, synchronous: true })
			await vi.waitFor(() => assert.equal(vi.mocked(standaloneManager.runCommand).mock.calls.length, 1))
			assert.equal(executor.getReadyBackgroundHandoffActivityId(), undefined)
			await vi.advanceTimersByTimeAsync(10_000)
			assert.equal(executor.getReadyBackgroundHandoffActivityId(), "command_505_1")
			assert.equal(executor.isBackgroundHandoffRequested("command_505_1"), false)
			assert.equal(onHandoffAvailabilityChanged.mock.calls.length, 1)

			assert.equal(await executor.requestBackgroundHandoff("command_505_1"), true)
			assert.equal(executor.getReadyBackgroundHandoffActivityId(), "command_505_1")
			assert.equal(executor.isBackgroundHandoffRequested("command_505_1"), true)
			assert.equal(onHandoffAvailabilityChanged.mock.calls.length, 2)
			assert.equal(await executor.requestBackgroundHandoff("command_505_1"), false)
			const result = await execution
			assert.equal(executor.getReadyBackgroundHandoffActivityId(), undefined)
			assert.equal(executor.isBackgroundHandoffRequested("command_505_1"), false)
			assert.equal(onHandoffAvailabilityChanged.mock.calls.length, 3)
			assert.equal(result.completed, false)
			assert.match(result.result as string, /Command is running in the background/i)
			assert.equal(standaloneManager.getBackgroundCommand("command_505_1")?.cancellationOwner, "explicit")
			assert.equal(executor.hasTaskOwnedCommand(), false)
			assert.equal(await executor.cancelTaskOwnedCommands(), false)
			assert.equal(process.terminate.mock.calls.length, 0)
			assert.equal(
				updateCommandActivity.mock.calls.some(
					([activityId, patch]) =>
						activityId === "command_505_1" &&
						typeof patch === "object" &&
						patch !== null &&
						"cancellationOwner" in patch &&
						patch.cancellationOwner === "explicit",
				),
				true,
			)
		} finally {
			process.complete({ exitCode: 0, signal: null })
			process.continue()
		}
	})

	it("marks a synchronous command as foreground even under the global backgroundExec mode", async () => {
		const process = new FakeTerminalProcess()
		const processPromise = process.asResultPromise()
		const show = vi.fn()
		const terminalInfo: TerminalInfo = {
			id: 1,
			terminal: {
				dispose: vi.fn(),
				hide: vi.fn(),
				name: "Standalone terminal",
				processId: Promise.resolve(1),
				sendText: vi.fn(),
				show,
			},
			busy: false,
			lastActive: Date.now(),
			lastCommand: "",
		}
		const messages: Array<Record<string, unknown>> = [{ ask: "command", text: "watch", ts: 303 }]
		const createCommandActivity = vi.fn()
		const callbacks: CommandExecutorCallbacks = {
			addToUserMessageContent: vi.fn(),
			ask: vi.fn(async () => ({ response: "messageResponse" })),
			createCommandActivity,
			getClineMessages: () => messages,
			say: vi.fn(async () => undefined),
			updateBackgroundCommandState: vi.fn(),
			updateClineMessage: vi.fn(async (index, patch) => {
				Object.assign(messages[index], patch)
			}),
		}
		const primaryManager = createTerminalManager()
		const executor = new CommandExecutor(
			{
				cwd: "C:\\workspace",
				taskId: "task-background-exec-synchronous",
				terminalExecutionMode: "backgroundExec",
				terminalManager: primaryManager,
				terminalConfiguration,
				ulid: "task-background-exec-synchronous-ulid",
			},
			callbacks,
		)
		const standaloneManager = (executor as unknown as { standaloneManager: StandaloneTerminalManager }).standaloneManager
		vi.spyOn(standaloneManager, "getOrCreateTerminal").mockResolvedValue(terminalInfo)
		vi.spyOn(standaloneManager, "runCommand").mockReturnValue(processPromise)

		// The synchronous option keeps the command in the foreground loop, so the
		// mode marker must stay "foreground" even when the global terminal mode
		// routes execution through the standalone manager.
		const execution = executor.execute("watch", 30, { commandTs: 303, synchronous: true })
		try {
			await vi.waitFor(() => assert.equal(createCommandActivity.mock.calls.length, 1))
			assert.equal(createCommandActivity.mock.calls[0]?.[0].executionMode, "foreground")
			assert.equal(messages[0].commandExecutionMode, "foreground")
			assert.equal(vi.mocked(primaryManager.getOrCreateTerminal).mock.calls.length, 0)
			assert.equal(show.mock.calls.length, 1)
		} finally {
			process.complete({ exitCode: 0, signal: null })
			process.continue()
			await execution
		}
	})
})

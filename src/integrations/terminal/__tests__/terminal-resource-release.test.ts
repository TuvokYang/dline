import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { afterEach, describe, it, vi } from "vitest"
import { CommandExecutor } from "../CommandExecutor"
import { StandaloneTerminalManager } from "../standalone/StandaloneTerminalManager"
import { StandaloneTerminalProcess } from "../standalone/StandaloneTerminalProcess"
import type {
	CommandExecutorCallbacks,
	ITerminal,
	ITerminalManager,
	TerminalManagerConfiguration,
	TerminalProcessResultPromise,
} from "../types"

/**
 * Regression coverage for BUGFIX-073.
 *
 * A finished command used to keep its child process, its pipes and its captured
 * output reachable for the whole task, which is what made the extension host
 * accumulate thousands of handles over a long session.
 *
 * The process cases drive the real `run()` wiring through a stubbed spawn so the
 * assertions cover the production listeners rather than a re-implementation of
 * them in the test.
 */

const spawnedChildren: ChildStub[] = []

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>()
	return {
		...actual,
		spawn: () => {
			const child = createChildProcessStub()
			spawnedChildren.push(child)
			return child
		},
	}
})

type ProcessInternals = {
	childProcess: unknown
	isHot: boolean
	hotTimer: NodeJS.Timeout | null
}

type ChildStub = EventEmitter & {
	stdout: EventEmitter
	stderr: EventEmitter
	pid: number
	stdin: { write(): void; end(): void }
	kill(): void
}

/** A child process stub exposing only what run() and the release path touch. */
function createChildProcessStub(): ChildStub {
	const child = new EventEmitter() as ChildStub
	child.stdout = new EventEmitter()
	child.stderr = new EventEmitter()
	child.pid = 4242
	child.stdin = { write: () => {}, end: () => {} }
	child.kill = () => {}
	return child
}

/** A terminal whose shell and cwd are enough for run() to reach spawn. */
function createTerminal(): ITerminal & { _process?: unknown } {
	return {
		shellPath: "pwsh",
		cwd: process.cwd(),
	} as unknown as ITerminal & { _process?: unknown }
}

/** Start one command and hand back the stubbed child that run() spawned. */
function startCommand(terminal: ITerminal) {
	const terminalProcess = new StandaloneTerminalProcess()
	const internals = terminalProcess as unknown as ProcessInternals
	// Failures are asserted through emitted events, so an unhandled rejection
	// must not fail the run before the assertions execute.
	const running = terminalProcess.run(terminal, "echo hi").catch(() => {})
	const child = spawnedChildren[spawnedChildren.length - 1]
	return { terminalProcess, internals, child, running }
}

describe("StandaloneTerminalProcess resource release", () => {
	afterEach(() => {
		spawnedChildren.length = 0
		vi.useRealTimers()
	})

	it("drops child process listeners and references once the command exits", async () => {
		const terminal = createTerminal()
		const { terminalProcess, internals, child, running } = startCommand(terminal)
		terminal._process = child
		terminalProcess.on("completed", () => {})
		terminalProcess.on("continue", () => {})

		child.emit("close", 0)
		await running

		assert.equal(child.stdout.listenerCount("data"), 0)
		assert.equal(child.stderr.listenerCount("data"), 0)
		assert.equal(child.listenerCount("close"), 0)
		assert.equal(internals.childProcess, null)
		assert.equal(terminal._process, null)
	})

	it("emits trailing output and completion before releasing the child", async () => {
		const terminal = createTerminal()
		const { terminalProcess, child, running } = startCommand(terminal)
		const events: string[] = []
		terminalProcess.on("line", (line: string) => events.push(`line:${line}`))
		terminalProcess.on("completed", () => events.push("completed"))
		terminalProcess.on("continue", () => events.push("continue"))

		// A final chunk without a trailing newline only reaches the consumer if the
		// buffers are flushed before the listeners are removed.
		child.stdout.emit("data", Buffer.from("tail"))
		child.emit("close", 0)
		await running

		// run() also emits its own command echo, so only the tail of the sequence
		// is asserted: the trailing chunk must still arrive, and it must arrive
		// before the terminal events that precede the release.
		assert.deepEqual(events.slice(-3), ["line:tail", "completed", "continue"])
	})

	it("clears the hot window when the process reports a spawn failure", async () => {
		const terminal = createTerminal()
		const { terminalProcess, internals, child, running } = startCommand(terminal)
		terminalProcess.on("error", () => {})
		internals.isHot = true
		internals.hotTimer = setTimeout(() => {}, 60_000)

		child.emit("error", new Error("spawn failed"))
		await running

		assert.equal(internals.hotTimer, null)
		assert.equal(internals.isHot, false)
	})

	it("clears the hot window when a running command is terminated", async () => {
		const terminal = createTerminal()
		const { terminalProcess, internals, child, running } = startCommand(terminal)
		terminalProcess.on("error", () => {})
		internals.isHot = true
		internals.hotTimer = setTimeout(() => {}, 60_000)

		// Killing the process tree needs a platform provider this stub has no way
		// to supply, so the outcome of the kill is irrelevant here: what matters is
		// that the hot window is already released before that work begins, instead
		// of keeping this object alive until the timer fires.
		await terminalProcess.terminate().catch(() => {})

		assert.equal(internals.hotTimer, null)
		assert.equal(internals.isHot, false)

		child.emit("close", null)
		await running
	})
})

describe("StandaloneTerminalManager background command release", () => {
	it("drops the process reference once a tracked command settles", async () => {
		const manager = new StandaloneTerminalManager()
		const process = new EventEmitter() as TerminalProcessResultPromise

		try {
			const command = manager.trackBackgroundCommand(process, "npm test", "command_release_1")
			assert.notEqual(command.process, undefined)

			process.emit("completed", { exitCode: 0, signal: null })
			await manager.readBackgroundCommandOutput(command.id)

			const tracked = manager.getBackgroundCommand(command.id)
			// The entry itself is retained for reporting; only the runtime process,
			// which pins the OS handles, is released.
			assert.notEqual(tracked, undefined)
			assert.equal(tracked?.process, undefined)
			assert.equal(tracked?.status, "completed")
		} finally {
			await manager.disposeBackgroundCommands()
		}
	})

	it("still terminates a cancelled command after the release", async () => {
		const manager = new StandaloneTerminalManager()
		const terminate = vi.fn()
		const process = Object.assign(new EventEmitter(), { terminate }) as unknown as TerminalProcessResultPromise

		try {
			const command = manager.trackBackgroundCommand(process, "npm run watch", "command_release_2")
			assert.equal(await manager.cancelBackgroundCommand(command.id), true)

			assert.equal(terminate.mock.calls.length, 1)
			assert.equal(manager.getBackgroundCommand(command.id)?.process, undefined)
		} finally {
			await manager.disposeBackgroundCommands()
		}
	})

	it("scopes running commands to the owning task", async () => {
		const manager = new StandaloneTerminalManager()
		const first = new EventEmitter() as TerminalProcessResultPromise
		const second = new EventEmitter() as TerminalProcessResultPromise
		const untagged = new EventEmitter() as TerminalProcessResultPromise

		try {
			manager.trackBackgroundCommand(first, "npm run a", "command_scope_1", [], {
				origin: "foreground",
				cancellationOwner: "task",
				taskId: "task-a",
			})
			manager.trackBackgroundCommand(second, "npm run b", "command_scope_2", [], {
				origin: "foreground",
				cancellationOwner: "task",
				taskId: "task-b",
			})
			manager.trackBackgroundCommand(untagged, "npm run c", "command_scope_3", [], {
				origin: "foreground",
				cancellationOwner: "task",
			})

			const ownedByA = manager.getRunningBackgroundCommands({ cancellationOwner: "task", taskId: "task-a" })

			// A command that belongs to no task must not be claimed by whichever
			// task happens to ask, or the scope would not isolate anything.
			assert.deepEqual(
				ownedByA.map((command) => command.id),
				["command_scope_1"],
			)
			assert.equal(manager.getRunningBackgroundCommands("task").length, 3)
		} finally {
			await manager.disposeBackgroundCommands()
		}
	})
})

describe("StandaloneTerminalManager teardown", () => {
	type ManagerInternals = { processes: Map<number, unknown> }

	/**
	 * The real terminate walks the OS process tree, which the stubbed spawn
	 * cannot support. Teardown reaches the process objects the manager itself
	 * stored, so the prototype is the seam that observes those calls.
	 */
	function spyOnTerminate() {
		return vi.spyOn(StandaloneTerminalProcess.prototype, "terminate").mockResolvedValue(undefined)
	}

	/**
	 * Start a command through the public surface so the manager performs its own
	 * process registration. Asserting teardown against a hand-populated private
	 * map would keep passing even if runCommand stopped tracking the process.
	 */
	async function startCommand(manager: StandaloneTerminalManager) {
		const terminalInfo = await manager.getOrCreateTerminal(process.cwd())
		// runCommand returns a thenable that settles only when the command ends.
		// Wrapping it keeps `await startCommand(...)` from adopting that promise
		// and blocking on a command this fixture never completes.
		return { running: manager.runCommand(terminalInfo, "echo hi") }
	}

	afterEach(() => {
		spawnedChildren.length = 0
		vi.restoreAllMocks()
	})

	it("terminates every live process and clears the tracking table", async () => {
		const manager = new StandaloneTerminalManager()
		const terminate = spyOnTerminate()
		await startCommand(manager)
		await startCommand(manager)

		await manager.disposeAsync()

		assert.equal(terminate.mock.calls.length, 2)
		// Leaving entries behind would keep the process objects, and therefore
		// their pipes, reachable after the owner is gone.
		assert.equal((manager as unknown as ManagerInternals).processes.size, 0)
	})

	it("reuses one teardown run across repeated dispose calls", async () => {
		const manager = new StandaloneTerminalManager()
		const terminate = spyOnTerminate()
		await startCommand(manager)

		const first = manager.disposeAsync()
		// Identity is the observable part of the contract. A count alone cannot
		// prove the cache exists: the first pass empties the table synchronously,
		// so an uncached second pass would also terminate nothing.
		assert.equal(manager.disposeAsync(), first)
		await first
		assert.equal(manager.disposeAsync(), first)

		assert.equal(terminate.mock.calls.length, 1)
	})

	it("keeps tearing down after one process fails to terminate", async () => {
		const manager = new StandaloneTerminalManager()
		const terminate = spyOnTerminate()
		terminate.mockRejectedValueOnce(new Error("kill failed"))
		await startCommand(manager)
		await startCommand(manager)

		// A single unreachable child must not strand the remaining ones, and the
		// caller awaiting teardown must not see it as a failed shutdown.
		await assert.doesNotReject(() => manager.disposeAsync())

		// The healthy process is the second one, so reaching two calls proves the
		// first rejection did not abort the pass.
		assert.equal(terminate.mock.calls.length, 2)
	})

	it("terminates and forgets a background command that was still running", async () => {
		const manager = new StandaloneTerminalManager()
		const terminate = spyOnTerminate()
		// Explicit background work registers the same process twice: once as a
		// live process and once as a tracked command. Teardown owes both a
		// termination and a cleared entry.
		const { running } = await startCommand(manager)
		const command = manager.trackBackgroundCommand(running, "npm run dev", "command_teardown_1", [], {
			origin: "explicit_background",
			cancellationOwner: "task",
			taskId: "task-teardown",
		})
		assert.equal(command.status, "running")

		await manager.disposeAsync()

		assert.equal(terminate.mock.calls.length, 1)
		assert.equal(manager.getBackgroundCommand(command.id), undefined)
	})
})

describe("CommandExecutor disposal ownership", () => {
	const terminalConfiguration: TerminalManagerConfiguration = {
		shellIntegrationTimeout: 4000,
		terminalReuseEnabled: true,
		terminalOutputLineLimit: 500,
		defaultTerminalProfile: "default",
	}

	function createExecutor(terminalManager: ITerminalManager, mode: "vscodeTerminal" | "backgroundExec") {
		return new CommandExecutor(
			{
				cwd: process.cwd(),
				taskId: "task-dispose",
				ulid: "task-dispose-ulid",
				terminalExecutionMode: mode,
				terminalManager,
				terminalConfiguration,
			},
			{} as unknown as CommandExecutorCallbacks,
		)
	}

	/** A host terminal manager that records whether it was torn down. */
	function createHostManager() {
		const disposeAll = vi.fn()
		const manager = {
			configure: () => ({ closedCount: 0, busyTerminals: [] }),
			disposeAll,
			getTerminals: () => [],
			processOutput: (lines: string[]) => lines.join("\n"),
		} as unknown as ITerminalManager
		return { manager, disposeAll }
	}

	it("releases the standalone manager it created and stays idempotent", async () => {
		const { manager } = createHostManager()
		const executor = createExecutor(manager, "vscodeTerminal")
		const standalone = (executor as unknown as { standaloneManager: StandaloneTerminalManager }).standaloneManager
		const disposeAsync = vi.spyOn(standalone, "disposeAsync")

		await executor.dispose()
		await executor.dispose()

		assert.equal(disposeAsync.mock.calls.length, 2)
		// The manager collapses repeated teardown into one run, so a second dispose
		// cannot re-terminate processes that are already gone.
		assert.equal(await disposeAsync.mock.results[0].value, await disposeAsync.mock.results[1].value)
	})

	it("leaves a manager owned by the Task alone", async () => {
		const shared = new StandaloneTerminalManager()
		const disposeAsync = vi.spyOn(shared, "disposeAsync")
		const executor = createExecutor(shared, "backgroundExec")

		try {
			await executor.dispose()
			assert.equal(disposeAsync.mock.calls.length, 0)
		} finally {
			await shared.disposeAsync()
		}
	})

	it("resolves pending handoffs so no caller is left waiting", async () => {
		const { manager } = createHostManager()
		const executor = createExecutor(manager, "vscodeTerminal")
		const handoffs = (executor as unknown as { pendingHandoffs: Map<string, { resolve(): void }> }).pendingHandoffs
		let settled = false
		const waiting = new Promise<void>((resolve) => {
			handoffs.set("activity-1", {
				resolve: () => {
					settled = true
					resolve()
				},
			})
		})

		await executor.dispose()
		await waiting

		assert.equal(settled, true)
		assert.equal(handoffs.size, 0)
	})
})

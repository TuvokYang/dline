import assert from "node:assert/strict"
import path from "node:path"
import { beforeEach, describe, it, vi } from "vitest"
import type { CommandExecutorCallbacks, ITerminalManager, TerminalManagerConfiguration } from "../types"

/**
 * Behavior guard for warm-pool prewarm reporting.
 *
 * A prewarm that stops working leaves no trace of its own: commands simply
 * begin paying a cold start again, which reads as the terminal being slow
 * rather than as the pool never being refilled. The registered `prewarm_failed`
 * kind existed with no producer, so the silence was total.
 *
 * The reported reason must stay bounded. The workspace path and the underlying
 * error text are both unbounded and would become Prometheus labels.
 */

const recorded = vi.hoisted(() => ({
	phases: [] as Array<{ domain: string; phase: string; dimensions?: Record<string, unknown> }>,
	diagnostics: [] as Array<{ domain: string; kind: string; outcome: string; dimensions?: Record<string, unknown> }>,
}))

vi.mock("@/services/telemetry/instrumentation/duration-recorder", () => ({
	recordPerfPhase: (domain: string, phase: string, _durationMs: number, dimensions?: Record<string, unknown>) => {
		recorded.phases.push({ domain, phase, dimensions })
	},
	startPerfPhase: () => ({ stop: () => {}, active: false }),
	markPerfPhase: () => {},
}))

vi.mock("@/services/telemetry/instrumentation/diagnostic-recorder", () => ({
	recordDiagnostic: (domain: string, kind: string, outcome: string, dimensions?: Record<string, unknown>) => {
		recorded.diagnostics.push({ domain, kind, outcome, dimensions })
	},
}))

/** Lets one test make the environment resolution itself reject. */
const shellEnvironment = vi.hoisted(() => ({ rejectWith: undefined as Error | undefined }))

vi.mock("../shell-environment", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../shell-environment")>()
	return {
		...actual,
		ShellEnvironmentConfigLoader: class extends actual.ShellEnvironmentConfigLoader {
			override async resolve(workdirectory: string, profile: string) {
				if (shellEnvironment.rejectWith) throw shellEnvironment.rejectWith
				return super.resolve(workdirectory, profile)
			}
		},
	}
})

const { CommandExecutor } = await import("../CommandExecutor")

const terminalConfiguration: TerminalManagerConfiguration = {
	shellIntegrationTimeout: 4000,
	terminalReuseEnabled: true,
	terminalOutputLineLimit: 500,
	defaultTerminalProfile: "default",
}

function createTerminalManager(ensureWarm: ITerminalManager["ensureWarm"]): ITerminalManager {
	return {
		configure: vi.fn(() => ({ closedCount: 0, busyTerminals: [] })),
		disposeAll: vi.fn(),
		getConfiguration: vi.fn(() => terminalConfiguration),
		getOrCreateTerminal: vi.fn(),
		ensureWarm,
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

/** Build an executor and trigger the deferred prewarm. */
function prewarm(manager: ITerminalManager, workspaceRoots: readonly string[]) {
	const executor = new CommandExecutor(
		{
			cwd: workspaceRoots[0],
			workspaceRoots: [...workspaceRoots],
			taskId: "task-prewarm",
			terminalExecutionMode: "vscodeTerminal",
			terminalManager: manager,
			terminalConfiguration,
			ulid: "task-prewarm-ulid",
		},
		createCallbacks(),
	)
	// Prewarming is deferred until configuration is applied after construction.
	executor.configure(terminalConfiguration)
	return executor
}

function failures() {
	return recorded.phases.filter((entry) => entry.domain === "terminal_pool" && entry.phase === "prewarm_failed")
}

beforeEach(() => {
	recorded.phases.length = 0
	recorded.diagnostics.length = 0
	shellEnvironment.rejectWith = undefined
})

describe("warm pool prewarm observability", () => {
	it("stays silent when every workspace root warms", async () => {
		const manager = createTerminalManager(vi.fn(async () => undefined))

		prewarm(manager, [path.resolve("C:\\workspace-a")])
		await vi.waitFor(() => assert.equal(vi.mocked(manager.ensureWarm!).mock.calls.length, 1))

		assert.deepEqual(failures(), [])
		assert.deepEqual(recorded.diagnostics, [])
	})

	it("blames the environment when the shell environment cannot be resolved", async () => {
		// This failure happens before a launch configuration can be built, so
		// the pool is never even asked. Reporting it as `ensure_warm_failed`
		// would send the reader to the pool instead of the shell.
		shellEnvironment.rejectWith = new Error("shell profile could not be resolved")
		const ensureWarm = vi.fn(async () => undefined)
		const manager = createTerminalManager(ensureWarm)

		prewarm(manager, [path.resolve("C:\\workspace-a")])
		await vi.waitFor(() => assert.equal(failures().length, 1))

		assert.deepEqual(failures()[0]?.dimensions, { reason: "environment_unresolved" })
		assert.equal(ensureWarm.mock.calls.length, 0)
		assert.equal(recorded.diagnostics.at(0)?.kind, "prewarm_failed")
	})

	it("reports the root whose pool refused to warm", async () => {
		// Without this the pool would simply stop being refilled and every later
		// command would pay a cold start with nothing explaining why.
		const manager = createTerminalManager(
			vi.fn(async () => {
				throw new Error("shell integration unavailable at C:\\workspace-a")
			}),
		)

		prewarm(manager, [path.resolve("C:\\workspace-a")])
		await vi.waitFor(() => assert.equal(failures().length, 1))

		assert.deepEqual(failures()[0]?.dimensions, { reason: "ensure_warm_failed" })
		assert.deepEqual(recorded.diagnostics, [
			{
				domain: "terminal",
				kind: "prewarm_failed",
				outcome: "degraded",
				dimensions: { reason: "ensure_warm_failed" },
			},
		])
	})

	it("reports each root separately so one failure does not hide the others", async () => {
		// One root failing does not stop the rest, so an aggregate would lose
		// exactly the root that needs attention.
		let call = 0
		const manager = createTerminalManager(
			vi.fn(async () => {
				call++
				if (call === 1) throw new Error("first root failed")
			}),
		)

		prewarm(manager, [path.resolve("C:\\workspace-a"), path.resolve("C:\\workspace-b")])
		await vi.waitFor(() => assert.equal(vi.mocked(manager.ensureWarm!).mock.calls.length, 2))

		assert.equal(failures().length, 1)
	})

	it("keeps the reported reason bounded", async () => {
		const manager = createTerminalManager(
			vi.fn(async () => {
				throw new Error("C:\\workspace\\deeply\\nested\\path refused with code 17")
			}),
		)

		prewarm(manager, [path.resolve("C:\\workspace-a")])
		await vi.waitFor(() => assert.equal(failures().length, 1))

		const allowed = new Set(["environment_unresolved", "no_launch_configuration", "ensure_warm_failed"])
		for (const entry of failures()) {
			assert.ok(allowed.has(String(entry.dimensions?.reason)))
			// A path or an error message would grow without bound across
			// workspaces and failures.
			assert.deepEqual(Object.keys(entry.dimensions ?? {}), ["reason"])
		}
	})
})

import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it, vi } from "vitest"
import type { TerminalLaunchConfiguration } from "@/integrations/terminal/types"
import { DiagnosticDomain, DiagnosticOutcome } from "@/services/telemetry/instrumentation/diagnostic-events"
import type { TerminalInfo } from "./VscodeTerminalRegistry"

/**
 * Behavior guard for the warm-pool reuse diagnostic.
 *
 * `reuse_rejected` is registered as a terminal diagnostic kind but had no
 * producer, so a pool that kept discarding terminals it expected to reuse
 * looked healthy. Reuse rejection is exactly the signal that explains why warm
 * hits collapse and every command starts paying cold-start cost again.
 *
 * The reason must stay bounded: callers pass the release reason as free text,
 * and it becomes a metric label once exported.
 */

const recorded = vi.hoisted(() => ({
	diagnostics: [] as Array<{ domain: string; kind: string; outcome: string; dimensions?: Record<string, unknown> }>,
}))

vi.mock("@/services/telemetry/instrumentation/diagnostic-recorder", () => ({
	recordDiagnostic: (domain: string, kind: string, outcome: string, dimensions?: Record<string, unknown>) => {
		recorded.diagnostics.push({ domain, kind, outcome, dimensions })
	},
}))

const { VscodeTerminalPool } = await import("./VscodeTerminalPool")
type Pool = InstanceType<typeof VscodeTerminalPool>
type Preparation = Parameters<Pool["ensureWarm"]>[0]
type Runtime = ConstructorParameters<typeof VscodeTerminalPool>[0]

type CloseListener = (terminal: TerminalInfo["terminal"]) => void

class FakeTerminalPoolRuntime {
	readonly created: TerminalInfo[] = []
	readonly disposed: number[] = []
	private closeListeners = new Set<CloseListener>()
	private nextId = 1
	/** Reports a terminal as closed without the pool having disposed it. */
	readonly externallyClosed = new Set<number>()

	createTerminal(
		cwd: string,
		shellPath: string | undefined,
		launchConfiguration: TerminalLaunchConfiguration | undefined,
	): TerminalInfo {
		const id = this.nextId++
		const terminal = {
			name: `Terminal ${id}`,
			processId: Promise.resolve(id),
			shellIntegration: { cwd: { fsPath: cwd }, executeCommand: () => ({ read: async function* () {} }) },
			sendText: () => undefined,
			show: () => undefined,
			hide: () => undefined,
			dispose: () => {
				this.disposed.push(id)
				for (const listener of this.closeListeners) listener(terminal as unknown as TerminalInfo["terminal"])
			},
			exitStatus: undefined,
		}
		const info: TerminalInfo = {
			terminal: terminal as unknown as TerminalInfo["terminal"],
			busy: false,
			lastCommand: "",
			id,
			shellPath,
			configurationId: launchConfiguration?.configurationId,
			lastActive: Date.now(),
		}
		this.created.push(info)
		return info
	}

	async prepareTerminal(): Promise<void> {}
	async prepareCwd(): Promise<void> {}
	setShellIntegrationTimeout(): void {}

	disposeTerminal(terminal: TerminalInfo): void {
		terminal.terminal.dispose()
	}

	isTerminalClosed(terminal: TerminalInfo): boolean {
		return this.externallyClosed.has(terminal.id) || this.disposed.includes(terminal.id)
	}

	onDidCloseTerminal(listener: CloseListener): { dispose(): void } {
		this.closeListeners.add(listener)
		return { dispose: () => this.closeListeners.delete(listener) }
	}
}

function preparation(configurationId = "config-a", workspaceRoot = "C:\\workspace"): Preparation {
	return {
		cwd: workspaceRoot,
		workspaceRoot,
		profileId: "powershell",
		shellPath: "powershell",
		configurationId,
		environmentFingerprint: configurationId,
		createLaunchConfiguration: () => ({ configurationId }),
	}
}

/** The bounded set this layer is allowed to report. */
const ALLOWED_REASONS = new Set([
	"terminal_disposed",
	"no_shell_integration",
	"process_error",
	"unhealthy",
	"partition_draining",
	"terminal_closed",
])

function reuseRejections(): Array<Record<string, unknown> | undefined> {
	return recorded.diagnostics.filter((entry) => entry.kind === "reuse_rejected").map((entry) => entry.dimensions)
}

describe("VscodeTerminalPool reuse diagnostics", () => {
	const pools: Pool[] = []

	beforeEach(() => {
		recorded.diagnostics.length = 0
	})

	afterEach(() => {
		for (const pool of pools.splice(0)) pool.dispose()
	})

	function createPool(runtime: FakeTerminalPoolRuntime): Pool {
		const pool = new VscodeTerminalPool(runtime as unknown as Runtime)
		pools.push(pool)
		return pool
	}

	it("reports the caller reason when a reusable terminal is retired as unhealthy", async () => {
		const runtime = new FakeTerminalPoolRuntime()
		const pool = createPool(runtime)
		const target = preparation()
		await pool.ensureWarm(target)
		const lease = await pool.acquire(target, target.cwd, "reusable")

		await pool.release(lease, { healthy: false, reason: "no_shell_integration" })

		const rejections = reuseRejections()
		assert.equal(rejections.length, 1)
		assert.deepEqual(rejections[0], { reason: "no_shell_integration" })
		const entry = recorded.diagnostics.find((item) => item.kind === "reuse_rejected")
		assert.equal(entry?.domain, DiagnosticDomain.Terminal)
		assert.equal(entry?.outcome, DiagnosticOutcome.Degraded)
	})

	it("maps every reason the manager actually sends onto the bounded set", async () => {
		for (const reason of ["terminal_disposed", "no_shell_integration", "process_error"]) {
			recorded.diagnostics.length = 0
			const runtime = new FakeTerminalPoolRuntime()
			const pool = createPool(runtime)
			const target = preparation()
			await pool.ensureWarm(target)
			const lease = await pool.acquire(target, target.cwd, "reusable")

			await pool.release(lease, { healthy: false, reason })

			assert.deepEqual(reuseRejections(), [{ reason }], `reason ${reason} was not reported verbatim`)
		}
	})

	it("collapses an unrecognised reason instead of exporting it as a label", async () => {
		const runtime = new FakeTerminalPoolRuntime()
		const pool = createPool(runtime)
		const target = preparation()
		await pool.ensureWarm(target)
		const lease = await pool.acquire(target, target.cwd, "reusable")

		await pool.release(lease, { healthy: false, reason: "exit code 3221225786 in C:\\workspace" })

		const [dimensions] = reuseRejections()
		assert.equal(dimensions?.reason, "unhealthy")
		assert.equal(ALLOWED_REASONS.has(String(dimensions?.reason)), true)
	})

	it("reports a healthy terminal that was closed underneath the pool", async () => {
		const runtime = new FakeTerminalPoolRuntime()
		const pool = createPool(runtime)
		const target = preparation()
		await pool.ensureWarm(target)
		const lease = await pool.acquire(target, target.cwd, "reusable")
		runtime.externallyClosed.add(lease.terminalInfo.id)

		await pool.release(lease, { healthy: true })

		assert.deepEqual(reuseRejections(), [{ reason: "terminal_closed" }])
	})

	it("stays silent when a healthy reusable terminal returns to standby", async () => {
		const runtime = new FakeTerminalPoolRuntime()
		const pool = createPool(runtime)
		const target = preparation()
		await pool.ensureWarm(target)
		const lease = await pool.acquire(target, target.cwd, "reusable")

		await pool.release(lease, { healthy: true })

		assert.deepEqual(reuseRejections(), [])
	})

	it("reports a healthy terminal whose partition is draining", async () => {
		const runtime = new FakeTerminalPoolRuntime()
		const pool = createPool(runtime)
		const target = preparation()
		await pool.ensureWarm(target)
		const lease = await pool.acquire(target, target.cwd, "reusable")
		pool.drainAll("configuration changed")

		await pool.release(lease, { healthy: true })

		assert.deepEqual(reuseRejections(), [{ reason: "partition_draining" }])
	})

	it("reports the condition that actually retired the terminal when several apply", async () => {
		const runtime = new FakeTerminalPoolRuntime()
		const pool = createPool(runtime)
		const target = preparation()
		await pool.ensureWarm(target)
		const lease = await pool.acquire(target, target.cwd, "reusable")
		runtime.externallyClosed.add(lease.terminalInfo.id)
		pool.drainAll("configuration changed")

		// Unhealthy, draining and closed all hold here. Disposal short-circuits
		// on the caller's verdict first, so that is the reason to report;
		// naming a later coincidence would send the reader to the wrong cause.
		await pool.release(lease, { healthy: false, reason: "process_error" })

		assert.deepEqual(reuseRejections(), [{ reason: "process_error" }])
	})

	it("stays silent when an unhealthy consume lease is destroyed", async () => {
		const runtime = new FakeTerminalPoolRuntime()
		const pool = createPool(runtime)
		const target = preparation()
		await pool.ensureWarm(target)
		const lease = await pool.acquire(target, target.cwd, "consume")

		await pool.release(lease, { healthy: false, reason: "terminal_disposed" })

		// The pool never intended to keep this terminal, so its disposal says
		// nothing about whether reuse is working.
		assert.deepEqual(reuseRejections(), [])
	})

	it("stays silent when a consume lease is destroyed as its contract requires", async () => {
		const runtime = new FakeTerminalPoolRuntime()
		const pool = createPool(runtime)
		const target = preparation()
		await pool.ensureWarm(target)
		const lease = await pool.acquire(target, target.cwd, "consume")

		await pool.release(lease, { healthy: true })

		// Disposal is the expected outcome here, so reporting it would bury the
		// terminals the pool genuinely wanted to keep.
		assert.deepEqual(reuseRejections(), [])
	})
})

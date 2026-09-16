import assert from "node:assert/strict"
import { beforeEach, describe, it, vi } from "vitest"
import { DiagnosticDomain, DiagnosticOutcome } from "@/services/telemetry/instrumentation/diagnostic-events"

/**
 * Behavior guard for the warm-pool miss diagnostic.
 *
 * When the pool cannot supply a terminal the command silently pays a full cold
 * start, which dominates the cost of running a command. That fallback used to
 * exist only as a log line, so the warm hit rate could not be measured at all.
 *
 * The reason must stay bounded, and it must not be recovered by matching error
 * text: rewording an error would quietly collapse every reason to `unknown`.
 * These cases therefore assert that the reason travels on the error itself and
 * that an unrelated failure cannot leak its message into a dimension.
 */

const recorded = vi.hoisted(() => ({
	diagnostics: [] as Array<{ domain: string; kind: string; outcome: string; dimensions?: Record<string, unknown> }>,
}))

vi.mock("@/services/telemetry/instrumentation/diagnostic-recorder", () => ({
	recordDiagnostic: (domain: string, kind: string, outcome: string, dimensions?: Record<string, unknown>) => {
		recorded.diagnostics.push({ domain, kind, outcome, dimensions })
	},
}))

const { VscodeTerminalManager } = await import("./VscodeTerminalManager")
const { VscodeTerminalPool, WarmAcquireFailure } = await import("./VscodeTerminalPool")

type Pool = InstanceType<typeof VscodeTerminalPool>
type Lease = Awaited<ReturnType<Pool["acquire"]>>

/** Every reason the pool is allowed to attach to an acquire failure. */
const POOL_REASONS = [
	"capacity_reached",
	"warm_timeout",
	"retry_pending",
	"none_ready",
	"partition_draining",
	"pool_disposed",
] as const

function fakePool(acquire: () => Promise<Lease>): Pool {
	return {
		acquire,
		ensureWarm: async () => undefined,
		registerProcess: () => undefined,
		unregisterProcess: () => undefined,
		release: async () => undefined,
		drainAll: () => ({ closedCount: 0, busyTerminals: [] }),
		getPartitionSnapshot: () => ({ warming: 0, ready: 0, leased: 0, draining: false }),
		dispose: () => undefined,
	} as unknown as Pool
}

/**
 * The pool is consulted only for a launch configuration that can be partitioned,
 * so an acquisition without these fields never reaches it.
 */
const LAUNCH_CONFIGURATION = {
	workspaceRoot: "C:\\workspace",
	profileId: "powershell",
	environmentFingerprint: "fingerprint-a",
	configurationId: "config-a",
}

/** Runs one acquisition whose pool rejects with the supplied error. */
async function acquireWithFailingPool(error: unknown): Promise<void> {
	const manager = new VscodeTerminalManager(
		fakePool(async () => {
			throw error
		}),
	)
	await manager.getOrCreateTerminal("C:\\workspace", LAUNCH_CONFIGURATION)
}

function warmMisses(): Array<Record<string, unknown> | undefined> {
	return recorded.diagnostics.filter((entry) => entry.kind === "warm_pool_miss").map((entry) => entry.dimensions)
}

describe("warm pool miss diagnostics", () => {
	beforeEach(() => {
		recorded.diagnostics.length = 0
	})

	it("reports one degraded terminal diagnostic per cold fallback", async () => {
		await acquireWithFailingPool(new WarmAcquireFailure("none_ready", "No ready terminal available for partition p"))

		assert.equal(warmMisses().length, 1)
		const entry = recorded.diagnostics.find((item) => item.kind === "warm_pool_miss")
		assert.equal(entry?.domain, DiagnosticDomain.Terminal)
		assert.equal(entry?.outcome, DiagnosticOutcome.Degraded)
	})

	it("reports each pool reason without deriving it from the message", async () => {
		for (const reason of POOL_REASONS) {
			recorded.diagnostics.length = 0
			// Deliberately unrelated text: the reason must survive a reworded message.
			await acquireWithFailingPool(new WarmAcquireFailure(reason, "message text that no longer mentions the cause"))

			assert.deepEqual(warmMisses(), [{ reason }], `reason ${reason} was not reported`)
		}
	})

	it("collapses an unrecognised failure instead of exporting the message", async () => {
		await acquireWithFailingPool(new Error("EPERM: operation not permitted, open 'C:\\Users\\someone\\.profile'"))

		const [dimensions] = warmMisses()
		assert.equal(dimensions?.reason, "unknown")
		for (const value of Object.values(dimensions ?? {})) {
			assert.equal(String(value).includes("someone"), false)
		}
	})

	it("stays silent when the pool supplies a warm terminal", async () => {
		const manager = new VscodeTerminalManager(
			fakePool(
				async () =>
					({
						leaseId: "lease-1",
						partitionKey: "p",
						terminalInfo: { id: 7, busy: false, lastCommand: "", terminal: {}, lastActive: Date.now() },
						reusePolicy: "reusable",
						acquiredAt: Date.now(),
					}) as unknown as Lease,
			),
		)

		await manager.getOrCreateTerminal("C:\\workspace", LAUNCH_CONFIGURATION)

		assert.deepEqual(warmMisses(), [])
	})
})

/**
 * Builds a pool whose terminals never finish warming, so an acquire has to
 * expire on the bounded wait rather than on any other guard.
 */
function neverWarmingPool(): InstanceType<typeof VscodeTerminalPool> {
	const runtime = {
		createTerminal: (cwd: string) => ({
			terminal: {
				name: "warming",
				processId: Promise.resolve(1),
				shellIntegration: { cwd: { fsPath: cwd }, executeCommand: () => ({ read: async function* () {} }) },
				sendText: () => undefined,
				show: () => undefined,
				hide: () => undefined,
				dispose: () => undefined,
				exitStatus: undefined,
			},
			busy: false,
			lastCommand: "",
			id: 1,
			shellPath: "powershell",
			configurationId: "config-a",
			lastActive: Date.now(),
		}),
		// Never settles, so the partition stays in `warming` and the acquire
		// path reaches the timer instead of an early "nothing is warming" exit.
		prepareTerminal: () => new Promise<void>(() => {}),
		prepareCwd: async () => {},
		disposeTerminal: () => undefined,
		isTerminalClosed: () => false,
		onDidCloseTerminal: () => ({ dispose: () => undefined }),
		setShellIntegrationTimeout: () => undefined,
	}
	return new VscodeTerminalPool(runtime as unknown as ConstructorParameters<typeof VscodeTerminalPool>[0], {
		acquireWaitTimeoutMs: 20,
	})
}

describe("warm acquire failures", () => {
	it("names the reason when the real pool times out waiting for a warm terminal", async () => {
		const pool = neverWarmingPool()
		const target = {
			cwd: "C:\\workspace",
			workspaceRoot: "C:\\workspace",
			profileId: "powershell",
			shellPath: "powershell",
			configurationId: "config-a",
			environmentFingerprint: "config-a",
			createLaunchConfiguration: () => ({ configurationId: "config-a" }),
		}

		try {
			const error = await pool.acquire(target, target.cwd, "reusable").then(
				() => undefined,
				(error: unknown) => error,
			)

			// The timeout is raised by the wait timer, not by the deadline check
			// in the acquire loop. A plain Error there would leave the caller
			// unable to name the most common warm miss there is.
			assert.ok(error instanceof WarmAcquireFailure, `expected a WarmAcquireFailure, got ${String(error)}`)
			assert.equal(error.reason, "warm_timeout")
		} finally {
			pool.dispose()
		}
	})

	it("keeps the reason intact from the real pool through the manager fallback", async () => {
		recorded.diagnostics.length = 0
		const pool = neverWarmingPool()
		const manager = new VscodeTerminalManager(pool)

		try {
			// Driven end to end on purpose: the manager builds the preparation,
			// the real pool's wait timer rejects, and the manager maps the
			// failure. Handing it a pre-built error instead would leave the
			// join between those steps untested.
			await manager.getOrCreateTerminal("C:\\workspace", LAUNCH_CONFIGURATION)

			assert.deepEqual(warmMisses(), [{ reason: "warm_timeout" }])
		} finally {
			manager.disposeAll()
			pool.dispose()
		}
	})
})

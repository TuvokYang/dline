import assert from "node:assert/strict"
import { afterEach, describe, it, vi } from "vitest"
import type { TerminalLaunchConfiguration } from "@/integrations/terminal/types"
import { VscodeTerminalPool, type VscodeTerminalPoolPreparation, type VscodeTerminalPoolRuntime } from "./VscodeTerminalPool"
import type { TerminalInfo } from "./VscodeTerminalRegistry"

type CloseListener = (terminal: TerminalInfo["terminal"]) => void

class FakeTerminalPoolRuntime implements VscodeTerminalPoolRuntime {
	readonly created: TerminalInfo[] = []
	readonly disposed: number[] = []
	readonly preparedCwds: string[] = []
	private closeListeners = new Set<CloseListener>()
	private nextId = 1
	private readonly blockedPreparationResolvers = new Map<number, () => void>()
	readonly blockedPreparationIds = new Set<number>()
	prepareFailuresRemaining = 0
	shellIntegrationTimeoutMs: number | undefined

	createTerminal(
		cwd: string,
		shellPath: string | undefined,
		launchConfiguration: TerminalLaunchConfiguration | undefined,
	): TerminalInfo {
		const id = this.nextId++
		const terminal = {
			name: `Terminal ${id}`,
			processId: Promise.resolve(id),
			shellIntegration: {
				cwd: { fsPath: cwd },
				executeCommand: (_command: string) => ({
					read: async function* () {
						yield "ready\n"
					},
				}),
			},
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

	async prepareTerminal(terminal: TerminalInfo): Promise<void> {
		if (this.prepareFailuresRemaining > 0) {
			this.prepareFailuresRemaining--
			throw new Error("warm failed")
		}
		if (!this.blockedPreparationIds.has(terminal.id)) return
		await new Promise<void>((resolve) => this.blockedPreparationResolvers.set(terminal.id, resolve))
	}

	releaseBlockedPreparation(terminalId: number): void {
		this.blockedPreparationResolvers.get(terminalId)?.()
		this.blockedPreparationResolvers.delete(terminalId)
		this.blockedPreparationIds.delete(terminalId)
	}

	releaseBlockedPreparations(): void {
		for (const terminalId of [...this.blockedPreparationResolvers.keys()]) {
			this.releaseBlockedPreparation(terminalId)
		}
	}

	setShellIntegrationTimeout(timeoutMs: number): void {
		this.shellIntegrationTimeoutMs = timeoutMs
	}

	async prepareCwd(_terminal: TerminalInfo, cwd: string): Promise<void> {
		this.preparedCwds.push(cwd)
	}

	disposeTerminal(terminal: TerminalInfo): void {
		terminal.terminal.dispose()
	}

	isTerminalClosed(terminal: TerminalInfo): boolean {
		return this.disposed.includes(terminal.id)
	}

	onDidCloseTerminal(listener: CloseListener): { dispose(): void } {
		this.closeListeners.add(listener)
		return { dispose: () => this.closeListeners.delete(listener) }
	}
}

function preparation(configurationId = "config-a", workspaceRoot = "C:\\workspace"): VscodeTerminalPoolPreparation {
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

async function settlePool(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("VscodeTerminalPool", () => {
	const pools: VscodeTerminalPool[] = []

	afterEach(() => {
		for (const pool of pools.splice(0)) pool.dispose()
		vi.useRealTimers()
	})

	it("creates three warm terminals concurrently for an empty partition", async () => {
		const runtime = new FakeTerminalPoolRuntime()
		const pool = new VscodeTerminalPool(runtime)
		pools.push(pool)
		const target = preparation()

		await pool.ensureWarm(target)

		assert.equal(runtime.created.length, 3)
		assert.deepEqual(pool.getPartitionSnapshot(target), {
			warming: 0,
			ready: 3,
			leased: 0,
			draining: false,
		})
	})

	it("coalesces concurrent ensureWarm calls without exceeding three standby terminals", async () => {
		const runtime = new FakeTerminalPoolRuntime()
		const pool = new VscodeTerminalPool(runtime)
		pools.push(pool)
		const target = preparation()

		await Promise.all([pool.ensureWarm(target), pool.ensureWarm(target), pool.ensureWarm(target)])

		assert.equal(runtime.created.length, 3)
		assert.equal(pool.getPartitionSnapshot(target).ready, 3)
	})

	it("atomically leases distinct terminals and replenishes the three standby slots", async () => {
		const runtime = new FakeTerminalPoolRuntime()
		const pool = new VscodeTerminalPool(runtime)
		pools.push(pool)
		const target = preparation()
		await pool.ensureWarm(target)

		const leases = await Promise.all([
			pool.acquire(target, target.cwd, "reusable"),
			pool.acquire(target, target.cwd, "reusable"),
			pool.acquire(target, target.cwd, "reusable"),
		])
		await settlePool()

		assert.equal(new Set(leases.map((lease) => lease.terminalInfo.id)).size, 3)
		assert.equal(pool.getPartitionSnapshot(target).leased, 3)
		assert.equal(pool.getPartitionSnapshot(target).ready, 3)
		assert.equal(runtime.created.length, 6)
	})

	it("acquires an available ready terminal without waiting for sibling warming terminals", async () => {
		const runtime = new FakeTerminalPoolRuntime()
		runtime.blockedPreparationIds.add(2)
		runtime.blockedPreparationIds.add(3)
		const pool = new VscodeTerminalPool(runtime)
		pools.push(pool)
		const target = preparation()
		const warming = pool.ensureWarm(target)
		await vi.waitFor(() => assert.equal(pool.getPartitionSnapshot(target).ready, 1))

		const lease = await pool.acquire(target, target.cwd, "reusable")

		assert.equal(lease.terminalInfo.id, 1)
		runtime.releaseBlockedPreparations()
		await warming
	})

	it("joins an in-flight warm batch and acquires as soon as one terminal is ready", async () => {
		const runtime = new FakeTerminalPoolRuntime()
		runtime.blockedPreparationIds.add(1)
		runtime.blockedPreparationIds.add(2)
		runtime.blockedPreparationIds.add(3)
		const pool = new VscodeTerminalPool(runtime, { acquireWaitTimeoutMs: 1_000, maxGlobalTerminals: 3 })
		pools.push(pool)
		const target = preparation()
		const warming = pool.ensureWarm(target)
		await vi.waitFor(() => assert.equal(pool.getPartitionSnapshot(target).warming, 3))

		const acquiring = pool.acquire(target, target.cwd, "reusable")
		runtime.releaseBlockedPreparation(2)
		const lease = await acquiring

		assert.equal(lease.terminalInfo.id, 2)
		assert.deepEqual(pool.getPartitionSnapshot(target), {
			warming: 2,
			ready: 0,
			leased: 1,
			draining: false,
		})
		runtime.releaseBlockedPreparations()
		await warming
	})

	it("uses the configured shell-integration timeout as the foreground warm budget", async () => {
		vi.useFakeTimers()
		const runtime = new FakeTerminalPoolRuntime()
		runtime.blockedPreparationIds.add(1)
		runtime.blockedPreparationIds.add(2)
		runtime.blockedPreparationIds.add(3)
		const pool = new VscodeTerminalPool(runtime, { maxGlobalTerminals: 3 })
		pools.push(pool)
		pool.configureShellIntegrationTimeout(1_000)
		const target = preparation()
		const warming = pool.ensureWarm(target)
		let acquireError: unknown
		const acquiring = pool.acquire(target, target.cwd, "reusable").catch((error: unknown) => {
			acquireError = error
			return undefined
		})

		await vi.advanceTimersByTimeAsync(300)
		runtime.releaseBlockedPreparation(1)
		const lease = await acquiring

		assert.equal(runtime.shellIntegrationTimeoutMs, 1_000)
		assert.equal(acquireError, undefined)
		assert.equal(lease?.terminalInfo.id, 1)
		runtime.releaseBlockedPreparations()
		await warming
	})

	it("does not reset the wait deadline while the same warm batch remains pending", async () => {
		vi.useFakeTimers()
		const runtime = new FakeTerminalPoolRuntime()
		runtime.blockedPreparationIds.add(1)
		runtime.blockedPreparationIds.add(2)
		runtime.blockedPreparationIds.add(3)
		const pool = new VscodeTerminalPool(runtime, { acquireWaitTimeoutMs: 10, maxGlobalTerminals: 3 })
		pools.push(pool)
		const target = preparation()
		const warming = pool.ensureWarm(target)
		const firstFailure = assert.rejects(pool.acquire(target, target.cwd, "reusable"), /warm wait timed out/)

		await vi.advanceTimersByTimeAsync(10)
		await firstFailure
		await assert.rejects(pool.acquire(target, target.cwd, "reusable"), /warm wait timed out/)
		assert.equal(runtime.created.length, 3)

		runtime.releaseBlockedPreparations()
		await warming
	})

	it("treats Windows path casing differences as the same cwd", async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, "platform", { value: "win32" })
		try {
			const runtime = new FakeTerminalPoolRuntime()
			const pool = new VscodeTerminalPool(runtime)
			pools.push(pool)
			const target = preparation("config-a", "C:\\Workspace")
			await pool.ensureWarm(target)

			await pool.acquire(target, "c:\\workspace", "reusable")

			assert.deepEqual(runtime.preparedCwds, [])
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform })
		}
	})

	it("keeps a repeatedly reused terminal ready while three replacements are still warming", async () => {
		const runtime = new FakeTerminalPoolRuntime()
		const pool = new VscodeTerminalPool(runtime)
		pools.push(pool)
		const target = preparation()
		await pool.ensureWarm(target)
		runtime.blockedPreparationIds.add(4)
		runtime.blockedPreparationIds.add(5)
		runtime.blockedPreparationIds.add(6)
		let reusedTerminalId: number | undefined

		for (let commandNumber = 1; commandNumber <= 3; commandNumber++) {
			const lease = await pool.acquire(target, target.cwd, "reusable")
			reusedTerminalId ??= lease.terminalInfo.id
			assert.equal(lease.terminalInfo.id, reusedTerminalId)
			await vi.waitFor(() => assert.equal(pool.getPartitionSnapshot(target).warming, commandNumber))
			await pool.release(lease, { healthy: true })
		}

		assert.equal(runtime.disposed.includes(reusedTerminalId!), false)
		assert.equal(pool.getPartitionSnapshot(target).ready, 1)
		assert.equal(pool.getPartitionSnapshot(target).warming, 3)
		runtime.releaseBlockedPreparations()
		await vi.waitFor(() => assert.equal(pool.getPartitionSnapshot(target).warming, 0))
		assert.equal(runtime.disposed.includes(reusedTerminalId!), false)
		assert.equal(pool.getPartitionSnapshot(target).ready, 3)
	})

	it("returns a healthy reusable lease to the ready pool", async () => {
		const runtime = new FakeTerminalPoolRuntime()
		const pool = new VscodeTerminalPool(runtime)
		pools.push(pool)
		const target = preparation()
		await pool.ensureWarm(target)
		const lease = await pool.acquire(target, target.cwd, "reusable")

		await pool.release(lease, { healthy: true })

		assert.equal(runtime.disposed.length, 1)
		assert.equal(runtime.disposed.includes(lease.terminalInfo.id), false)
		assert.equal(pool.getPartitionSnapshot(target).ready, 3)
		assert.equal(pool.getPartitionSnapshot(target).leased, 0)
	})

	it("disposes a consumed lease and replaces it with a different terminal", async () => {
		const runtime = new FakeTerminalPoolRuntime()
		const pool = new VscodeTerminalPool(runtime)
		pools.push(pool)
		const target = preparation()
		await pool.ensureWarm(target)
		const lease = await pool.acquire(target, target.cwd, "consume")

		await pool.release(lease, { healthy: true })
		await settlePool()

		assert.ok(runtime.disposed.includes(lease.terminalInfo.id))
		assert.equal(pool.getPartitionSnapshot(target).ready, 3)
		assert.ok(runtime.created.some((terminal) => terminal.id !== lease.terminalInfo.id))
	})

	it("isolates terminals by configuration partition", async () => {
		const runtime = new FakeTerminalPoolRuntime()
		const pool = new VscodeTerminalPool(runtime)
		pools.push(pool)
		const first = preparation("config-a", "C:\\workspace-a")
		const second = preparation("config-b", "C:\\workspace-b")

		await Promise.all([pool.ensureWarm(first), pool.ensureWarm(second)])
		const firstLease = await pool.acquire(first, first.cwd, "reusable")
		const secondLease = await pool.acquire(second, second.cwd, "reusable")

		assert.notEqual(firstLease.partitionKey, secondLease.partitionKey)
		assert.notEqual(firstLease.terminalInfo.id, secondLease.terminalInfo.id)
	})

	it("rejects a fourth concurrent lease even after replacement terminals are ready", async () => {
		const runtime = new FakeTerminalPoolRuntime()
		const pool = new VscodeTerminalPool(runtime)
		pools.push(pool)
		const target = preparation()
		await pool.ensureWarm(target)
		await Promise.all([
			pool.acquire(target, target.cwd, "reusable"),
			pool.acquire(target, target.cwd, "reusable"),
			pool.acquire(target, target.cwd, "reusable"),
		])
		await settlePool()

		await assert.rejects(pool.acquire(target, target.cwd, "reusable"), /lease capacity reached/)
	})

	it("replenishes a ready terminal closed by the user", async () => {
		const runtime = new FakeTerminalPoolRuntime()
		const pool = new VscodeTerminalPool(runtime)
		pools.push(pool)
		const target = preparation()
		await pool.ensureWarm(target)

		runtime.created[0].terminal.dispose()
		await settlePool()

		assert.equal(runtime.created.length, 4)
		assert.equal(pool.getPartitionSnapshot(target).ready, 3)
	})

	it("drains the previous configuration generation within the same workspace scope", async () => {
		const runtime = new FakeTerminalPoolRuntime()
		const pool = new VscodeTerminalPool(runtime)
		pools.push(pool)
		const first = preparation("config-a")
		const second = preparation("config-b")
		await pool.ensureWarm(first)
		const lease = await pool.acquire(first, first.cwd, "reusable")
		await settlePool()

		await pool.ensureWarm(second)

		assert.equal(pool.getPartitionSnapshot(first).ready, 0)
		assert.equal(pool.getPartitionSnapshot(second).ready, 3)
		assert.equal(runtime.disposed.includes(lease.terminalInfo.id), false)
		await pool.release(lease, { healthy: true })
		assert.equal(runtime.disposed.includes(lease.terminalInfo.id), true)
	})

	it("prunes an idle partition after its TTL", async () => {
		const runtime = new FakeTerminalPoolRuntime()
		const pool = new VscodeTerminalPool(runtime, { idlePartitionTtlMs: 10, cleanupIntervalMs: 60_000 })
		pools.push(pool)
		const target = preparation()
		await pool.ensureWarm(target)

		const closed = pool.pruneIdlePartitions(Date.now() + 11)

		assert.equal(closed, 3)
		assert.equal(pool.getPartitionSnapshot(target).ready, 0)
	})

	it("retries a failed warm batch and restores all three ready terminals", async () => {
		vi.useFakeTimers()
		const runtime = new FakeTerminalPoolRuntime()
		runtime.prepareFailuresRemaining = 3
		const pool = new VscodeTerminalPool(runtime, { retryDelaysMs: [1], cleanupIntervalMs: 60_000 })
		pools.push(pool)
		const target = preparation()

		await pool.ensureWarm(target)
		assert.equal(pool.getPartitionSnapshot(target).ready, 0)
		await vi.advanceTimersByTimeAsync(1)
		await Promise.resolve()
		await Promise.resolve()

		assert.equal(runtime.created.length, 6)
		assert.equal(pool.getPartitionSnapshot(target).ready, 3)
	})

	it("does not exceed the global terminal capacity", async () => {
		const runtime = new FakeTerminalPoolRuntime()
		const pool = new VscodeTerminalPool(runtime, { maxGlobalTerminals: 4, retryDelaysMs: [60_000] })
		pools.push(pool)
		const first = preparation("config-a", "C:\\workspace-a")
		const second = preparation("config-b", "C:\\workspace-b")

		await pool.ensureWarm(first)
		await pool.ensureWarm(second)

		assert.equal(runtime.created.length, 4)
		assert.equal(pool.getPartitionSnapshot(first).ready, 3)
		assert.equal(pool.getPartitionSnapshot(second).ready, 1)
	})

	it("drains ready terminals while allowing an existing lease to retire on release", async () => {
		const runtime = new FakeTerminalPoolRuntime()
		const pool = new VscodeTerminalPool(runtime)
		pools.push(pool)
		const target = preparation()
		await pool.ensureWarm(target)
		const lease = await pool.acquire(target, target.cwd, "reusable")

		const result = pool.drainAll("configuration_changed")
		assert.equal(result.busyTerminals.length, 1)
		assert.equal(result.closedCount, 3)

		await pool.release(lease, { healthy: true })
		assert.ok(runtime.disposed.includes(lease.terminalInfo.id))
	})
})

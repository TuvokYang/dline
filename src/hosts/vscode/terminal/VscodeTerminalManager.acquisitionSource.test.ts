import assert from "node:assert/strict"
import { describe, it } from "vitest"
import type { TerminalAcquisitionSource } from "@/integrations/terminal/types"
import { VscodeTerminalManager } from "./VscodeTerminalManager"
import { type VscodeTerminalPool, WarmAcquireFailure } from "./VscodeTerminalPool"

/**
 * Behavior guard for separating a warm hit from a cold start.
 *
 * The acquisition histogram previously reported one distribution for both. A
 * warm hit and a cold start differ by seconds, so their mixture has no useful
 * percentile: a pool that stopped serving hits looks the same as one that
 * still does, which is exactly the regression this metric has to catch.
 */

const LAUNCH_CONFIGURATION = {
	workspaceRoot: "C:\\workspace",
	profileId: "powershell",
	environmentFingerprint: "fingerprint-a",
	configurationId: "config-a",
}

/** The bounded set a terminal may report. */
const SOURCES = new Set<TerminalAcquisitionSource>(["warm_pool", "registry_reuse", "cold_start"])

function poolReturningLease(): VscodeTerminalPool {
	const terminalInfo = { id: 7, busy: false, lastCommand: "", terminal: {}, lastActive: Date.now() }
	return {
		acquire: async () => ({
			leaseId: "lease-1",
			partitionKey: "p",
			terminalInfo,
			reusePolicy: "reusable",
			acquiredAt: Date.now(),
		}),
		ensureWarm: async () => undefined,
		registerProcess: () => undefined,
		unregisterProcess: () => undefined,
		release: async () => undefined,
		drainAll: () => ({ closedCount: 0, busyTerminals: [] }),
		getPartitionSnapshot: () => ({ warming: 0, ready: 1, leased: 0, draining: false }),
		dispose: () => undefined,
	} as unknown as VscodeTerminalPool
}

/** A pool that always refuses, forcing the manager onto its cold fallback. */
function poolRefusingEveryAcquire(): VscodeTerminalPool {
	return {
		acquire: async () => {
			throw new WarmAcquireFailure("none_ready", "No ready terminal available for partition p")
		},
		ensureWarm: async () => undefined,
		registerProcess: () => undefined,
		unregisterProcess: () => undefined,
		release: async () => undefined,
		drainAll: () => ({ closedCount: 0, busyTerminals: [] }),
		getPartitionSnapshot: () => ({ warming: 0, ready: 0, leased: 0, draining: false }),
		dispose: () => undefined,
	} as unknown as VscodeTerminalPool
}

describe("terminal acquisition source", () => {
	it("marks a pooled terminal as a warm hit", async () => {
		const manager = new VscodeTerminalManager(poolReturningLease())

		const terminal = await manager.getOrCreateTerminal("C:\\workspace", LAUNCH_CONFIGURATION)

		assert.equal(terminal.acquisitionSource, "warm_pool")
	})

	it("marks a terminal created after a warm miss as a cold start", async () => {
		const manager = new VscodeTerminalManager(poolRefusingEveryAcquire())

		const terminal = await manager.getOrCreateTerminal("C:\\workspace", LAUNCH_CONFIGURATION)

		// A warm miss is exactly the case the metric has to expose: the command
		// pays a full shell start, which is what the pool exists to avoid.
		assert.equal(terminal.acquisitionSource, "cold_start")
		manager.disposeAll()
	})

	it("only ever reports a value from the bounded set", async () => {
		const warm = await new VscodeTerminalManager(poolReturningLease()).getOrCreateTerminal(
			"C:\\workspace",
			LAUNCH_CONFIGURATION,
		)
		const coldManager = new VscodeTerminalManager(poolRefusingEveryAcquire())

		try {
			const cold = await coldManager.getOrCreateTerminal("C:\\workspace", LAUNCH_CONFIGURATION)

			// The value becomes a Prometheus label, so an unexpected string here
			// is a cardinality defect rather than a cosmetic one. Registry reuse
			// is covered against the standalone manager, whose reuse path does
			// not depend on VS Code shell integration state.
			for (const terminal of [warm, cold]) {
				assert.equal(SOURCES.has(terminal.acquisitionSource as TerminalAcquisitionSource), true)
			}
		} finally {
			coldManager.disposeAll()
		}
	})
})

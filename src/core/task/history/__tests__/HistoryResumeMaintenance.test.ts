import { describe, expect, it, vi } from "vitest"
import { HistoryResumeMaintenance } from "../HistoryResumeMaintenance"

describe("HistoryResumeMaintenance", () => {
	it("isolates stage failures and reports privacy-safe recovery counts", async () => {
		const order: string[] = []
		const reportFailure = vi.fn()
		const reportCompletion = vi.fn()
		const maintenance = new HistoryResumeMaintenance({
			cleanupLegacyStorage: async () => {
				order.push("cleanup")
				throw new Error("cleanup failed")
			},
			repairEncryptedReasoning: async () => {
				order.push("reasoning")
			},
			recoverInterruptedActivities: async () => {
				order.push("activities")
				return ["activity-1"]
			},
			patchInterruptedCommandCards: async (activityIds) => {
				order.push(`cards:${[...activityIds].join(",")}`)
				throw new Error("cards failed")
			},
			refreshTaskMetadata: async () => {
				order.push("metadata")
				throw new Error("metadata failed")
			},
			refreshContextIndicator: async () => {
				order.push("indicator")
			},
			reportFailure,
			reportCompletion,
		})

		await maintenance.run()

		expect(order).toEqual(["cleanup", "reasoning", "activities", "cards:activity-1", "metadata", "indicator"])
		expect(reportFailure.mock.calls.map(([stage]) => stage)).toEqual([
			"legacy storage cleanup",
			"interrupted command card recovery",
			"task metadata refresh",
		])
		expect(reportCompletion).toHaveBeenCalledWith({
			source: "history_execution_prepare",
			outcome: "degraded",
			durationMs: expect.any(Number),
			recoveredActivityCount: 1,
			commandCardPatchAttempted: true,
			completedStageCount: 3,
			failedStages: ["legacy storage cleanup", "interrupted command card recovery", "task metadata refresh"],
		})
	})

	it("skips command card patching when activity recovery fails", async () => {
		const order: string[] = []
		const patchInterruptedCommandCards = vi.fn(async () => undefined)
		const maintenance = new HistoryResumeMaintenance({
			cleanupLegacyStorage: async () => {
				order.push("cleanup")
			},
			repairEncryptedReasoning: async () => {
				order.push("reasoning")
			},
			recoverInterruptedActivities: async () => {
				order.push("activities")
				throw new Error("activity recovery failed")
			},
			patchInterruptedCommandCards,
			refreshTaskMetadata: async () => {
				order.push("metadata")
			},
			refreshContextIndicator: async () => {
				order.push("indicator")
			},
			reportFailure: vi.fn(),
		})

		await maintenance.run()

		expect(order).toEqual(["cleanup", "reasoning", "activities", "metadata", "indicator"])
		expect(patchInterruptedCommandCards).not.toHaveBeenCalled()
	})

	it("coalesces concurrent maintenance requests and reports once", async () => {
		let releaseCleanup: (() => void) | undefined
		const cleanupGate = new Promise<void>((resolve) => {
			releaseCleanup = resolve
		})
		const cleanupLegacyStorage = vi.fn(() => cleanupGate)
		const reportCompletion = vi.fn()
		const maintenance = new HistoryResumeMaintenance({
			cleanupLegacyStorage,
			repairEncryptedReasoning: vi.fn(async () => undefined),
			recoverInterruptedActivities: vi.fn(async () => []),
			patchInterruptedCommandCards: vi.fn(async () => undefined),
			refreshTaskMetadata: vi.fn(async () => undefined),
			refreshContextIndicator: vi.fn(async () => undefined),
			reportFailure: vi.fn(),
			reportCompletion,
		})

		const first = maintenance.run()
		const second = maintenance.run()
		expect(cleanupLegacyStorage).toHaveBeenCalledOnce()
		releaseCleanup?.()
		await Promise.all([first, second])
		expect(reportCompletion).toHaveBeenCalledOnce()
	})

	it("reports superseded when ownership is lost during the final stage", async () => {
		let current = true
		let releaseIndicator!: () => void
		const indicatorGate = new Promise<void>((resolve) => {
			releaseIndicator = resolve
		})
		const reportCompletion = vi.fn()
		const maintenance = new HistoryResumeMaintenance({
			cleanupLegacyStorage: vi.fn(async () => undefined),
			repairEncryptedReasoning: vi.fn(async () => undefined),
			recoverInterruptedActivities: vi.fn(async () => []),
			patchInterruptedCommandCards: vi.fn(async () => undefined),
			refreshTaskMetadata: vi.fn(async () => undefined),
			refreshContextIndicator: async () => indicatorGate,
			reportFailure: vi.fn(),
			reportCompletion,
		})

		const run = maintenance.run(() => current)
		await vi.waitFor(() => expect(maintenance.waitForIdle()).toBe(run))
		current = false
		releaseIndicator()
		await run

		expect(reportCompletion).toHaveBeenCalledWith(expect.objectContaining({ outcome: "superseded" }))
	})

	it("contains completion observer failures", async () => {
		const maintenance = new HistoryResumeMaintenance({
			cleanupLegacyStorage: vi.fn(async () => undefined),
			repairEncryptedReasoning: vi.fn(async () => undefined),
			recoverInterruptedActivities: vi.fn(async () => ["activity-1"]),
			patchInterruptedCommandCards: vi.fn(async () => undefined),
			refreshTaskMetadata: vi.fn(async () => undefined),
			refreshContextIndicator: vi.fn(async () => undefined),
			reportFailure: vi.fn(),
			reportCompletion: () => {
				throw new Error("observer failed")
			},
		})

		await expect(maintenance.run()).resolves.toBeUndefined()
	})
})

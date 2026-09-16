import type { ContextWindowIndicatorLineage } from "@shared/context-window-indicator"
import type { ClineContent } from "@shared/messages"
import { describe, expect, it, vi } from "vitest"
import { ContextWindowIndicator } from "../ContextWindowIndicator"
import { Task } from "../index"

const compactionLineage: ContextWindowIndicatorLineage = {
	kind: "compaction_pass",
	operationId: "operation-1",
	passIndex: 0,
	attemptIndex: 0,
	attemptId: "attempt-0",
}

describe("Task context compaction regressions", () => {
	it("adopts a smaller authoritative Durable value after compaction commit and baseline rebase", () => {
		const indicator = new ContextWindowIndicator({
			taskId: "task-1",
			durableContextTokens: 500,
			environmentTokens: 20,
			contextWindow: 1_000,
			mode: "act",
		})
		indicator.beginSend({
			lineage: compactionLineage,
			durableContextTokens: 500,
			pendingSendTokens: 100,
			environmentTokens: 20,
			contextWindow: 1_000,
			mode: "act",
		})

		const committed = indicator.commit({
			lineage: compactionLineage,
			durableContextTokens: 120,
			pendingSendTokens: 10,
			environmentTokens: 20,
			allowDecrease: true,
		})
		expect(committed.durableContextTokens).toBe(130)

		const recovered = indicator.rebaseDurable({
			durableContextTokens: 80,
			pendingSendTokens: 20,
			environmentTokens: 20,
			contextWindow: 1_000,
			mode: "act",
		})
		expect(recovered).toMatchObject({ durableContextTokens: 100, lineage: { kind: "baseline" } })
	})

	it("releases an accepted API continuation before presenting terminal compaction Retry", async () => {
		const order: string[] = []
		const recoverApiFailure = vi.fn(async () => {
			order.push("recover")
		})
		const task = {
			taskId: "task-1",
			taskState: { forceTruncateAvailable: false, autoRetryAttempts: 0 },
			contextCompactionFailureReasons: new Map([["operation-1", "No tool output found"]]),
			contextCompactionRetryProgress: new Map(),
			endAutoRetrySequence: vi.fn(),
			say: vi.fn(async () => undefined),
			getRuntimeState: () => ({ revision: 9 }),
			interactionCoordinator: {
				releaseApiContinuationForRequestGate: vi.fn(async () => {
					order.push("release")
					return true
				}),
			},
			recoverApiFailure,
		}
		const presentTerminalCompactionFailure = Reflect.get(Task.prototype, "presentTerminalCompactionFailure") as (
			this: typeof task,
			operationId: string,
			apiIndex: number,
			retryContent: ClineContent[],
		) => Promise<void>
		const retryContent: ClineContent[] = [{ type: "text", text: "latest pending input" }]

		await presentTerminalCompactionFailure.call(task, "operation-1", 79, retryContent)

		expect(order).toEqual(["release", "recover"])
		expect(task.say).not.toHaveBeenCalled()
		expect(task.taskState.autoRetryAttempts).toBe(0)
		expect(recoverApiFailure).toHaveBeenCalledWith(
			expect.objectContaining({ apiIndex: 79, persistedRequest: false, retryContent }),
		)
	})

	it("marks terminal compaction as exhausted only after the Pass retry budget was actually used", async () => {
		const task = {
			taskId: "task-1",
			taskState: { forceTruncateAvailable: false, autoRetryAttempts: 0 },
			contextCompactionFailureReasons: new Map([["operation-1", "Service unavailable"]]),
			contextCompactionRetryProgress: new Map([["operation-1", { retryAttempt: 3, maxRetryAttempts: 3 }]]),
			endAutoRetrySequence: vi.fn(),
			say: vi.fn(async () => undefined),
			getRuntimeState: () => ({ revision: 9 }),
			interactionCoordinator: { releaseApiContinuationForRequestGate: vi.fn(async () => true) },
			recoverApiFailure: vi.fn(async () => undefined),
		}
		const presentTerminalCompactionFailure = Reflect.get(Task.prototype, "presentTerminalCompactionFailure") as (
			this: typeof task,
			operationId: string,
			apiIndex: number,
			retryContent: ClineContent[],
		) => Promise<void>

		await presentTerminalCompactionFailure.call(task, "operation-1", 79, [])

		expect(task.taskState.autoRetryAttempts).toBe(3)
		expect(task.say).toHaveBeenCalledWith("error_retry", expect.stringContaining('"failed":true'))
	})
})

import type { ProviderAttemptObserver } from "@shared/provider-attempt-observer"
import { describe, expect, it, vi } from "vitest"
import type { BlockPhase } from "../kernel"
import type { ApiRequestRoundUsage } from "../performance/api-request-round-types"
import type { ProviderRequestRoundAdmission } from "../performance/provider-request-round-port"
import { TaskProviderRequestRoundOwner } from "../performance/TaskProviderRequestRoundOwner"

interface ProviderExecutionBlock {
	readonly blockId: string
	readonly phase: BlockPhase
}

function createAdmission(): ProviderRequestRoundAdmission {
	return {
		bindAttempt: (stream) => stream,
		attachExactUsage: vi.fn(),
		completeProviderOnly: vi.fn(),
		completeTools: vi.fn(),
		completeTurnEndAwaitingUser: vi.fn(),
	}
}

function createOwner(
	blocks: readonly ProviderExecutionBlock[] = [],
	options: { readonly cancelling?: boolean } = {},
): TaskProviderRequestRoundOwner {
	return new TaskProviderRequestRoundOwner({
		lifecycle: {
			createObserver: vi.fn(() => ({
				beginAttempt: () => undefined,
				finishAttempt: () => undefined,
			})),
			attachExactUsage: vi.fn(),
			completeProviderOnly: vi.fn(),
			completeTools: vi.fn(),
			completeTurnEndAwaitingUser: vi.fn(),
		},
		readExecutionBlocks: () => blocks,
		isExecutionCancelling: () => options.cancelling ?? false,
	})
}

describe("Task Provider request round admission", () => {
	it("creates a new logical request for task attempt zero and reuses it only for recursive retries", () => {
		const observedScopes: Array<{ logicalRequestId: string; apiIndex: number; taskAttempt: number }> = []
		const attachedUsage: Array<{ logicalRequestId: string; usage: ApiRequestRoundUsage }> = []
		const observer: ProviderAttemptObserver<number> = {
			beginAttempt: () => 1,
			finishAttempt: () => undefined,
		}
		const owner = new TaskProviderRequestRoundOwner({
			lifecycle: {
				createObserver: vi.fn((input) => {
					observedScopes.push(input)
					return observer
				}),
				attachExactUsage: vi.fn((logicalRequestId, usage) => {
					attachedUsage.push({ logicalRequestId, usage })
				}),
				completeProviderOnly: vi.fn(),
				completeTools: vi.fn(),
				completeTurnEndAwaitingUser: vi.fn(),
			},
			readExecutionBlocks: () => [],
			isExecutionCancelling: () => false,
		})
		const emptyStream = (async function* () {})()

		const first = owner.admitOrdinary(7, 0)
		const retry = owner.admitOrdinary(7, 1)
		expect(retry).toBe(first)
		first.bindAttempt(emptyStream, 0)
		retry.bindAttempt(emptyStream, 1)

		const restored = owner.admitOrdinary(7, 0)
		expect(restored).not.toBe(first)
		restored.bindAttempt(emptyStream, 0)

		const [firstScope, retryScope, restoredScope] = observedScopes
		expect(firstScope).toMatchObject({ apiIndex: 7, taskAttempt: 0 })
		expect(retryScope).toMatchObject({ apiIndex: 7, taskAttempt: 1 })
		expect(retryScope?.logicalRequestId).toBe(firstScope?.logicalRequestId)
		expect(restoredScope).toMatchObject({ apiIndex: 7, taskAttempt: 0 })
		expect(restoredScope?.logicalRequestId).not.toBe(firstScope?.logicalRequestId)

		const usage: ApiRequestRoundUsage = {
			inputTokens: 100,
			outputTokens: 20,
			cacheReadTokens: 0,
			cacheUsageReported: true,
		}
		owner.attachOrdinaryExactUsage(7, usage)
		expect(attachedUsage).toEqual([{ logicalRequestId: restoredScope?.logicalRequestId, usage }])
	})

	it("completes a Provider-only execution when no tool turn was registered", () => {
		const admission = createAdmission()
		const owner = createOwner()

		owner.completeTurn(admission)

		expect(admission.completeProviderOnly).toHaveBeenCalledOnce()
		expect(admission.completeTools).not.toHaveBeenCalled()
	})

	it("summarizes every terminal block in an all-settled parallel tool turn", () => {
		const admission = createAdmission()
		const owner = createOwner([
			{ blockId: "completed", phase: "completed" },
			{ blockId: "failed", phase: "rejected" },
			{ blockId: "skipped", phase: "skipped" },
			{ blockId: "cancelled", phase: "cancelled" },
		])
		owner.registerExecution(admission, {
			turnId: "turn:parallel",
			toolCount: 4,
			turnEndInteractions: [],
		})

		owner.completeTurn(admission)

		expect(admission.completeTools).toHaveBeenCalledWith({
			toolCount: 4,
			completedToolCount: 1,
			failedToolCount: 1,
			cancelledToolCount: 2,
		})
	})

	it("leaves Task-aborted executions for lifecycle abort instead of writing tools-settled", () => {
		const admission = createAdmission()
		const owner = createOwner([{ blockId: "tool", phase: "executing" }], { cancelling: true })
		owner.registerExecution(admission, {
			turnId: "turn:parallel",
			toolCount: 1,
			turnEndInteractions: [{ interactionId: "interaction-1", blockId: "tool" }],
		})

		owner.completeTurn(admission)
		owner.completeAtAwaitingUser("turn:parallel", "interaction-1")

		expect(admission.completeProviderOnly).not.toHaveBeenCalled()
		expect(admission.completeTools).not.toHaveBeenCalled()
		expect(admission.completeTurnEndAwaitingUser).not.toHaveBeenCalled()
	})

	it("terminals TURN-END at the durable awaiting-user boundary without counting later user wait", () => {
		const admission = createAdmission()
		const owner = createOwner([
			{ blockId: "regular", phase: "completed" },
			{ blockId: "turn-end", phase: "awaiting_approval" },
			{ blockId: "later", phase: "pending" },
		])
		owner.registerExecution(admission, {
			turnId: "turn:turn-end",
			toolCount: 3,
			turnEndInteractions: [{ interactionId: "interaction-1", blockId: "turn-end" }],
		})

		owner.completeAtAwaitingUser("turn:turn-end", "interaction-1")
		owner.completeAtAwaitingUser("turn:turn-end", "interaction-1")

		expect(admission.completeTurnEndAwaitingUser).toHaveBeenCalledOnce()
		expect(admission.completeTurnEndAwaitingUser).toHaveBeenCalledWith({
			toolCount: 3,
			completedToolCount: 2,
			failedToolCount: 0,
			cancelledToolCount: 1,
		})
	})
})

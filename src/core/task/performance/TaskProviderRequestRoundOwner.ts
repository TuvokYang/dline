import type { ProviderAttemptObserver } from "@shared/provider-attempt-observer"
import { bindProviderAttemptScope } from "@shared/provider-attempt-observer"
import { ulid } from "ulid"
import type { BlockPhase, KernelBlock } from "../kernel"
import type { ApiRequestRoundScopeInput } from "./api-request-round-lifecycle"
import type { ApiRequestRoundUsage } from "./api-request-round-types"
import type { ApiResponseExecutionToolSummary } from "./api-response-execution-types"
import type {
	ProviderRequestRoundAdmission,
	ProviderRequestRoundAdmissionInput,
	ProviderRequestRoundPort,
} from "./provider-request-round-port"

interface ProviderRequestRoundLifecyclePort {
	createObserver(input: ApiRequestRoundScopeInput): ProviderAttemptObserver
	attachExactUsage(logicalRequestId: string, usage: ApiRequestRoundUsage): void
	completeProviderOnly(logicalRequestId: string): void
	completeTools(logicalRequestId: string, summary: ApiResponseExecutionToolSummary): void
	completeTurnEndAwaitingUser(logicalRequestId: string, summary: ApiResponseExecutionToolSummary): void
}

type ProviderExecutionBlock = Pick<KernelBlock, "blockId" | "phase">

export interface ProviderExecutionRegistration {
	readonly turnId: string
	readonly toolCount: number
	readonly turnEndInteractions: readonly { readonly interactionId: string; readonly blockId: string }[]
}

export interface TaskProviderRequestRoundOwnerOptions {
	readonly lifecycle: ProviderRequestRoundLifecyclePort
	readonly readExecutionBlocks: (turnId: string) => readonly ProviderExecutionBlock[]
	readonly isExecutionCancelling: () => boolean
}

type ActiveProviderExecution = ProviderExecutionRegistration

interface TurnEndProviderExecution {
	readonly turnId: string
	readonly blockId: string
	readonly toolCount: number
	readonly admission: ProviderRequestRoundAdmission
}

/** Owns logical Provider request rounds and their response-execution completion lifecycle. */
export class TaskProviderRequestRoundOwner implements ProviderRequestRoundPort {
	private readonly ordinaryRounds = new Map<number, ProviderRequestRoundAdmission>()
	private readonly activeExecutions = new Map<ProviderRequestRoundAdmission, ActiveProviderExecution>()
	private readonly turnEndExecutions = new Map<string, TurnEndProviderExecution>()
	private nextAuxiliaryApiIndex = 0

	constructor(private readonly options: TaskProviderRequestRoundOwnerOptions) {}

	admit(input: ProviderRequestRoundAdmissionInput): ProviderRequestRoundAdmission {
		const apiIndex = input.apiIndex ?? this.nextAuxiliaryApiIndex++
		const logicalRequestId = `${input.source}:${ulid()}`
		return {
			bindAttempt: <T>(stream: AsyncIterable<T>, taskAttempt: number) =>
				bindProviderAttemptScope(
					stream,
					this.options.lifecycle.createObserver({ logicalRequestId, apiIndex, taskAttempt }),
				),
			attachExactUsage: (usage) => this.options.lifecycle.attachExactUsage(logicalRequestId, usage),
			completeProviderOnly: () => this.options.lifecycle.completeProviderOnly(logicalRequestId),
			completeTools: (summary) => this.options.lifecycle.completeTools(logicalRequestId, summary),
			completeTurnEndAwaitingUser: (summary) =>
				this.options.lifecycle.completeTurnEndAwaitingUser(logicalRequestId, summary),
		}
	}

	admitOrdinary(apiIndex: number, taskAttempt: number): ProviderRequestRoundAdmission {
		if (taskAttempt > 0) {
			const existing = this.ordinaryRounds.get(apiIndex)
			if (existing) return existing
		}
		const admission = this.admit({ source: "ordinary", apiIndex })
		this.ordinaryRounds.set(apiIndex, admission)
		return admission
	}

	getOrdinary(apiIndex: number): ProviderRequestRoundAdmission | undefined {
		return this.ordinaryRounds.get(apiIndex)
	}

	attachOrdinaryExactUsage(apiIndex: number, usage: ApiRequestRoundUsage): void {
		this.ordinaryRounds.get(apiIndex)?.attachExactUsage(usage)
	}

	registerExecution(admission: ProviderRequestRoundAdmission, registration: ProviderExecutionRegistration): void {
		this.activeExecutions.set(admission, registration)
		for (const interaction of registration.turnEndInteractions) {
			this.turnEndExecutions.set(interaction.interactionId, {
				turnId: registration.turnId,
				blockId: interaction.blockId,
				toolCount: registration.toolCount,
				admission,
			})
		}
	}

	completeAtAwaitingUser(turnId: string, interactionId: string): void {
		const execution = this.turnEndExecutions.get(interactionId)
		if (!execution || execution.turnId !== turnId) return
		execution.admission.completeTurnEndAwaitingUser(
			this.summarizeExecutionTools(turnId, execution.blockId, execution.toolCount),
		)
		this.turnEndExecutions.delete(interactionId)
	}

	completeTurn(admission?: ProviderRequestRoundAdmission): void {
		if (!admission) return
		const execution = this.activeExecutions.get(admission)
		if (this.options.isExecutionCancelling()) {
			if (execution) this.clearExecution(admission, execution)
			return
		}
		if (!execution) {
			admission.completeProviderOnly()
			return
		}
		admission.completeTools(this.summarizeExecutionTools(execution.turnId, undefined, execution.toolCount))
		this.clearExecution(admission, execution)
	}

	private clearExecution(admission: ProviderRequestRoundAdmission, execution: ActiveProviderExecution): void {
		for (const interaction of execution.turnEndInteractions) this.turnEndExecutions.delete(interaction.interactionId)
		this.activeExecutions.delete(admission)
	}

	private summarizeExecutionTools(
		turnId: string,
		awaitingBlockId?: string,
		fallbackToolCount = 0,
	): ApiResponseExecutionToolSummary {
		const blocks = this.options.readExecutionBlocks(turnId)
		let completedToolCount = 0
		let failedToolCount = 0
		let cancelledToolCount = 0
		for (const block of blocks) {
			if (block.blockId === awaitingBlockId || block.phase === "completed") {
				completedToolCount += 1
				continue
			}
			if (block.phase === "failed" || block.phase === "rejected") {
				failedToolCount += 1
				continue
			}
			if (isUnsettledOrCancelled(block.phase)) {
				cancelledToolCount += 1
			}
		}
		if (blocks.length === 0 && fallbackToolCount > 0) {
			const fallbackCompletedToolCount = awaitingBlockId ? 1 : 0
			return {
				toolCount: fallbackToolCount,
				completedToolCount: fallbackCompletedToolCount,
				failedToolCount: 0,
				cancelledToolCount: fallbackToolCount - fallbackCompletedToolCount,
			}
		}
		const toolCount = completedToolCount + failedToolCount + cancelledToolCount
		return { toolCount, completedToolCount, failedToolCount, cancelledToolCount }
	}
}

function isUnsettledOrCancelled(phase: BlockPhase): boolean {
	return (
		phase === "pending" ||
		phase === "awaiting_approval" ||
		phase === "ready" ||
		phase === "executing" ||
		phase === "skipped" ||
		phase === "cancelled"
	)
}

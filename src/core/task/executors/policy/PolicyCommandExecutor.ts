import type { ApprovalEvaluateCommand, Command } from "../../kernel"
import type { CommandExecutor } from "../../runtime"
import { executorFailure, type HaltOrder, type HaltParticipant, isExecutionAbort, type TaskEventSink } from "../contracts"

export interface ApprovalPolicyInput {
	readonly interactionId: string
	readonly blockId: string
	readonly attempt: string
	readonly policyRevision: number
	readonly riskFacts: Readonly<Record<string, string | number | boolean>>
	readonly signal: AbortSignal
}

export interface ApprovalPolicyResult {
	readonly approved: boolean
}

export interface ApprovalPolicyPort {
	evaluate(input: ApprovalPolicyInput): Promise<ApprovalPolicyResult>
}

interface ActivePolicyCommand {
	readonly controller: AbortController
	readonly completion: Promise<void>
}

/** Owns automatic/AI policy evaluation; manual responses remain dialog events. */
export class PolicyCommandExecutor implements CommandExecutor, HaltParticipant {
	readonly domain = "policy" as const
	readonly id = "policy" as const
	private readonly active = new Map<string, ActivePolicyCommand>()
	private fencedHaltId: string | undefined

	constructor(
		private readonly port: ApprovalPolicyPort,
		private readonly events: TaskEventSink,
	) {}

	execute(command: Command): Promise<void> {
		if (command.type !== "approval.evaluate") return Promise.reject(new Error(`Policy executor cannot run ${command.type}`))
		if (this.fencedHaltId) return Promise.resolve()
		const controller = new AbortController()
		const completion = this.run(command, controller).finally(() => this.active.delete(command.commandId))
		this.active.set(command.commandId, { controller, completion })
		return completion
	}

	fence(order: HaltOrder): void {
		this.fencedHaltId = order.haltId
	}

	stop(order: HaltOrder): void {
		for (const active of this.active.values()) active.controller.abort(`policy_${order.reason}`)
	}

	async drain(_order: HaltOrder): Promise<void> {
		await Promise.allSettled([...this.active.values()].map((active) => active.completion))
	}

	rearm(haltId: string): void {
		if (this.fencedHaltId === haltId) this.fencedHaltId = undefined
	}

	private async run(command: ApprovalEvaluateCommand, controller: AbortController): Promise<void> {
		try {
			const result = await this.port.evaluate({
				interactionId: command.interactionId,
				blockId: command.blockId,
				attempt: command.attempt,
				policyRevision: command.policyRevision,
				riskFacts: command.riskFacts,
				signal: controller.signal,
			})
			if (controller.signal.aborted) return
			await this.events.submit({
				type: "approval.evaluated",
				generation: command.generation,
				commandId: command.commandId,
				originRevision: command.originRevision,
				interactionId: command.interactionId,
				blockId: command.blockId,
				attempt: command.attempt,
				policyRevision: command.policyRevision,
				approved: result.approved,
			})
		} catch (error) {
			if (isExecutionAbort(error, controller.signal)) return
			await this.events.submit({
				type: "approval.failed",
				generation: command.generation,
				commandId: command.commandId,
				originRevision: command.originRevision,
				interactionId: command.interactionId,
				blockId: command.blockId,
				attempt: command.attempt,
				policyRevision: command.policyRevision,
				message: executorFailure("policy", error),
			})
		}
	}
}

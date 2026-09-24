import type { Command, ComposeRoundCommand, TurnContinuationReason } from "../../kernel"
import type { CommandExecutor } from "../../runtime"
import { executorFailure, type HaltOrder, type HaltParticipant, isExecutionAbort, type TaskEventSink } from "../contracts"

export interface ComposeRoundInput {
	readonly turnId?: string
	readonly admittedEntryIds: readonly string[]
	/**
	 * Why the kernel opened this round without a submission, when it did.
	 *
	 * The compose domain owns what a round contains, so the reason has to reach
	 * it: a round continued after a toolless answer must tell the model why it
	 * is being asked again, or the same answer simply repeats.
	 */
	readonly continuation?: TurnContinuationReason
	readonly signal: AbortSignal
}

/**
 * What composing one round produced.
 *
 * Either a draft for the provider, or the round given up before any draft:
 * a lifecycle command the round had to carry out first did not complete, so
 * nothing the user still wants remains to be sent.
 */
export type ComposeRoundResult = { readonly draftRef: string } | { readonly withdrawn: { readonly reason: string } }

export interface ComposePort {
	compose(input: ComposeRoundInput): Promise<ComposeRoundResult>
}

interface ActiveComposeCommand {
	readonly controller: AbortController
	readonly completion: Promise<void>
}

export class ComposeCommandExecutor implements CommandExecutor, HaltParticipant {
	readonly domain = "compose" as const
	readonly id = "compose" as const
	private readonly active = new Map<string, ActiveComposeCommand>()
	private fencedHaltId: string | undefined

	constructor(
		private readonly port: ComposePort,
		private readonly events: TaskEventSink,
	) {}

	execute(command: Command): Promise<void> {
		if (command.type !== "compose.round") return Promise.reject(new Error(`Compose executor cannot run ${command.type}`))
		if (this.fencedHaltId) return Promise.resolve()
		if (this.active.size > 0) return Promise.reject(new Error("Compose execution is already active"))
		const controller = new AbortController()
		const completion = this.run(command, controller).finally(() => this.active.delete(command.commandId))
		this.active.set(command.commandId, { controller, completion })
		return completion
	}

	fence(order: HaltOrder): void {
		this.fencedHaltId = order.haltId
	}

	stop(order: HaltOrder): void {
		this.cancelAll(`compose_${order.reason}`)
	}

	async drain(_order: HaltOrder): Promise<void> {
		await Promise.allSettled([...this.active.values()].map((active) => active.completion))
	}

	rearm(haltId: string): void {
		if (this.fencedHaltId === haltId) this.fencedHaltId = undefined
	}

	cancel(commandId: string, reason = "compose_cancelled"): boolean {
		const active = this.active.get(commandId)
		if (!active) return false
		active.controller.abort(reason)
		return true
	}

	cancelAll(reason = "compose_cancelled"): number {
		for (const active of this.active.values()) active.controller.abort(reason)
		return this.active.size
	}

	private async run(command: ComposeRoundCommand, controller: AbortController): Promise<void> {
		let result: ComposeRoundResult
		try {
			result = await this.port.compose({
				turnId: command.turnId,
				admittedEntryIds: command.admittedEntryIds,
				...(command.continuation === undefined ? {} : { continuation: command.continuation }),
				signal: controller.signal,
			})
		} catch (error) {
			if (isExecutionAbort(error, controller.signal)) return
			await this.events.submit({
				type: "compose.failed",
				generation: command.generation,
				commandId: command.commandId,
				originRevision: command.originRevision,
				turnId: command.turnId,
				message: executorFailure("compose", error),
			})
			return
		}
		if (controller.signal.aborted) return
		if ("withdrawn" in result) {
			await this.events.submit({
				type: "compose.withdrawn",
				generation: command.generation,
				commandId: command.commandId,
				originRevision: command.originRevision,
				turnId: command.turnId,
				reason: result.withdrawn.reason,
			})
			return
		}
		if (!result.draftRef) throw new Error("MissingDraftRef")
		await this.events.submit(this.completed(command, result.draftRef))
	}

	private completed(command: ComposeRoundCommand, draftRef: string) {
		return {
			type: "compose.completed" as const,
			generation: command.generation,
			commandId: command.commandId,
			originRevision: command.originRevision,
			turnId: command.turnId,
			draftRef,
		}
	}
}

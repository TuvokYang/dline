import type { Command, ComposeRoundCommand } from "../../kernel"
import type { CommandExecutor } from "../../runtime"
import { executorFailure, type HaltOrder, type HaltParticipant, isExecutionAbort, type TaskEventSink } from "../contracts"

export interface ComposeRoundInput {
	readonly turnId?: string
	readonly admittedEntryIds: readonly string[]
	readonly signal: AbortSignal
}

export interface ComposeRoundResult {
	readonly draftRef: string
}

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

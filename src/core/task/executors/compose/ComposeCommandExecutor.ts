import type { Command, ComposeRoundCommand } from "../../kernel"
import type { CommandExecutor } from "../../runtime/v2"
import { executorFailure, isExecutionAbort, type TaskEventSink } from "../contracts"

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

export class ComposeCommandExecutor implements CommandExecutor {
	readonly domain = "compose" as const
	private readonly active = new Map<string, AbortController>()

	constructor(
		private readonly port: ComposePort,
		private readonly events: TaskEventSink,
	) {}

	async execute(command: Command): Promise<void> {
		if (command.type !== "compose.round") throw new Error(`Compose executor cannot run ${command.type}`)
		if (this.active.size > 0) throw new Error("Compose execution is already active")
		const controller = new AbortController()
		this.active.set(command.commandId, controller)
		try {
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
		} finally {
			this.active.delete(command.commandId)
		}
	}

	cancel(commandId: string, reason = "compose_cancelled"): boolean {
		const controller = this.active.get(commandId)
		if (!controller) return false
		controller.abort(reason)
		return true
	}

	cancelAll(reason = "compose_cancelled"): number {
		for (const controller of this.active.values()) controller.abort(reason)
		return this.active.size
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

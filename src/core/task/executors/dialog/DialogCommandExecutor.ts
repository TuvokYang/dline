import type { Command, DialogCommand } from "../../kernel"
import type { CommandExecutor } from "../../runtime"
import { executorFailure, type HaltOrder, type HaltParticipant, isExecutionAbort, type TaskEventSink } from "../contracts"

export interface DialogPreparationResult {
	readonly journalRef: string
	readonly journalWatermark: { readonly epoch: number; readonly seq: number }
	readonly receiverGeneration: number
	readonly disposition: "created" | "existing"
}

export interface DialogRevealResult {
	readonly disposition: "revealed" | "already_revealed"
}

export interface DialogExecutionPort {
	prepare(
		input: DialogCommand & { readonly type: "dialog.prepare"; readonly signal: AbortSignal },
	): Promise<DialogPreparationResult>
	reveal(input: DialogCommand & { readonly type: "dialog.reveal"; readonly signal: AbortSignal }): Promise<DialogRevealResult>
	dismiss?(
		input: DialogCommand & { readonly type: "dialog.reveal"; readonly signal: AbortSignal; readonly reason: string },
	): Promise<void>
}

interface ActiveDialogCommand {
	readonly controller: AbortController
	readonly completion: Promise<void>
}

/** Executes durable dialog prepare/reveal phases without waiting for a user response. */
export class DialogCommandExecutor implements CommandExecutor, HaltParticipant {
	readonly domain = "dialog" as const
	readonly id = "dialog" as const
	private readonly active = new Map<string, ActiveDialogCommand>()
	private fencedHaltId: string | undefined

	constructor(
		private readonly port: DialogExecutionPort,
		private readonly events: TaskEventSink,
	) {}

	execute(command: Command): Promise<void> {
		if (command.type !== "dialog.prepare" && command.type !== "dialog.reveal")
			return Promise.reject(new Error(`Dialog executor cannot run ${command.type}`))
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
		for (const active of this.active.values()) active.controller.abort(`dialog_${order.reason}`)
	}

	async drain(_order: HaltOrder): Promise<void> {
		await Promise.allSettled([...this.active.values()].map((active) => active.completion))
	}

	rearm(haltId: string): void {
		if (this.fencedHaltId === haltId) this.fencedHaltId = undefined
	}

	private async run(command: DialogCommand, controller: AbortController): Promise<void> {
		try {
			if (command.type === "dialog.prepare") {
				const result = await this.port.prepare({ ...command, signal: controller.signal })
				if (controller.signal.aborted) return
				if (!result.journalRef) throw new Error("MissingJournalRef")
				await this.events.submit({
					type: "dialog.prepared",
					generation: command.generation,
					commandId: command.commandId,
					originRevision: command.originRevision,
					interactionId: command.interactionId,
					journalRef: result.journalRef,
					journalWatermark: result.journalWatermark,
					receiverGeneration: result.receiverGeneration,
				})
				return
			}
			await this.port.reveal({ ...command, signal: controller.signal })
			if (controller.signal.aborted) return
			const presented = await this.events.submit({
				type: "dialog.presented",
				generation: command.generation,
				commandId: command.commandId,
				originRevision: command.originRevision,
				interactionId: command.interactionId,
			})
			if (presented.kind === "rejected")
				await this.port.dismiss?.({ ...command, signal: controller.signal, reason: "presentation_feedback_rejected" })
		} catch (error) {
			if (isExecutionAbort(error, controller.signal)) return
			await this.events.submit({
				type: "dialog.failed",
				generation: command.generation,
				commandId: command.commandId,
				originRevision: command.originRevision,
				interactionId: command.interactionId,
				stage: command.type === "dialog.prepare" ? "prepare" : "reveal",
				message: executorFailure("dialog", error),
			})
		}
	}
}

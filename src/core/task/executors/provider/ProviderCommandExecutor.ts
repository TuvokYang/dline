import type { Command, ProviderStartCommand } from "../../kernel"
import type { CommandExecutor } from "../../runtime/v2"
import type { ConversationJournal, TaskViewPort } from "../../stores"
import { executorFailure, isExecutionAbort, type TaskEventSink } from "../contracts"

export type ProviderExecutionChunk =
	| {
			readonly kind: "partial"
			readonly transientId: string
			readonly payloadRef: string
			readonly projection?: Readonly<Record<string, unknown>>
	  }
	| { readonly kind: "usage"; readonly usage: Readonly<Record<string, number>> }
	| {
			readonly kind: "final"
			readonly turnId: string
			readonly payloadRef: string
			readonly transientId?: string
	  }

export interface ProviderExecutionInput {
	readonly draftRef: string
	readonly turnId?: string
	readonly signal: AbortSignal
}

export interface ProviderExecutionPort {
	start(input: ProviderExecutionInput): AsyncIterable<ProviderExecutionChunk>
	recordUsage?(usage: Readonly<Record<string, number>>): void
}

export class ProviderCommandExecutor implements CommandExecutor {
	readonly domain = "provider" as const
	private readonly active = new Map<string, AbortController>()

	constructor(
		private readonly taskId: string,
		private readonly port: ProviderExecutionPort,
		private readonly journal: ConversationJournal,
		private readonly taskView: TaskViewPort,
		private readonly events: TaskEventSink,
	) {}

	async execute(command: Command): Promise<void> {
		if (command.type !== "provider.start") throw new Error(`Provider executor cannot run ${command.type}`)
		if (this.active.size > 0) throw new Error("Provider execution is already active")
		const controller = new AbortController()
		this.active.set(command.commandId, controller)
		try {
			let finalChunk: Extract<ProviderExecutionChunk, { kind: "final" }> | undefined
			try {
				finalChunk = await this.consume(command, controller.signal)
			} catch (error) {
				if (isExecutionAbort(error, controller.signal)) return
				await this.events.submit({
					type: "provider.failed",
					generation: command.generation,
					commandId: command.commandId,
					originRevision: command.originRevision,
					turnId: command.turnId,
					message: executorFailure("provider", error),
				})
				return
			}
			if (!finalChunk || controller.signal.aborted) return
			await this.events.submit({
				type: "provider.turn_ready",
				generation: command.generation,
				commandId: command.commandId,
				originRevision: command.originRevision,
				turnId: finalChunk.turnId,
				finalPayloadRef: finalChunk.payloadRef,
			})
		} finally {
			this.active.delete(command.commandId)
		}
	}

	cancel(commandId: string, reason = "provider_cancelled"): boolean {
		const controller = this.active.get(commandId)
		if (!controller) return false
		controller.abort(reason)
		return true
	}

	cancelAll(reason = "provider_cancelled"): number {
		for (const controller of this.active.values()) controller.abort(reason)
		return this.active.size
	}

	private async consume(
		command: ProviderStartCommand,
		signal: AbortSignal,
	): Promise<Extract<ProviderExecutionChunk, { kind: "final" }> | undefined> {
		let finalChunk: Extract<ProviderExecutionChunk, { kind: "final" }> | undefined
		let transientId: string | undefined
		for await (const chunk of this.port.start({ draftRef: command.draftRef, turnId: command.turnId, signal })) {
			if (signal.aborted) return undefined
			if (finalChunk) {
				if (chunk.kind === "usage") {
					try {
						this.port.recordUsage?.(chunk.usage)
					} catch {
						// Metrics must not change provider execution semantics.
					}
					continue
				}
				throw new Error("ChunkAfterFinal")
			}
			if (chunk.kind === "partial") {
				if (transientId && transientId !== chunk.transientId) throw new Error("MultipleTransientStreams")
				transientId = chunk.transientId
				this.journal.appendTransient(chunk.transientId, chunk.payloadRef)
				this.taskView.notifyTransient(
					this.taskId,
					chunk.projection ?? { kind: "provider.partial", payloadRef: chunk.payloadRef },
				)
				continue
			}
			if (chunk.kind === "usage") {
				try {
					this.port.recordUsage?.(chunk.usage)
				} catch {
					// Metrics must not change provider execution semantics.
				}
				continue
			}
			if (transientId && chunk.transientId !== transientId) throw new Error("FinalTransientIdentityMismatch")
			if (command.turnId && chunk.turnId !== command.turnId) throw new Error("ProviderTurnIdentityMismatch")
			finalChunk = chunk
		}
		if (signal.aborted) return undefined
		if (!finalChunk) throw new Error("MissingFinalChunk")
		if (finalChunk.transientId) await this.journal.finalizeTransient(finalChunk.transientId, finalChunk.payloadRef)
		else await this.journal.append(finalChunk.payloadRef)
		if (signal.aborted) return undefined
		return finalChunk
	}
}

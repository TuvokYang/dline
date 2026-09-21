import type { Command, ProviderStartCommand, ProviderTurnPlan } from "../../kernel"
import type { CommandExecutor } from "../../runtime"
import type { ConversationJournal, TaskViewPort } from "../../stores"
import { executorFailure, type HaltOrder, type HaltParticipant, isExecutionAbort, type TaskEventSink } from "../contracts"

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
			readonly turnPlan: ProviderTurnPlan
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

interface ActiveProviderCommand {
	readonly controller: AbortController
	readonly completion: Promise<void>
}

export class ProviderCommandExecutor implements CommandExecutor, HaltParticipant {
	readonly domain = "provider" as const
	readonly id = "provider" as const
	private readonly active = new Map<string, ActiveProviderCommand>()
	private fencedHaltId: string | undefined

	constructor(
		private readonly taskId: string,
		private readonly port: ProviderExecutionPort,
		private readonly journal: ConversationJournal,
		private readonly taskView: TaskViewPort,
		private readonly events: TaskEventSink,
	) {}

	execute(command: Command): Promise<void> {
		if (command.type !== "provider.start") return Promise.reject(new Error(`Provider executor cannot run ${command.type}`))
		if (this.fencedHaltId) return Promise.resolve()
		if (this.active.size > 0) return Promise.reject(new Error("Provider execution is already active"))
		const controller = new AbortController()
		const completion = this.run(command, controller).finally(() => this.active.delete(command.commandId))
		this.active.set(command.commandId, { controller, completion })
		return completion
	}

	fence(order: HaltOrder): void {
		this.fencedHaltId = order.haltId
	}

	stop(order: HaltOrder): void {
		this.cancelAll(`provider_${order.reason}`)
	}

	async drain(_order: HaltOrder): Promise<void> {
		await Promise.allSettled([...this.active.values()].map((active) => active.completion))
	}

	rearm(haltId: string): void {
		if (this.fencedHaltId === haltId) this.fencedHaltId = undefined
	}

	cancel(commandId: string, reason = "provider_cancelled"): boolean {
		const active = this.active.get(commandId)
		if (!active) return false
		active.controller.abort(reason)
		return true
	}

	cancelAll(reason = "provider_cancelled"): number {
		for (const active of this.active.values()) active.controller.abort(reason)
		return this.active.size
	}

	private async run(command: ProviderStartCommand, controller: AbortController): Promise<void> {
		let finalResult:
			| {
					readonly chunk: Extract<ProviderExecutionChunk, { kind: "final" }>
					readonly journalWatermark: { readonly epoch: number; readonly seq: number }
			  }
			| undefined
		try {
			finalResult = await this.consume(command, controller.signal)
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
		if (!finalResult || controller.signal.aborted) return
		await this.events.submit({
			type: "provider.turn_ready",
			generation: command.generation,
			commandId: command.commandId,
			originRevision: command.originRevision,
			turnId: finalResult.chunk.turnId,
			finalPayloadRef: finalResult.chunk.payloadRef,
			journalWatermark: finalResult.journalWatermark,
			turnPlan: finalResult.chunk.turnPlan,
		})
	}

	private async consume(
		command: ProviderStartCommand,
		signal: AbortSignal,
	): Promise<
		| {
				readonly chunk: Extract<ProviderExecutionChunk, { kind: "final" }>
				readonly journalWatermark: { readonly epoch: number; readonly seq: number }
		  }
		| undefined
	> {
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
		const journalInput = {
			operationId: `provider.final:${command.commandId}`,
			payloadRef: finalChunk.payloadRef,
			source: "provider" as const,
			causation: {
				commandId: command.commandId,
				originRevision: command.originRevision,
				generation: command.generation,
				turnId: finalChunk.turnId,
			},
		}
		const appended = finalChunk.transientId
			? await this.journal.finalizeTransient({ ...journalInput, transientId: finalChunk.transientId })
			: await this.journal.append(journalInput)
		if (signal.aborted) return undefined
		return { chunk: finalChunk, journalWatermark: appended.watermark }
	}
}

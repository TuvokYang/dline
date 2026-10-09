import type { Command, ProviderStartCommand, ProviderTurnPlan } from "../../kernel"
import type { CommandExecutor } from "../../runtime"
import type { ConversationJournal, TaskViewPort } from "../../stores"
import { executorFailure, type HaltOrder, type HaltParticipant, isExecutionAbort, type TaskEventSink } from "../contracts"
import { presentationOf } from "./ProviderFailure"
import {
	mergeProviderUsage,
	type ProviderReceivingEstimate,
	type ProviderRequestOutcome,
	type ProviderRequestRecord,
	type ProviderRequestReportPort,
	type ProviderRetryNotice,
} from "./service/ProviderRequestReport"

export type ProviderExecutionChunk =
	| {
			readonly kind: "partial"
			readonly transientId: string
			/** The prose streamed so far, kept only in the transient presentation plane. */
			readonly text?: string
			/** The reasoning streamed so far, for presentation. */
			readonly reasoning?: string
			readonly projection?: Readonly<Record<string, unknown>>
	  }
	| { readonly kind: "usage"; readonly usage: Readonly<Record<string, number>> }
	/** How much the streaming response occupies so far; presentation only, never journaled. */
	| ({ readonly kind: "receiving" } & ProviderReceivingEstimate)
	/** The request failed before its first chunk and will be sent again; nothing reached the journal. */
	| { readonly kind: "retry"; readonly notice: ProviderRetryNotice }
	/**
	 * What a reply the user stopped had already said.
	 *
	 * The only chunk produced after the stop. It is journaled so the next request
	 * continues from it, but it plans no turn: nothing it was calling runs.
	 */
	| {
			readonly kind: "interrupted"
			readonly transientId: string
			readonly payloadRef: string
			readonly text?: string
			readonly reasoning?: string
	  }
	| {
			readonly kind: "final"
			readonly turnId: string
			readonly payloadRef: string
			readonly transientId?: string
			/** The assistant's settled prose; see ProviderTextPresentationPort. */
			readonly text?: string
			readonly reasoning?: string
			readonly turnPlan: ProviderTurnPlan
	  }

/**
 * Shows the assistant's prose as its own chat row.
 *
 * The provider domain already owns what the outside sees while a turn streams,
 * and a reply that calls no tool has nothing else to show it: the journal entry
 * feeds the next request, not the conversation on screen. Without this the user
 * watched a turn run and end with no visible answer.
 *
 * Declared as a port because a headless assembly has no chat to write to.
 */
export interface ProviderTextPresentationPort {
	/**
	 * Reveal the reasoning and prose streamed so far under the stream's own identity.
	 *
	 * An empty `reasoning` still opens the reasoning row: the model is thinking,
	 * but only in an encrypted form that must never be shown.
	 */
	showPartial(input: { readonly transientId: string; readonly text: string; readonly reasoning?: string }): void
	/** Settle those rows once the turn is durable, or retract a row that received nothing. */
	commit(input: { readonly transientId: string; readonly text: string; readonly reasoning?: string }): Promise<void>
}

export interface ProviderExecutionInput {
	readonly draftRef: string
	readonly turnId?: string
	readonly signal: AbortSignal
}

export interface ProviderExecutionPort {
	start(input: ProviderExecutionInput): AsyncIterable<ProviderExecutionChunk>
	recoverFinal?(payloadRef: string): Promise<{ readonly turnPlan: ProviderTurnPlan }>
	recordUsage?(usage: Readonly<Record<string, number>>): void
}

interface ActiveProviderCommand {
	readonly controller: AbortController
	readonly completion: Promise<void>
}

/** A turn the journal accepted, together with where it landed. */
interface ProviderTurnOutcome {
	readonly chunk: Extract<ProviderExecutionChunk, { kind: "final" }>
	readonly journalWatermark: { readonly seq: number }
}

/** Carries the usage seen so far into the settlement that happens after the stream. */
interface UsageAccumulator {
	value?: Readonly<Record<string, number>>
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
		private readonly presentation?: ProviderTextPresentationPort,
		private readonly report?: ProviderRequestReportPort,
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
		let finalResult: ProviderTurnOutcome | undefined
		try {
			finalResult = (await this.recoverFinal(command)) ?? (await this.consume(command, controller.signal))
		} catch (error) {
			if (isExecutionAbort(error, controller.signal)) return
			const presentation = presentationOf(error)
			await this.events.submit({
				type: "provider.failed",
				generation: command.generation,
				commandId: command.commandId,
				originRevision: command.originRevision,
				turnId: command.turnId,
				message: executorFailure("provider", error),
				...(presentation === undefined ? {} : { presentation }),
			})
			return
		}
		if (!finalResult) return
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

	private async recoverFinal(command: ProviderStartCommand): Promise<ProviderTurnOutcome | undefined> {
		const entry = await this.journal.findByOperation(`provider.final:${command.commandId}`)
		if (!entry) return undefined
		if (entry.kind !== "message" || entry.source !== "provider" || !entry.payloadRef)
			throw new Error("InvalidProviderFinalJournalEntry")
		if (!this.port.recoverFinal) throw new Error("ProviderFinalRecoveryUnavailable")
		const recovered = await this.port.recoverFinal(entry.payloadRef)
		const turnId = entry.causation?.turnId ?? command.turnId
		if (!turnId) throw new Error("MissingProviderFinalTurnIdentity")
		return {
			chunk: { kind: "final", turnId, payloadRef: entry.payloadRef, turnPlan: recovered.turnPlan },
			journalWatermark: entry.watermark,
		}
	}

	private async consume(command: ProviderStartCommand, signal: AbortSignal): Promise<ProviderTurnOutcome | undefined> {
		const record = await this.openRequestRecord(command)
		const usage: UsageAccumulator = {}
		// A stream that neither yields a turn nor throws was abandoned, which only
		// happens when the signal fired, so an unset outcome means cancellation.
		let outcome: ProviderRequestOutcome = "cancelled"
		try {
			const turn = await this.streamTurn(command, signal, usage, record)
			if (turn) outcome = "completed"
			return turn
		} catch (error) {
			outcome = isExecutionAbort(error, signal) ? "cancelled" : "failed"
			throw error
		} finally {
			// Settles on every exit, cancellation and failure included, so a request
			// never stays open as a turn the user is still waiting on.
			await this.closeRequestRecord(record, usage, outcome)
		}
	}

	/** A record that cannot be opened only costs visibility, never the turn. */
	private async openRequestRecord(command: ProviderStartCommand): Promise<ProviderRequestRecord | undefined> {
		if (!this.report) return undefined
		try {
			return await this.report.begin({ turnId: command.turnId ?? command.commandId })
		} catch {
			return undefined
		}
	}

	private async closeRequestRecord(
		record: ProviderRequestRecord | undefined,
		usage: UsageAccumulator,
		outcome: ProviderRequestOutcome,
	): Promise<void> {
		if (!record) return
		try {
			await record.settle({ usage: usage.value, outcome })
		} catch {
			// Reporting must not change provider execution semantics.
		}
	}

	/** Retry progress only costs visibility when it cannot be shown, never the turn. */
	private async noteRetry(record: ProviderRequestRecord | undefined, notice: ProviderRetryNotice): Promise<void> {
		try {
			await record?.retrying?.(notice)
		} catch {
			// Reporting must not change provider execution semantics.
		}
	}

	private async noteRecovered(record: ProviderRequestRecord | undefined): Promise<void> {
		try {
			await record?.recovered?.()
		} catch {
			// Reporting must not change provider execution semantics.
		}
	}

	private async noteReceiving(record: ProviderRequestRecord | undefined, estimate: ProviderReceivingEstimate): Promise<void> {
		try {
			await record?.receiving?.(estimate)
		} catch {
			// Reporting must not change provider execution semantics.
		}
	}

	private absorbUsage(accumulated: UsageAccumulator, usage: Readonly<Record<string, number>>): void {
		accumulated.value = mergeProviderUsage(accumulated.value, usage)
		try {
			this.port.recordUsage?.(usage)
		} catch {
			// Metrics must not change provider execution semantics.
		}
	}

	private async streamTurn(
		command: ProviderStartCommand,
		signal: AbortSignal,
		usage: UsageAccumulator,
		record: ProviderRequestRecord | undefined,
	): Promise<ProviderTurnOutcome | undefined> {
		let finalChunk: Extract<ProviderExecutionChunk, { kind: "final" }> | undefined
		let interrupted: Extract<ProviderExecutionChunk, { kind: "interrupted" }> | undefined
		let transientId: string | undefined
		let retrying = false
		let durableTerminal = false
		try {
			for await (const chunk of this.port.start({ draftRef: command.draftRef, turnId: command.turnId, signal })) {
				if (chunk.kind === "interrupted") {
					interrupted = chunk
					continue
				}
				// After a stop the service ends the stream without waiting for the
				// provider; only its closing interrupted report still counts.
				if (signal.aborted) continue
				// Handled before anything else: it carries no content, so it is neither
				// a first chunk ending a retry nor a reply that could be the final one.
				if (chunk.kind === "receiving") {
					await this.noteReceiving(record, {
						receivingTokens: chunk.receivingTokens,
						authoritativeContextTokens: chunk.authoritativeContextTokens,
					})
					continue
				}
				if (finalChunk) {
					if (chunk.kind === "usage") {
						this.absorbUsage(usage, chunk.usage)
						continue
					}
					throw new Error("ChunkAfterFinal")
				}
				if (chunk.kind === "retry") {
					// A stream that showed only prose or reasoning may be sent again;
					// the resent stream keeps its transient identity and rewrites
					// those rows, so nothing it showed is journaled twice.
					retrying = true
					await this.noteRetry(record, chunk.notice)
					continue
				}
				if (retrying) {
					retrying = false
					await this.noteRecovered(record)
				}
				if (chunk.kind === "partial") {
					if (transientId && transientId !== chunk.transientId) throw new Error("MultipleTransientStreams")
					transientId = chunk.transientId
					this.journal.appendTransient(chunk.transientId)
					this.taskView.notifyTransient(
						this.taskId,
						chunk.projection ?? { kind: "provider.partial", transientId: chunk.transientId },
					)
					this.presentation?.showPartial({
						transientId: chunk.transientId,
						text: chunk.text ?? "",
						...(chunk.reasoning === undefined ? {} : { reasoning: chunk.reasoning }),
					})
					continue
				}
				if (chunk.kind === "usage") {
					this.absorbUsage(usage, chunk.usage)
					continue
				}
				if (transientId && chunk.transientId !== transientId) throw new Error("FinalTransientIdentityMismatch")
				if (command.turnId && chunk.turnId !== command.turnId) throw new Error("ProviderTurnIdentityMismatch")
				finalChunk = chunk
			}
			if (signal.aborted) {
				if (!interrupted) throw signal.reason
				await this.persistInterruption(command, interrupted, transientId)
				durableTerminal = true
				await this.presentation?.commit({
					transientId: interrupted.transientId,
					text: interrupted.text ?? "",
					...(interrupted.reasoning === undefined ? {} : { reasoning: interrupted.reasoning }),
				})
				return undefined
			}
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
			durableTerminal = true
			// Settled only after the journal accepted the turn: a row shown as final
			// before its durable entry exists would survive a crash the turn did not.
			if (finalChunk.transientId) {
				await this.presentation?.commit({
					transientId: finalChunk.transientId,
					text: finalChunk.text ?? "",
					...(finalChunk.reasoning === undefined ? {} : { reasoning: finalChunk.reasoning }),
				})
			}
			return { chunk: finalChunk, journalWatermark: appended.watermark }
		} catch (error) {
			if (transientId && !durableTerminal) await this.withdrawTransient(transientId)
			throw error
		}
	}

	private async withdrawTransient(transientId: string): Promise<void> {
		this.journal.discardTransient(transientId)
		await this.presentation?.commit({ transientId, text: "" })
	}

	/**
	 * Persist what a stopped reply had already said before its rows settle.
	 *
	 * The caller marks the terminal durable immediately after this resolves, so
	 * later cancellation or presentation failure cannot retract the journal fact.
	 */
	private async persistInterruption(
		command: ProviderStartCommand,
		interrupted: Extract<ProviderExecutionChunk, { kind: "interrupted" }>,
		streamedTransientId: string | undefined,
	): Promise<void> {
		const journalInput = {
			operationId: `provider.interrupted:${command.commandId}`,
			payloadRef: interrupted.payloadRef,
			source: "provider" as const,
			causation: {
				commandId: command.commandId,
				originRevision: command.originRevision,
				generation: command.generation,
				...(command.turnId === undefined ? {} : { turnId: command.turnId }),
			},
		}
		if (streamedTransientId) await this.journal.finalizeTransient({ ...journalInput, transientId: streamedTransientId })
		else await this.journal.append(journalInput)
	}
}

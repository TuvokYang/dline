import type { TaskState, TurnContinuationReason } from "../../kernel"
import type { ConversationJournal } from "../../stores"
import type { TaskPayloadStore } from "../../stores/contracts"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type {
	EnvironmentDetailsEnvelope,
	LifecycleCommand,
	ProviderDraftEnvelope,
	TurnContinuationEnvelope,
	UserInputEnvelope,
} from "../../stores/payload/TaskPayloadEnvelopes"
import type { ComposePort, ComposeRoundInput, ComposeRoundResult } from "./ComposeCommandExecutor"
import { type RetainedBatchReceipt, RetainedInputJournalBatch } from "./RetainedInputJournalBatch"
import type { RetainedInputPresentationCommit, RetainedInputPresentationPort } from "./RetainedInputPresentationPort"
import { materializeToolTerminalManifest } from "./ToolTerminalManifestMaterializer"

/**
 * Renders the dynamic environment block for one provider round.
 *
 * The compose domain owns the round, so it decides when a snapshot is taken;
 * what goes into the snapshot belongs to the host-side projection.
 */
export interface ComposeEnvironmentPort {
	render(input: { readonly turnId?: string; readonly signal: AbortSignal }): Promise<string | undefined>
}

/**
 * Renders what a kernel-opened round tells the model.
 *
 * The kernel decides that a round continues; it cannot know how to say so,
 * because the wording belongs to the prompt profile in use. Declaring a port
 * keeps that wording out of the compose domain and out of the kernel.
 */
export interface ComposeContinuationPort {
	render(reason: TurnContinuationReason): string | undefined
}

/**
 * Holds a round until any compaction owed to it has finished.
 *
 * Context pressure is only measurable once a request settles, but the round
 * that needs the smaller context is the next one. Compose is where every round
 * begins - a user submission and a kernel continuation both arrive here - so
 * this is the only point that can order the summary before the request that
 * should carry it.
 */
export interface ComposeCompactionBarrierPort {
	/**
	 * Carry out what the round owes before it is drafted.
	 *
	 * @param input.signal The round's own signal; a stopped round stops waiting.
	 * @param input.lifecycle Commands the round's admitted inputs carry, in order.
	 */
	settleBeforeRound(input: {
		readonly signal: AbortSignal
		readonly lifecycle: readonly LifecycleCommand[]
	}): Promise<RoundReadiness>
}

/** Whether a round may be drafted once the barrier settled. */
export type RoundReadiness = { readonly kind: "ready" } | { readonly kind: "withdrawn"; readonly reason: string }

export interface ProductionComposeAdapterOptions {
	readonly payloads: TaskPayloadStore
	readonly journal: ConversationJournal
	readonly readState: () => Readonly<TaskState>
	readonly environment?: ComposeEnvironmentPort
	/** Explains a continued round to the model; absent in headless assemblies. */
	readonly continuation?: ComposeContinuationPort
	/** Condenses the conversation before this round is drafted, when one is owed. */
	readonly compactionBarrier?: ComposeCompactionBarrierPort
	/** Projects the selected user-authored batch without model-only guidance. */
	readonly retainedInputPresentation?: RetainedInputPresentationPort
}

/** Materializes admitted intake entries into one immutable provider draft. */
export class ProductionComposeAdapter implements ComposePort {
	private readonly retainedBatches: RetainedInputJournalBatch

	constructor(private readonly options: ProductionComposeAdapterOptions) {
		this.retainedBatches = new RetainedInputJournalBatch(options.payloads, options.journal)
	}

	async preparePresentation(input: ComposeRoundInput): Promise<RetainedInputPresentationCommit | undefined> {
		if (!input.queueDelivery || !this.options.retainedInputPresentation) return undefined
		const entries = this.admittedEntries(input).filter((entry) => entry.queue !== undefined)
		if (entries.length === 0) return undefined
		return this.options.retainedInputPresentation.prepare({
			deliveryId: input.queueDelivery.deliveryId,
			mode: "steering",
			entries,
		})
	}

	async rollbackRetainedQueue(input: ComposeRoundInput): Promise<"released"> {
		if (!input.queueDelivery) return "released"
		const evidence = await this.retainedBatches.inspect(input.queueDelivery.deliveryId)
		if (evidence.kind === "absent" || evidence.kind === "retracted") return "released"
		await this.retainedBatches.retract({
			deliveryId: evidence.receipt.deliveryId,
			entries: evidence.receipt.entries,
		})
		return "released"
	}

	async compose(input: ComposeRoundInput): Promise<ComposeRoundResult> {
		if (input.signal.aborted) throw input.signal.reason
		const lifecycle = await this.lifecycleOf([...this.admittedEntries(input), ...(input.respondedQueue?.entries ?? [])])
		// Before the conversation is read, so the draft below describes what the
		// compaction left behind rather than the one that was too large.
		const readiness = (await this.options.compactionBarrier?.settleBeforeRound({
			signal: input.signal,
			lifecycle,
		})) ?? { kind: "ready" }
		if (input.signal.aborted) throw input.signal.reason
		if (readiness.kind === "withdrawn") return { withdrawn: { reason: readiness.reason } }
		// Read again: the compaction advanced the revision this round is keyed by.
		const state = this.options.readState()
		const entries = this.admittedEntries(input)

		if (input.toolTerminals) {
			await materializeToolTerminalManifest({
				manifest: input.toolTerminals,
				payloads: this.options.payloads,
				journal: this.options.journal,
			})
		}
		await this.appendContinuation(input, state.generation)
		// Tool feedback carries its model text in the paired result. These original
		// refs carry admission metadata only: never append their text a second time.
		const inputPayloadRefs: string[] = [...(input.respondedQueue?.entries.map((entry) => entry.payloadRef) ?? [])]
		const retainedEntries = entries.filter((entry) => entry.queue !== undefined)
		const ordinaryEntries = entries.filter((entry) => entry.queue === undefined)
		inputPayloadRefs.push(...entries.map((entry) => entry.payloadRef))
		for (const entry of ordinaryEntries) {
			if (input.signal.aborted) throw input.signal.reason
			await this.options.journal.append({
				operationId: `intake:${entry.source}:${entry.entryId}`,
				payloadRef: entry.payloadRef,
				source: "intake",
				causation: { generation: state.generation, turnId: input.turnId },
			})
		}
		let queueReceipt: RetainedBatchReceipt | undefined
		if (input.queueDelivery) {
			if (retainedEntries.length === 0) throw new Error("RetainedDeliveryMissingEntries")
			queueReceipt = await this.retainedBatches.stage({
				deliveryId: input.queueDelivery.deliveryId,
				entries: retainedEntries.map(({ entryId, payloadRef }) => ({ entryId, payloadRef })),
				generation: input.queueDelivery.generation,
				turnId: input.turnId,
				signal: input.signal,
			})
		}
		if (input.signal.aborted) throw input.signal.reason
		await this.appendEnvironment(input, state.revision, state.generation)
		// Only the position: the conversation through it is fixed, so recording
		// every visible payload would only grow the draft with the conversation.
		const envelope: ProviderDraftEnvelope = {
			kind: "provider_draft",
			admittedEntryIds: input.admittedEntryIds,
			...(input.continuation === undefined ? {} : { continuation: input.continuation }),
			inputPayloadRefs,
			journalThrough: this.options.journal.watermark(),
			turnId: input.turnId,
		}
		for (const payloadRef of envelope.inputPayloadRefs) {
			decodeTaskPayload(await this.options.payloads.read(payloadRef))
		}
		return {
			draftRef: await this.options.payloads.put(encodeTaskPayload(envelope)),
			...(queueReceipt === undefined
				? {}
				: {
						queueJournalReceipt: {
							deliveryId: queueReceipt.deliveryId,
							entries: queueReceipt.entries,
							journalWatermark: queueReceipt.watermark,
						},
					}),
		}
	}

	private admittedEntries(input: ComposeRoundInput) {
		const state = this.options.readState()
		const entries = [...state.intake.queued, ...state.intake.background, ...state.intake.coTask].filter((entry) =>
			input.admittedEntryIds.includes(entry.entryId),
		)
		if (entries.length !== input.admittedEntryIds.length) throw new Error("AdmittedIntakeEntryMissing")
		return [...entries].sort(
			(left, right) => input.admittedEntryIds.indexOf(left.entryId) - input.admittedEntryIds.indexOf(right.entryId),
		)
	}

	/**
	 * The lifecycle commands the admitted inputs carry.
	 *
	 * Read from the inputs rather than handed over at admission, so only an
	 * input the kernel accepted and this round admitted can carry one out.
	 */
	private async lifecycleOf(entries: readonly { readonly payloadRef: string }[]): Promise<LifecycleCommand[]> {
		const commands: LifecycleCommand[] = []
		for (const entry of entries) {
			const payload = decodeTaskPayload<UserInputEnvelope>(await this.options.payloads.read(entry.payloadRef))
			if (payload.kind === "user_input" && payload.lifecycle) commands.push(payload.lifecycle)
		}
		return commands
	}

	/**
	 * Journal why this round was opened, before the round's other content.
	 *
	 * A continued round has no submission of its own, so without this entry the
	 * next request repeats the previous one verbatim and the model has no reason
	 * to answer differently.
	 */
	private async appendContinuation(input: ComposeRoundInput, generation: number): Promise<void> {
		if (!input.continuation) return
		const text = this.options.continuation?.render(input.continuation)
		if (!text) return
		if (input.signal.aborted) throw input.signal.reason
		const envelope: TurnContinuationEnvelope = { kind: "turn_continuation", reason: input.continuation, text }
		await this.options.journal.append({
			operationId: `continuation:${input.continuation}:${generation}:${input.turnId ?? "no_turn"}`,
			payloadRef: await this.options.payloads.put(encodeTaskPayload(envelope)),
			source: "system",
			causation: { generation, turnId: input.turnId },
		})
	}

	/**
	 * Journal the environment after the round's inputs so replay keeps the
	 * legacy order: user content first, then the snapshot describing the
	 * workspace at the moment the round was composed.
	 */
	private async appendEnvironment(input: ComposeRoundInput, revision: number, generation: number): Promise<void> {
		const text = await this.options.environment?.render({ turnId: input.turnId, signal: input.signal })
		if (!text) return
		if (input.signal.aborted) throw input.signal.reason
		const envelope: EnvironmentDetailsEnvelope = { kind: "environment_details", text }
		await this.options.journal.append({
			operationId: `environment:${revision}`,
			payloadRef: await this.options.payloads.put(encodeTaskPayload(envelope)),
			source: "system",
			causation: { generation, turnId: input.turnId },
		})
	}
}

import type { TaskState } from "../../kernel"
import type { ConversationJournal } from "../../stores"
import type { TaskPayloadStore } from "../../stores/FileTaskPayloadStore"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { EnvironmentDetailsEnvelope, ProviderDraftEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import type { ComposePort, ComposeRoundInput, ComposeRoundResult } from "./ComposeCommandExecutor"

/**
 * Renders the dynamic environment block for one provider round.
 *
 * The compose domain owns the round, so it decides when a snapshot is taken;
 * what goes into the snapshot belongs to the host-side projection.
 */
export interface ComposeEnvironmentPort {
	render(input: { readonly turnId?: string; readonly signal: AbortSignal }): Promise<string | undefined>
}

export interface ProductionComposeAdapterOptions {
	readonly payloads: TaskPayloadStore
	readonly journal: ConversationJournal
	readonly readState: () => Readonly<TaskState>
	readonly environment?: ComposeEnvironmentPort
}

/** Materializes admitted intake entries into one immutable provider draft. */
export class ProductionComposeAdapter implements ComposePort {
	constructor(private readonly options: ProductionComposeAdapterOptions) {}

	async compose(input: ComposeRoundInput): Promise<ComposeRoundResult> {
		if (input.signal.aborted) throw input.signal.reason
		const state = this.options.readState()
		const entries = [...state.intake.queued, ...state.intake.background, ...state.intake.coTask].filter((entry) =>
			input.admittedEntryIds.includes(entry.entryId),
		)
		if (entries.length !== input.admittedEntryIds.length) throw new Error("AdmittedIntakeEntryMissing")

		for (const entry of entries) {
			await this.options.journal.append({
				operationId: `intake:${entry.source}:${entry.entryId}`,
				payloadRef: entry.payloadRef,
				source: "intake",
				causation: { generation: state.generation, turnId: input.turnId },
			})
		}
		if (input.signal.aborted) throw input.signal.reason
		await this.appendEnvironment(input, state.revision, state.generation)
		const projection = await this.options.journal.project()
		const envelope: ProviderDraftEnvelope = {
			kind: "provider_draft",
			admittedEntryIds: input.admittedEntryIds,
			inputPayloadRefs: entries.map((entry) => entry.payloadRef),
			journalPayloadRefs: projection.visibleMessages.flatMap((entry) => (entry.payloadRef ? [entry.payloadRef] : [])),
			turnId: input.turnId,
		}
		for (const payloadRef of envelope.inputPayloadRefs) {
			decodeTaskPayload(await this.options.payloads.read(payloadRef))
		}
		return { draftRef: await this.options.payloads.put(encodeTaskPayload(envelope)) }
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

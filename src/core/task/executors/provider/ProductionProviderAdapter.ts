import type { ProviderTurnPlan } from "../../kernel"
import type { TaskPayloadStore } from "../../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type {
	ProviderBlockOutput,
	ProviderDraftEnvelope,
	ProviderFinalEnvelope,
	ProviderPartialEnvelope,
} from "../../stores/payload/TaskPayloadEnvelopes"
import type { ProviderExecutionChunk, ProviderExecutionInput, ProviderExecutionPort } from "./ProviderCommandExecutor"
import type { ProviderRetryNotice } from "./service/ProviderRequestReport"

export type ProductionProviderChunk =
	| {
			readonly kind: "partial"
			readonly transientId: string
			readonly text: string
			readonly projection?: Readonly<Record<string, unknown>>
	  }
	| { readonly kind: "usage"; readonly usage: Readonly<Record<string, number>> }
	/** The request failed before its first chunk and will be sent again. */
	| { readonly kind: "retry"; readonly notice: ProviderRetryNotice }
	| {
			readonly kind: "final"
			readonly turnId: string
			readonly transientId?: string
			readonly text?: string
			readonly content?: ProviderFinalEnvelope["content"]
			readonly mode: ProviderTurnPlan["mode"]
			readonly blocks: readonly ProviderBlockOutput[]
	  }

export interface ProductionProviderService {
	start(input: {
		readonly draftRef: string
		readonly draft: ProviderDraftEnvelope
		readonly turnId?: string
		readonly signal: AbortSignal
	}): AsyncIterable<ProductionProviderChunk>
	recordUsage?(usage: Readonly<Record<string, number>>): void
}

export interface ProductionProviderAdapterOptions {
	readonly payloads: TaskPayloadStore
	readonly service: ProductionProviderService
}

/** Translates provider values to immutable payload refs consumed by the kernel. */
export class ProductionProviderAdapter implements ProviderExecutionPort {
	constructor(private readonly options: ProductionProviderAdapterOptions) {}

	async *start(input: ProviderExecutionInput): AsyncIterable<ProviderExecutionChunk> {
		const draft = decodeTaskPayload<ProviderDraftEnvelope>(await this.options.payloads.read(input.draftRef))
		if (draft.kind !== "provider_draft") throw new Error("InvalidProviderDraftPayload")
		for await (const chunk of this.options.service.start({ ...input, draft })) {
			if (input.signal.aborted) return
			if (chunk.kind === "usage" || chunk.kind === "retry") {
				yield chunk
				continue
			}
			if (chunk.kind === "partial") {
				const payload: ProviderPartialEnvelope = { kind: "provider_partial", text: chunk.text }
				yield {
					kind: "partial",
					transientId: chunk.transientId,
					payloadRef: await this.options.payloads.put(encodeTaskPayload(payload)),
					// Carried beside the ref so presentation does not have to read the
					// payload store back on every streamed chunk.
					text: chunk.text,
					...(chunk.projection === undefined ? {} : { projection: chunk.projection }),
				}
				continue
			}
			const blocks = await Promise.all(
				chunk.blocks.map(async (block) => ({
					blockId: block.blockId,
					attempt: block.attempt,
					index: block.index,
					lanes: block.lanes,
					turnEnding: block.turnEnding,
					invocationRef: await this.options.payloads.put(encodeTaskPayload(block.invocation)),
					approval: block.approval,
				})),
			)
			const turnPlan: ProviderTurnPlan = { mode: chunk.mode, blocks }
			const finalPayload: ProviderFinalEnvelope = {
				kind: "provider_final",
				...(chunk.text === undefined ? {} : { text: chunk.text }),
				...(chunk.content === undefined ? {} : { content: chunk.content }),
				turnPlan,
			}
			yield {
				kind: "final",
				turnId: chunk.turnId,
				...(chunk.transientId === undefined ? {} : { transientId: chunk.transientId }),
				payloadRef: await this.options.payloads.put(encodeTaskPayload(finalPayload)),
				...(chunk.text === undefined ? {} : { text: chunk.text }),
				turnPlan,
			}
		}
	}

	recordUsage(usage: Readonly<Record<string, number>>): void {
		this.options.service.recordUsage?.(usage)
	}
}

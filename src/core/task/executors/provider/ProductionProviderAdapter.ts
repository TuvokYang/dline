import type { ProviderTurnPlan } from "../../kernel"
import type { TaskPayloadStore } from "../../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type {
    ProviderBlockOutput,
    ProviderDraftEnvelope,
    ProviderFinalEnvelope,
    ProviderInterruptedEnvelope,
} from "../../stores/payload/TaskPayloadEnvelopes"
import type { ProviderExecutionChunk, ProviderExecutionInput, ProviderExecutionPort } from "./ProviderCommandExecutor"
import type { ProviderReceivingEstimate, ProviderRetryNotice } from "./service/ProviderRequestReport"

export type ProductionProviderChunk =
    | {
          readonly kind: "partial"
          readonly transientId: string
          readonly text: string
          /** The reasoning streamed so far, shown while the model thinks. */
          readonly reasoning?: string
          readonly projection?: Readonly<Record<string, unknown>>
      }
    | { readonly kind: "usage"; readonly usage: Readonly<Record<string, number>> }
    /** How much the streaming response occupies so far. */
    | ({ readonly kind: "receiving" } & ProviderReceivingEstimate)
    /** The request failed before its first chunk and will be sent again. */
    | { readonly kind: "retry"; readonly notice: ProviderRetryNotice }
    /** The user stopped the reply; what it already said is kept, and nothing it was still calling runs. */
    | {
          readonly kind: "interrupted"
          readonly transientId: string
          readonly text: string
          readonly reasoning?: string
          readonly content: ProviderInterruptedEnvelope["content"]
      }
    | {
          readonly kind: "final"
          readonly turnId: string
          readonly transientId?: string
          readonly text?: string
          readonly reasoning?: string
          readonly content?: ProviderFinalEnvelope["content"]
          readonly modelInfo?: ProviderFinalEnvelope["modelInfo"]
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

    async recoverFinal(payloadRef: string) {
        const payload = decodeTaskPayload<ProviderFinalEnvelope>(await this.options.payloads.read(payloadRef))
        if (payload.kind !== "provider_final") throw new Error("InvalidProviderFinalPayload")
        return { turnPlan: payload.turnPlan }
    }

    async *start(input: ProviderExecutionInput): AsyncIterable<ProviderExecutionChunk> {
        const draft = decodeTaskPayload<ProviderDraftEnvelope>(await this.options.payloads.read(input.draftRef))
        if (draft.kind !== "provider_draft") throw new Error("InvalidProviderDraftPayload")
        for await (const chunk of this.options.service.start({ ...input, draft })) {
            if (chunk.kind === "interrupted") {
                // Produced only after the stop, so it is the one chunk the stop lets through.
                const payload: ProviderInterruptedEnvelope = { kind: "provider_interrupted", content: chunk.content }
                yield {
                    kind: "interrupted",
                    transientId: chunk.transientId,
                    payloadRef: await this.options.payloads.put(encodeTaskPayload(payload)),
                    text: chunk.text,
                    ...(chunk.reasoning === undefined ? {} : { reasoning: chunk.reasoning }),
                }
                continue
            }
            // Drained rather than left: returning here would close the service before
            // it reports what the stopped reply had already said.
            if (input.signal.aborted) continue
            if (chunk.kind === "usage" || chunk.kind === "retry" || chunk.kind === "receiving") {
                yield chunk
                continue
            }
            if (chunk.kind === "partial") {
                yield {
                    kind: "partial",
                    transientId: chunk.transientId,
                    // Partial content stays in the transient plane; only final or
                    // interrupted replies receive durable payload references.
                    text: chunk.text,
                    ...(chunk.reasoning === undefined ? {} : { reasoning: chunk.reasoning }),
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
                ...(chunk.modelInfo === undefined ? {} : { modelInfo: chunk.modelInfo }),
                turnPlan,
            }
            yield {
                kind: "final",
                turnId: chunk.turnId,
                ...(chunk.transientId === undefined ? {} : { transientId: chunk.transientId }),
                payloadRef: await this.options.payloads.put(encodeTaskPayload(finalPayload)),
                ...(chunk.text === undefined ? {} : { text: chunk.text }),
                ...(chunk.reasoning === undefined ? {} : { reasoning: chunk.reasoning }),
                turnPlan,
            }
        }
    }

    recordUsage(usage: Readonly<Record<string, number>>): void {
        this.options.service.recordUsage?.(usage)
    }
}

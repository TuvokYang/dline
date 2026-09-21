import type { TaskPayloadStore } from "../../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { CompactionContextEnvelope, CompactionResultEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import type { CompactionExecutionInput, CompactionPort } from "./CompactionCommandExecutor"

export interface ProductionCompactionService {
	run(input: {
		readonly compactionId: string
		readonly attempt: string
		readonly context: unknown
		readonly signal: AbortSignal
		readonly publish: CompactionExecutionInput["publish"]
	}): Promise<unknown>
}

export interface ProductionCompactionAdapterOptions {
	readonly payloads: TaskPayloadStore
	readonly service: ProductionCompactionService
}

/** Owns compaction payload decoding and result materialization around the host service. */
export class ProductionCompactionAdapter implements CompactionPort {
	constructor(private readonly options: ProductionCompactionAdapterOptions) {}

	async run(input: CompactionExecutionInput): Promise<{ readonly resultRef: string }> {
		if (input.signal.aborted) throw input.signal.reason
		const context = decodeTaskPayload<CompactionContextEnvelope>(await this.options.payloads.read(input.contextRef))
		if (context.kind !== "compaction_context") throw new Error("InvalidCompactionContextPayload")
		const result = await this.options.service.run({ ...input, context: context.context })
		if (input.signal.aborted) throw input.signal.reason
		const envelope: CompactionResultEnvelope = { kind: "compaction_result", result }
		return { resultRef: await this.options.payloads.put(encodeTaskPayload(envelope)) }
	}
}

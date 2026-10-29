import type {
    ImageGenerationAdapter,
    ImageGenerationErrorDetails,
    ImageGenerationEvent,
    ImageGenerationExecutionContext,
    ImageGenerationRequest,
    ImageProviderOutput,
} from "../contracts"

export interface FakeImageGenerationAdapterOptions {
    outputs: ImageProviderOutput[]
    previewOutputs?: ImageProviderOutput[]
    failure?: ImageGenerationErrorDetails
    now?: () => number
}

export class FakeImageGenerationAdapter implements ImageGenerationAdapter {
    private readonly options: FakeImageGenerationAdapterOptions

    constructor(options: FakeImageGenerationAdapterOptions) {
        this.options = options
    }

    async *generate(
        request: ImageGenerationRequest,
        context: ImageGenerationExecutionContext,
    ): AsyncIterable<ImageGenerationEvent> {
        const now = this.options.now ?? Date.now
        yield { type: "queued", requestId: request.requestId, timestampMs: now() }
        if (context.signal.aborted) {
            yield {
                type: "cancelled",
                requestId: request.requestId,
                timestampMs: now(),
                reason: this.getAbortReason(context.signal),
            }
            return
        }

        yield {
            type: "started",
            requestId: request.requestId,
            timestampMs: now(),
            providerId: request.providerId,
            modelId: request.modelId,
        }
        if (context.signal.aborted) {
            yield {
                type: "cancelled",
                requestId: request.requestId,
                timestampMs: now(),
                reason: this.getAbortReason(context.signal),
            }
            return
        }

        if (this.options.previewOutputs) {
            yield {
                type: "preview",
                requestId: request.requestId,
                timestampMs: now(),
                sequence: 0,
                outputs: this.options.previewOutputs,
            }
        }
        if (this.options.failure) {
            yield {
                type: "failed",
                requestId: request.requestId,
                timestampMs: now(),
                error: this.options.failure,
            }
            return
        }
        if (context.signal.aborted) {
            yield {
                type: "cancelled",
                requestId: request.requestId,
                timestampMs: now(),
                reason: this.getAbortReason(context.signal),
            }
            return
        }

        yield {
            type: "completed",
            requestId: request.requestId,
            timestampMs: now(),
            outputs: this.options.outputs,
            usage: {
                imageCount: this.options.outputs.length,
                totalOutputBytes: this.options.outputs.reduce((total, output) => total + this.getOutputByteLength(output), 0),
            },
        }
    }

    private getAbortReason(signal: AbortSignal): string {
        if (typeof signal.reason === "string" && signal.reason) return signal.reason
        if (signal.reason instanceof Error && signal.reason.message) return signal.reason.message
        return "cancelled"
    }

    private getOutputByteLength(output: ImageProviderOutput): number {
        switch (output.source.kind) {
            case "bytes":
                return output.source.bytes.byteLength
            case "base64": {
                const normalized = output.source.data.replace(/\s/g, "").replace(/=+$/, "")
                return Math.floor((normalized.length * 3) / 4)
            }
            case "url":
                return 0
        }
    }
}

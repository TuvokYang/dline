import type { EnvStage } from "./types"

export type PromptEnvErrorReason = "stage-regression" | "undeclared-key" | "disallowed-stage" | "invalid-value"

export interface PromptEnvErrorData {
    readonly templateId: string
    readonly key?: string
    readonly stage: EnvStage
    readonly source: string
    readonly reason: PromptEnvErrorReason
}

/** Reports invalid prompt environment writes with structured source context. */
export class PromptEnvError extends Error {
    public readonly templateId: string
    public readonly key?: string
    public readonly stage: EnvStage
    public readonly source: string
    public readonly reason: PromptEnvErrorReason

    /**
     * Creates a structured prompt environment error.
     *
     * @param data Invalid environment write details.
     */
    public constructor(data: PromptEnvErrorData) {
        super(PromptEnvError.formatMessage(data))
        this.name = "PromptEnvError"
        this.templateId = data.templateId
        this.key = data.key
        this.stage = data.stage
        this.source = data.source
        this.reason = data.reason
    }

    /**
     * Formats a deterministic error message for logs and tests.
     *
     * @param data Invalid environment write details.
     * @returns A deterministic error message.
     */
    private static formatMessage(data: PromptEnvErrorData): string {
        const keyText = data.key ? ` for key ${data.key}` : ""
        return `Prompt env ${data.reason}${keyText} in ${data.templateId} at ${data.stage} from ${data.source}`
    }
}

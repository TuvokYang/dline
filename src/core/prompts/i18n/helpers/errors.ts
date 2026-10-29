import type { PromptDomain } from "./types"

export type PromptPackErrorReason =
    | "duplicate-module"
    | "empty-module"
    | "empty-key"
    | "empty-prompt"
    | "contract-key-mismatch"
    | "missing-contract"
    | "unused-contract-variable"

export interface PromptPackErrorData {
    readonly reason: PromptPackErrorReason
    readonly group?: PromptDomain
    readonly module?: string
    readonly key?: string
    readonly source?: string
}

/** Reports invalid static prompt descriptors and pack composition. */
export class PromptPackError extends Error {
    public readonly reason: PromptPackErrorReason
    public readonly group?: PromptDomain
    public readonly module?: string
    public readonly key?: string
    public readonly source?: string

    /**
     * Creates a structured prompt pack error.
     *
     * @param data Invalid descriptor or pack details.
     */
    public constructor(data: PromptPackErrorData) {
        super(PromptPackError.formatMessage(data))
        this.name = "PromptPackError"
        this.reason = data.reason
        this.group = data.group
        this.module = data.module
        this.key = data.key
        this.source = data.source
    }

    /**
     * Formats a deterministic prompt pack error message.
     *
     * @param data Invalid descriptor or pack details.
     * @returns A deterministic error message.
     */
    private static formatMessage(data: PromptPackErrorData): string {
        const parts: string[] = [data.reason]
        if (data.group) {
            parts.push(`group=${data.group}`)
        }
        if (data.module) {
            parts.push(`module=${data.module}`)
        }
        if (data.key) {
            parts.push(`key=${data.key}`)
        }
        if (data.source) {
            parts.push(`source=${data.source}`)
        }
        return `Prompt pack ${parts.join(" ")}`
    }
}

export type OutputLimitProtocol = "openai_chat" | "openai_responses" | "anthropic_messages"

/** Raised when a provider terminates generation because the request output limit was exhausted. */
export class OutputLimitExceededError extends Error {
    readonly code = "output_limit_exceeded"

    constructor(
        readonly protocol: OutputLimitProtocol,
        readonly reason: string,
        options?: ErrorOptions,
    ) {
        super(`Provider output limit exceeded (${protocol}: ${reason})`, options)
        this.name = "OutputLimitExceededError"
    }
}

export function getOpenAIChatOutputLimitError(finishReason: unknown): OutputLimitExceededError | undefined {
    return finishReason === "length" ? new OutputLimitExceededError("openai_chat", "length") : undefined
}

export function isOutputLimitExceededError(error: unknown): error is OutputLimitExceededError {
    return error instanceof OutputLimitExceededError
}

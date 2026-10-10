/**
 * A provider request failure together with the error the chat shows for it.
 *
 * The kernel only records a sanitized failure kind, because that text can
 * reach the conversation. The chat needs the provider's own explanation (an
 * HTTP 403 naming the invalid Profile, a quota message), which only the
 * provider domain can describe, so it travels beside the failure instead.
 */
export class ProviderFailure extends Error {
    /**
     * @param cause The original failure; its name stays the failure kind.
     * @param presentation The serialized error body the chat's error box renders.
     */
    constructor(
        cause: unknown,
        readonly presentation: string,
    ) {
        super(cause instanceof Error ? cause.message : String(cause), { cause })
        this.name = cause instanceof Error ? cause.name : "ProviderFailure"
    }
}

/** The chat presentation a failure carries, if the provider described it. */
export function presentationOf(error: unknown): string | undefined {
    return error instanceof ProviderFailure ? error.presentation : undefined
}

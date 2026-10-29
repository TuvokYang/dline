export const DEFAULT_OPENAI_RESPONSES_STREAM_IDLE_TIMEOUT_SECONDS = 120

/**
 * Resolve the OpenAI Responses stream idle timeout while preserving compatibility
 * with profiles created before the setting existed.
 *
 * @param value Configured timeout in seconds.
 * @returns A positive integer timeout in seconds.
 */
export function normalizeOpenAIResponsesStreamIdleTimeoutSeconds(value: number | undefined): number {
    if (!Number.isSafeInteger(value) || value === undefined || value <= 0) {
        return DEFAULT_OPENAI_RESPONSES_STREAM_IDLE_TIMEOUT_SECONDS
    }
    return value
}

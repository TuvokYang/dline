import crypto from "crypto"

/**
 * Compute a stable SHA-256 hash for prompt cache content.
 *
 * @param content Text content to hash.
 * @returns SHA-256 hash with an explicit algorithm prefix.
 */
export function hashPromptContent(content: string): string {
    return `sha256:${hashPromptContentHex(content)}`
}

/**
 * Compute a raw SHA-256 hex digest for prompt cache content.
 *
 * The prefixed form `hashPromptContent` is used for persisted hash comparisons;
 * this raw form fits API fields that cap key length (e.g. OpenAI's
 * `prompt_cache_key` allows at most 64 characters, exactly one SHA-256 hex).
 *
 * @param content Text content to hash.
 * @returns 64-character lowercase SHA-256 hex digest.
 */
export function hashPromptContentHex(content: string): string {
    return crypto.createHash("sha256").update(content, "utf8").digest("hex")
}

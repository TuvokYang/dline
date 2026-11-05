/**
 * Stable identities for emitted facts.
 *
 * `src/shared` also ships to the Webview, where `node:*` modules do not exist, so this
 * module imports no Node builtin and the fingerprint is a small self-contained hash
 * rather than SHA-256. It exists to tell two API keys apart in a metrics row, never to
 * secure them; both FNV-1a passes are combined so one 32-bit collision is not enough to
 * make two keys look identical.
 */

/** Placeholder for a request that carried no API key at all. */
export const EMPTY_KEY_FINGERPRINT = ""

/**
 * A short, stable, non-reversible fingerprint of an API key.
 *
 * Only the fingerprint may ever be stored or logged; the key itself never leaves the
 * Profile store. Callers pass `undefined` or an empty string for "no key", which maps
 * to {@link EMPTY_KEY_FINGERPRINT} rather than a hash of the empty string, so "absent"
 * and "present but empty" do not become indistinguishable by accident.
 */
export function usageKeyFingerprint(apiKey: string | undefined | null): string {
    if (!apiKey) return EMPTY_KEY_FINGERPRINT
    return fnv1a32(apiKey, 0x811c9dc5).toString(16).padStart(8, "0") + fnv1a32(apiKey, 0x01000193).toString(16).padStart(8, "0")
}

/**
 * FNV-1a over UTF-16 code units.
 *
 * Two different seeds are combined by {@link usageKeyFingerprint} so a single 32-bit
 * collision does not make two keys look identical. This is not a cryptographic hash
 * and must never be used to verify a secret.
 */
function fnv1a32(value: string, seed: number): number {
    let hash = seed >>> 0
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash
}

/**
 * The deduplication identity of one emitted fact.
 *
 * It is derived from the fact's own identity so that a retried batch, a duplicated
 * terminal callback or a replayed canonical snapshot produce the same id and are
 * counted once. A new opening does not need to remember a sent high-water mark: the
 * same fact keeps the same id.
 */
export type CanonicalEventIdKind = "usage" | "provider" | "execution"

/** `usage:<roundId>` — one attempt's final usage snapshot. */
export function usageEventId(roundId: string): string {
    return canonicalEventId("usage", roundId)
}

/** `provider:<roundId>` — one attempt's terminal performance fact. */
export function providerPerformanceEventId(roundId: string): string {
    return canonicalEventId("provider", roundId)
}

/** `execution:<executionId>` — one logical execution's performance fact. */
export function executionPerformanceEventId(executionId: string): string {
    return canonicalEventId("execution", executionId)
}

function canonicalEventId(kind: CanonicalEventIdKind, identity: string): string {
    if (identity.length === 0) throw new Error(`A ${kind} event id requires a non-empty identity`)
    return `${kind}:${identity}`
}

/**
 * The receiver's idempotency key.
 *
 * The Task is part of the key because the same round identity is only unique within
 * one Task's instance storage; two Tasks may legitimately use overlapping ids.
 */
export function idempotencyKey(taskId: string, eventId: string): string {
    if (taskId.length === 0 || eventId.length === 0) throw new Error("An idempotency key requires a task id and an event id")
    // The separator must not be NUL: SQLite stops reading a TEXT value at the first
    // U+0000, so a NUL-joined key would silently lose everything after the task id and
    // make every event of one Task share a single receipt.
    return `${taskId}::${eventId}`
}

/** The parts of an idempotency key, for a store that writes the two columns apart. */
export interface IdempotencyParts {
    readonly taskId: string
    readonly eventId: string
}

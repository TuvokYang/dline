/**
 * Diagnostic bundle contract.
 *
 * A bundle is what a user hands to a maintainer after a hang or a CPU spike.
 * It therefore has to be complete enough to diagnose and provably free of
 * anything the user typed, a tool produced, or a file contained.
 *
 * The contract lives apart from the writer so that the privacy rules can be
 * asserted without constructing a zip: the entry catalogue, the redaction
 * predicate, and the checksum shape are all decidable from data.
 */

/** Entries a default bundle always contains, in listing order. */
export const BUNDLE_ENTRIES = {
    manifest: "manifest.json",
    events: "events.jsonl",
    diagnoses: "diagnoses.json",
    scenario: "scenario.json",
    environment: "environment.json",
    checksums: "checksums.json",
} as const

export type BundleEntryName = (typeof BUNDLE_ENTRIES)[keyof typeof BUNDLE_ENTRIES]

/**
 * Name of any entry the archive may contain.
 *
 * Consented raw artifacts are named by the user's file, so the manifest cannot
 * be restricted to the fixed catalogue. Keeping the wider type explicit is
 * better than casting an arbitrary string into `BundleEntryName` at the one
 * call site that knows it is lying.
 */
export type BundleEntryListing = BundleEntryName | string

/** Entry names in the order they are written into the archive. */
export function defaultBundleEntryNames(): readonly BundleEntryName[] {
    return Object.values(BUNDLE_ENTRIES)
}

/**
 * Attribute and field names that must never appear in a bundle.
 *
 * This is intentionally broader than the runtime attribute policy: a bundle
 * also carries diagnoses and scenario steps, which are assembled from several
 * producers and are not individually policed at record time.
 */
const FORBIDDEN_FIELD_NAMES = new Set([
    "accesskey",
    "accesstoken",
    "apikey",
    "apitoken",
    "accesskeyid",
    "secretkey",
    "sessionkey",
    "bearer",
    "signature",
    "apisecret",
    "args",
    "arguments",
    "authorization",
    "bearer",
    "body",
    "clientsecret",
    "cmd",
    "command",
    "commandline",
    "completion",
    "content",
    "cookie",
    "credential",
    "credentials",
    "diff",
    "directory",
    "filecontent",
    "filepath",
    "folder",
    "idtoken",
    "input",
    "message",
    "output",
    "pairingcode",
    "params",
    "passphrase",
    "password",
    "patch",
    "path",
    "payload",
    "privatekey",
    "prompt",
    "proxyauthorization",
    "query",
    "refreshtoken",
    "response",
    "result",
    "root",
    "secret",
    "secretkey",
    "sessiontoken",
    "setcookie",
    "stderr",
    "stdin",
    "stdout",
    "systemprompt",
    "text",
    "title",
    "token",
    "xapikey",
])

/**
 * Word fragments that make any containing field name a credential.
 *
 * Exact-name matching cannot see `secretAccessKey` or `xAuthToken`, and the
 * producer of a bundle entry is not obliged to use the names in the list
 * above. Substring matching accepts a few false positives — a redacted field
 * costs diagnostic detail, a leaked one costs a credential.
 */
const FORBIDDEN_FIELD_FRAGMENTS: readonly string[] = [
    "apikey",
    "accesstoken",
    "authtoken",
    "authorization",
    "clientsecret",
    "credential",
    "idtoken",
    "passphrase",
    "password",
    "privatekey",
    "refreshtoken",
    "secret",
    "sessiontoken",
    // Absolute paths name the user, their disk layout and their projects, so
    // they are personal data even though they are not credentials. Producers
    // that need a correlatable location must record a fingerprint instead.
    "directory",
    "filepath",
    "filename",
    "path",
    "workspace",
]

function normalizeFieldName(name: string): string {
    return name.toLowerCase().replaceAll(/[-_.\s]/g, "")
}

/** True when a field name denotes content or a credential. */
export function isForbiddenBundleField(name: string): boolean {
    const normalized = normalizeFieldName(name)
    if (FORBIDDEN_FIELD_NAMES.has(normalized)) return true
    return FORBIDDEN_FIELD_FRAGMENTS.some((fragment) => normalized.includes(fragment))
}

/**
 * Keys that must never survive into a serialized bundle entry.
 *
 * Even with a null-prototype accumulator, keeping `__proto__` as an own key
 * means a later `Object.assign` into a normal object would re-arm prototype
 * pollution in whatever tool reads the bundle.
 */
const UNSAFE_STRUCTURAL_KEYS = new Set(["__proto__", "constructor", "prototype"])

/** Markers written in place of a value the redactor refused to serialize. */
export const REDACTION_MARKERS = {
    circular: "[circular]",
    depthLimit: "[depth-limit]",
    unsupported: "[unsupported]",
    secret: "[secret]",
    /**
     * Field kept, but emptied because its name is on the denylist.
     *
     * Deleting the key would make a reader unable to tell whether the producer
     * never recorded the field or the exporter removed it.
     */
    forbidden: "[forbidden-field]",
} as const

/** Maximum object nesting the redactor descends before bailing out. */
const MAX_REDACTION_DEPTH = 8

/**
 * Patterns that indicate a credential embedded in an otherwise allowed value.
 *
 * Key-based redaction cannot catch a token pasted into a field named
 * `operation`, so retained strings are scrubbed as well. The patterns target
 * credential shapes rather than English words, so ordinary diagnostic text
 * survives.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
    // `Authorization: Bearer <token>`, `api-key = <token>`, `password: <token>`.
    // A separator is required so ordinary prose ("password reset email sent")
    // keeps its diagnostic value; the optional scheme word is consumed with the
    // value so a `Bearer` prefix cannot leave the credential itself behind.
    // The value stops at a delimiter rather than at whitespace: a greedy `\S+`
    // would swallow `&page=2` and destroy the surrounding diagnostic context.
    /\b(?:authorization|api[\s_-]?key|api[\s_-]?token|access[\s_-]?key[\s_-]?id|access[\s_-]?token|refresh[\s_-]?token|id[\s_-]?token|client[\s_-]?secret|private[\s_-]?key|passphrase|password|secret|credential|cookie|pairing[\s_-]?code)\b\s*[:=]\s*(?:bearer|basic|token)?\s*[^\s,;&"'`)\]}]+/gi,
    // A bare `Bearer <token>` header value, which carries no separator.
    /\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
    // The same assignment shape with a quoted value, as `.env` files and shell
    // transcripts write it. The unquoted pattern above stops at the opening
    // quote, so without this the credential itself would survive.
    /\b(?:authorization|api[\s_-]?key|api[\s_-]?token|access[\s_-]?key[\s_-]?id|access[\s_-]?token|refresh[\s_-]?token|id[\s_-]?token|client[\s_-]?secret|private[\s_-]?key|passphrase|password|secret|credential|cookie|pairing[\s_-]?code)\b\s*[:=]\s*(['"`])[^'"`\n]*\1/gi,
    // Credentials carried in a URL query, up to the next parameter.
    /[?&](?:access_token|api_key|apikey|auth|code|id_token|key|password|refresh_token|secret|session|sig|signature|token)=[^&\s]+/gi,
    /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
    /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
]

/**
 * Replace credential-shaped substrings inside a retained string.
 *
 * Exported so raw artifacts can reuse the same rules as structured entries.
 */
export function scrubSecretText(value: string): string {
    let scrubbed = value
    for (const pattern of SECRET_VALUE_PATTERNS) {
        pattern.lastIndex = 0
        scrubbed = scrubbed.replace(pattern, REDACTION_MARKERS.secret)
    }
    return scrubbed
}

/** True for `{}` and `Object.create(null)`, false for every other object. */
function isPlainObject(value: object): boolean {
    const prototype = Object.getPrototypeOf(value)
    return prototype === null || prototype === Object.prototype
}

/** Non-object values, scrubbed and screened for non-JSON types. */
function redactPrimitive(value: unknown): unknown {
    if (typeof value === "string") return scrubSecretText(value)
    if (typeof value === "number") return Number.isFinite(value) ? value : REDACTION_MARKERS.unsupported
    if (typeof value === "boolean") return value
    if (value === null) return null
    // Functions, symbols, bigint and undefined are not representable in a
    // bundle, and a retained function would let `toJSON` re-inject data during
    // a later stringify.
    return REDACTION_MARKERS.unsupported
}

function redactValue(value: unknown, depth: number, seen: Set<object>): unknown {
    if (typeof value !== "object" || value === null) {
        return redactPrimitive(value)
    }
    if (depth >= MAX_REDACTION_DEPTH) {
        return REDACTION_MARKERS.depthLimit
    }
    if (seen.has(value)) {
        return REDACTION_MARKERS.circular
    }

    seen.add(value)
    try {
        if (Array.isArray(value)) {
            return value.map((item) => redactValue(item, depth + 1, seen))
        }
        if (value instanceof Date) {
            return Number.isFinite(value.getTime()) ? value.toISOString() : REDACTION_MARKERS.unsupported
        }
        if (!isPlainObject(value)) {
            // Map, Set, typed arrays, RegExp, Promise, class instances: none are
            // JSON round-trippable, and serializing them as `{}` would hide the
            // fact that evidence was dropped.
            return REDACTION_MARKERS.unsupported
        }

        // A null-prototype accumulator keeps `__proto__`, `constructor` and
        // `toJSON` keys in the source from mutating the output or surviving
        // into a later JSON.stringify.
        const result = Object.create(null) as Record<string, unknown>
        for (const key of Object.keys(value)) {
            if (UNSAFE_STRUCTURAL_KEYS.has(key)) continue
            if (isForbiddenBundleField(key)) {
                // Keep the key with a marker instead of deleting it. A reader
                // otherwise cannot tell whether the producer never recorded the
                // field or the exporter removed evidence, and that difference
                // matters when a bundle is the only account of an incident.
                result[key] = REDACTION_MARKERS.forbidden
                continue
            }
            result[key] = redactValue((value as Record<string, unknown>)[key], depth + 1, seen)
        }
        return { ...result }
    } finally {
        seen.delete(value)
    }
}

/**
 * Remove forbidden fields from an arbitrary JSON-like value.
 *
 * Redaction is structural first: a value is dropped because of the key that
 * carries it, so a producer cannot smuggle content through by changing its
 * formatting. Retained strings are then scrubbed for credential shapes, since
 * a key-only rule cannot see a token pasted into an allowed field.
 *
 * Anything that is not plain JSON (functions, Map/Set, typed arrays, cycles,
 * over-deep nesting) becomes an explicit marker instead of vanishing, so a
 * reader can tell dropped evidence apart from absent evidence.
 */
export function redactBundleValue(value: unknown): unknown {
    return redactValue(value, 0, new Set<object>())
}

/** Bundle-level identity written into `manifest.json`. */
export interface BundleManifest {
    readonly schemaVersion: 1
    readonly sessionId: string
    readonly createdAt: number
    readonly extensionVersion: string
    readonly buildId?: string
    readonly entries: readonly BundleEntryListing[]
    readonly eventCount: number
    readonly diagnosisCount: number
    /** True when the user explicitly opted into extra raw artifacts. */
    readonly includesRawArtifacts: boolean
}

/** SHA-256 of every entry, keyed by entry name. */
export type BundleChecksums = Readonly<Record<string, string>>

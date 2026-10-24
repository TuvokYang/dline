/**
 * Fact identity shared by canonical Usage aggregation.
 *
 * A fact is identified by the tuple `(role, provider, model, custom)`. The tuple
 * is what makes a fact deletable and sliceable: dropping one model must remove
 * exactly the facts that model produced, so two different inputs can never
 * normalize to the same identity.
 *
 * That last property is why normalization never substitutes characters. The
 * client contract forbids replacing them with `_` (`usage-client-interface.md`
 * §4.3): `openai/gpt-4o` and `openai:gpt-4o` would both become `openai_gpt-4o`,
 * silently merging two distinct models into one fact and making a later
 * per-model deletion wrong.
 *
 * A name this build cannot state is reported as `_unknown` rather than being
 * dropped or repaired. It is an explicit fact a reader can query and delete, so
 * the request and token totals stay complete while the identity stays honest.
 */

/** Bounded catalog identifier; the wire pattern, not a free-form role name. */
export const USAGE_ROLE_PATTERN = /^[a-z][a-z0-9_.-]{0,31}$/u
export const USAGE_PROVIDER_PATTERN = /^[a-z0-9_-]{1,32}$/u
export const USAGE_MODEL_PATTERN = /^[a-z0-9_.-]{1,64}$/u

export const USAGE_PROVIDER_MAX_LENGTH = 32
export const USAGE_MODEL_MAX_LENGTH = 64

/**
 * The explicit "not reported" bucket for a provider or a model.
 *
 * It is a real fact identity, not a remainder: a reader can group, filter and
 * delete it. It is deliberately not `_custom` and not `_other`, which name the
 * folding placeholders the contract forbids.
 */
export const UNKNOWN_USAGE_ID = "_unknown"

/** Identities a client must never send, because they fold distinct models together. */
export const FORBIDDEN_USAGE_IDS: ReadonlySet<string> = new Set(["_custom", "_other"])

/**
 * The role catalog this client registers.
 *
 * Only roles a producer can actually report appear here. `other` is the
 * catch-all the settlement port maps anything unrecognised to, and it is
 * registered for the same reason: the client must be able to name every
 * generation it runs.
 *
 * `reviewer` is deliberately absent. The wire allows it, but this client has no
 * separate reviewer execution path: every reviewer is a subagent and therefore
 * reports `subagent`. Registering a role nothing can produce would let a reader
 * conclude the client reports reviewer generations it never runs, so the value
 * returns only when a dedicated path exists.
 */
export const USAGE_ROLE_CATALOG = ["task", "subagent", "compaction", "other"] as const
export type UsageRole = (typeof USAGE_ROLE_CATALOG)[number]
const ROLE_CATALOG: ReadonlySet<string> = new Set<string>(USAGE_ROLE_CATALOG)

export interface UsageFactIdentity {
    readonly role: UsageRole
    readonly provider: string
    readonly model: string
    readonly custom: boolean
}

/** Why an input could not become a fact identity. */
export type UsageIdentityRejection = "role_not_registered" | "provider_forbidden" | "model_forbidden"

export type UsageIdentityResult =
    | { readonly ok: true; readonly identity: UsageFactIdentity }
    | { readonly ok: false; readonly reason: UsageIdentityRejection }

/**
 * Normalize a role by registration, never by free text.
 *
 * A role is a catalog value; deriving one from an arbitrary string would let a
 * caller invent an unbounded identity space and break the per-batch role bound.
 */
export function normalizeRole(value: string): UsageRole | undefined {
    const role = value.trim().toLowerCase()
    return ROLE_CATALOG.has(role) ? (role as UsageRole) : undefined
}

/**
 * Normalize a provider to its wire form without repairing it.
 *
 * `trim` and `lowercase` are identity-preserving: they cannot make two distinct
 * providers collide. An unusable value becomes `_unknown` so the fact keeps its
 * totals, and the reader sees an explicitly unnamed provider instead of a
 * guessed one.
 */
export function normalizeProvider(value: string): string | undefined {
    const provider = value.trim().toLowerCase()
    if (provider.length === 0 || provider.length > USAGE_PROVIDER_MAX_LENGTH) return undefined
    if (FORBIDDEN_USAGE_IDS.has(provider)) return undefined
    return USAGE_PROVIDER_PATTERN.test(provider) ? provider : undefined
}

/**
 * Whether a value is a forbidden folding placeholder.
 *
 * A placeholder is not an unnamed identity: it claims that distinct models were
 * merged, so accepting it would let a producer smuggle a merged fact into the
 * canonical set. It is rejected rather than bucketed.
 */
function isForbiddenPlaceholder(value: string): boolean {
    return FORBIDDEN_USAGE_IDS.has(value.trim().toLowerCase())
}

/**
 * Normalize a model id to the wire form.
 *
 * A provider may use characters the wire pattern does not carry — Bedrock's
 * `my-namespace/my-custom-model`, Ollama's `qwen3:8b` — and those are real,
 * distinct models. Mapping them to `_unknown` would erase the only thing a
 * model-capability analysis needs, so they are mapped to the wire form by a
 * stable substitution instead. The mapping is deterministic, so the same model
 * always lands in the same fact.
 */
export function normalizeModel(value: string): string {
    const mapped = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/gu, "_")
        .slice(0, USAGE_MODEL_MAX_LENGTH)
    if (mapped.length === 0) return UNKNOWN_USAGE_ID
    if (FORBIDDEN_USAGE_IDS.has(mapped)) return UNKNOWN_USAGE_ID
    return USAGE_MODEL_PATTERN.test(mapped) ? mapped : UNKNOWN_USAGE_ID
}

/**
 * Build a fact identity from what the serving handler reported.
 *
 * A role is the only component that can reject the input: it is a closed
 * catalog, and an unreregistered value would break the per-batch role bound.
 * Everything else folds into `_unknown`, which preserves the totals that a
 * dropped fact would silently erase.
 */
export function resolveUsageIdentity(input: {
    readonly role: string
    readonly provider: string
    readonly model: string
    readonly custom: boolean
}): UsageIdentityResult {
    const role = normalizeRole(input.role)
    if (role === undefined) return { ok: false, reason: "role_not_registered" }

    if (isForbiddenPlaceholder(input.provider)) return { ok: false, reason: "provider_forbidden" }
    if (isForbiddenPlaceholder(input.model)) return { ok: false, reason: "model_forbidden" }

    // An unusable provider or model becomes `_unknown` rather than dropping the
    // fact: dropping would erase tokens and requests from every total, while
    // `_unknown` is one identity a reader can still group, filter and delete.
    const provider = normalizeProvider(input.provider) ?? UNKNOWN_USAGE_ID
    const model = normalizeModel(input.model)
    // `custom` claims a free-form ID ran. It stays true only when the model was
    // actually stated: `_unknown` means nothing about the ID survived, and marking
    // it custom would claim a fact the identity cannot support.
    const custom = model === UNKNOWN_USAGE_ID ? false : input.custom
    return { ok: true, identity: { role, provider, model, custom } }
}

/**
 * The local grouping key of a fact.
 *
 * `custom` is part of the key: the contract states that the same provider/model
 * under custom and non-custom selection are two facts, and an OR merge is
 * forbidden. A key that omitted it would collapse them at the first aggregation
 * step, long before any validator could notice.
 *
 * The separator is a control character that no normalized component can contain,
 * so two different tuples cannot produce the same key.
 */
export function usageFactKey(identity: UsageFactIdentity): string {
    return [identity.role, identity.provider, identity.model, identity.custom ? "1" : "0"].join("\u0000")
}

/** The `(provider, model, custom)` identity the per-batch bound counts. */
export function usageModelIdentityKey(identity: UsageFactIdentity): string {
    return [identity.provider, identity.model, identity.custom ? "1" : "0"].join("\u0000")
}

/** Whether two identities describe the same fact. */
export function sameUsageIdentity(left: UsageFactIdentity, right: UsageFactIdentity): boolean {
    return usageFactKey(left) === usageFactKey(right)
}

/**
 * Whether a role can carry a checklist.
 *
 * A subagent keeps no TODO list, so its absence is expected. Reading a missing
 * `todos` object as zero completions would make every subagent look like it
 * finished nothing, which is a different claim from "this role has no checklist".
 */
export function roleCarriesChecklist(role: UsageRole): boolean {
    return role === "task" || role === "compaction"
}

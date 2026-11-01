/**
 * Reading and writing the provider-owned half of one API Profile.
 *
 * Every Profile stores its provider settings under the provider's own key in the
 * `provider_config` oneof, but the generated shape differs between providers: an
 * entry either carries the shared base fields directly, or nests them under a
 * `model` message because it needs its own fields beside them. Consumers must not
 * each decide which of the two shapes they are looking at, so this module is the
 * one place that does.
 *
 * A field is read from the top level first, because that is where a provider
 * without a nested message keeps it. Only when the top level does not carry the
 * field does the nested `model` message answer. Writers follow the field that is
 * already present for the same reason: a value belongs to the shape that stored
 * it, and a Profile must not end up with the same field in both places.
 */

/**
 * Fields shared by every provider's configuration.
 *
 * `websocketEnabled` is included because the Responses transport selects the same
 * WebSocket-mode `ApiFormat` value the other fields are read alongside.
 */
export type ProviderConfigField =
    | "reasoning"
    | "capabilities"
    | "pricing"
    | "customModelEnabled"
    | "enableLongContext"
    | "pricingTiersEnabled"
    | "apiFormat"
    | "websocketEnabled"
    | "disabledServerTools"
    | "serviceTier"

/**
 * Read one shared configuration field from a provider config value.
 *
 * @param config Provider config lifted from a Profile, or any unknown value.
 * @param field Shared field to read.
 * @returns The stored value, or `undefined` when this config does not carry it.
 */
export function readProviderConfigField(config: unknown, field: ProviderConfigField): unknown {
    const flat = asRecord(config)
    if (!flat) return undefined
    const own = flat[field]
    if (own !== undefined) return own
    return asRecord(flat.model)?.[field]
}

/**
 * Store one shared configuration field while preserving the config's shape.
 *
 * The result is a new object: Profile updates are compared and persisted as whole
 * replacements, so mutating the value handed in would hide the change from the
 * diff that decides whether a write is needed.
 *
 * @param config Provider config to update.
 * @param field Shared field to store.
 * @param value New value for the field.
 * @returns A copy carrying the new value in the shape that already owns it.
 */
export function withProviderConfigField<T extends object>(config: T, field: ProviderConfigField, value: unknown): T {
    const flat = config as Record<string, unknown>
    const nested = asRecord(flat.model)
    // Generated configs declare an optional model slot even before it is populated.
    if (flat[field] !== undefined || !Object.hasOwn(flat, "model")) {
        return { ...config, [field]: value }
    }
    return { ...config, model: { ...nested, [field]: value } }
}

/** Narrow an unknown value to a plain object record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

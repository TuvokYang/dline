import type { z } from "zod"

const ENV_REFERENCE = /\$\{env:[^}]+\}/g
const WHOLE_ENV_REFERENCE = /^\s*\$\{env:[^}]+\}\s*$/

export type EnvReferenceParseResult<T> = { readonly success: true; readonly data: T } | { readonly success: false }

/**
 * Validate a configuration that still holds `${env:...}` references and return it
 * with the references intact, so values are resolved only at connect time and never
 * stored, compared, or shown expanded.
 *
 * Each string with a reference is replaced by a unique stand-in before validation: a
 * whole-value reference becomes a placeholder URL, so a `url` field that is only a
 * reference still validates, and a partial reference keeps the literal text around it,
 * so a malformed literal URL still fails. The stand-ins are swapped back afterwards.
 */
export function safeParseWithEnvReferences<S extends z.ZodTypeAny>(
    schema: S,
    value: unknown,
): EnvReferenceParseResult<z.infer<S>> {
    const originals = new Map<string, string>()
    const masked = mapStrings(value, (text) => {
        if (!text.includes("${env:")) return text
        const token = `dline-env-reference-${originals.size}`
        const standIn = WHOLE_ENV_REFERENCE.test(text) ? `https://${token}.invalid` : text.replace(ENV_REFERENCE, token)
        originals.set(standIn, text)
        return standIn
    })
    const result = schema.safeParse(masked)
    if (!result.success) return { success: false }
    return { success: true, data: mapStrings(result.data, (text) => originals.get(text) ?? text) as z.infer<S> }
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
    if (typeof value === "string") return map(value)
    if (Array.isArray(value)) return value.map((item) => mapStrings(item, map))
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, map)]))
    }
    return value
}

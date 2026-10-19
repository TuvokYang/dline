/**
 * Utility for expanding environment variables in configuration values.
 * Supports ${env:VAR_NAME} syntax for referencing environment variables.
 */

import { Logger } from "@/shared/services/Logger"

/** Matches `${env:NAME}`; the name is trimmed, so `${env: NAME }` refers to `NAME`. */
const ENV_REFERENCE = /\$\{env:([^}]+)\}/g

/** Supplies the value of one referenced variable, or undefined when it has none. */
export type EnvironmentLookup = (name: string) => string | undefined

const processEnvironment: EnvironmentLookup = (name) => process.env[name]

/** Every distinct variable name referenced by `${env:...}` anywhere in a string, object or array. */
export function collectEnvironmentReferences(value: unknown): string[] {
    const names = new Set<string>()
    visitStrings(value, (text) => {
        for (const match of text.matchAll(ENV_REFERENCE)) names.add(match[1].trim())
    })
    return [...names]
}

function visitStrings(value: unknown, visit: (text: string) => void): void {
    if (typeof value === "string") {
        visit(value)
    } else if (Array.isArray(value)) {
        for (const item of value) visitStrings(item, visit)
    } else if (value && typeof value === "object") {
        for (const item of Object.values(value)) visitStrings(item, visit)
    }
}

/**
 * Expands environment variables in a string value.
 * Supports ${env:VAR_NAME} syntax.
 *
 * @param value - String that may contain variable references
 * @returns String with environment variables expanded
 *
 * @example
 * // If process.env.API_KEY = "secret123"
 * expandString("Bearer ${env:API_KEY}") // Returns: "Bearer secret123"
 * expandString("${env:MISSING}") // Returns: "${env:MISSING}" (unchanged)
 */
function expandString(value: string, lookup: EnvironmentLookup): string {
    return value.replace(ENV_REFERENCE, (match, varName: string) => {
        // Trim whitespace from variable name to be forgiving of formatting
        const trimmedVarName = varName.trim()
        const envValue = lookup(trimmedVarName)

        if (envValue === undefined) {
            Logger.warn(`[MCP Config] Environment variable not found: ${trimmedVarName}`)
            return match // Leave unexpanded to show what's missing
        }

        // Empty string is a valid value, return it
        return envValue
    })
}

/**
 * Recursively expands environment variables in any value (string, object, array).
 * Only processes string values, leaving other types unchanged.
 *
 * @param value - Value to process (can be string, object, array, or primitive)
 * @returns Value with all environment variables expanded
 *
 * @example
 * expandEnvironmentVariables({
 *   api_key: "${env:API_KEY}",
 *   nested: {
 *     token: "${env:TOKEN}"
 *   }
 * })
 * // Returns object with all ${env:*} references expanded
 */
export function expandEnvironmentVariables<T>(value: T, lookup: EnvironmentLookup = processEnvironment): T {
    // Handle string values
    if (typeof value === "string") {
        return expandString(value, lookup) as T
    }

    // Handle arrays
    if (Array.isArray(value)) {
        return value.map((item) => expandEnvironmentVariables(item, lookup)) as T
    }

    // Handle objects (but not null)
    if (value && typeof value === "object") {
        const result: any = {}
        for (const [key, val] of Object.entries(value)) {
            result[key] = expandEnvironmentVariables(val, lookup)
        }
        return result
    }

    // Return primitives unchanged (numbers, booleans, null, undefined)
    return value
}

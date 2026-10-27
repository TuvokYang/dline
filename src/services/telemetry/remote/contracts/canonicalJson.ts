/**
 * RFC 8785 JSON Canonicalization Scheme restricted to the Dline wire contracts.
 *
 * The contracts only admit safe integers, so the number serialization of
 * RFC 8785 reduces to the decimal form of an integer. Any other number, a lone
 * surrogate or a non-JSON value is a contract violation and throws instead of
 * being coerced, because a silently different byte sequence would break the
 * replay fingerprint the server compares.
 */

import { createHash } from "node:crypto"

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u

/**
 * Order two strings by UTF-16 code units, as RFC 8785 property sorting and the
 * Usage semantic array order require. Locale collation is never correct here.
 */
export function compareUtf16(left: string, right: string): number {
    if (left === right) return 0
    return left < right ? -1 : 1
}

/** Serialize a JSON value canonically; properties whose value is `undefined` are omitted as JSON does. */
export function canonicalJson(value: unknown): string {
    return serialize(value, "$")
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
    return new TextEncoder().encode(canonicalJson(value))
}

/** Lowercase hex SHA-256, the content hash form of every Dline wire contract. */
export function sha256Hex(content: Uint8Array | string): string {
    return createHash("sha256").update(content).digest("hex")
}

function serialize(value: unknown, location: string): string {
    if (value === null) return "null"
    switch (typeof value) {
        case "boolean":
            return value ? "true" : "false"
        case "number":
            if (!Number.isSafeInteger(value)) throw new TypeError(`Canonical JSON admits safe integers only at ${location}`)
            return String(value)
        case "string":
            return serializeString(value, location)
        case "object":
            return Array.isArray(value) ? serializeArray(value, location) : serializeObject(value as object, location)
        default:
            throw new TypeError(`Canonical JSON cannot encode ${typeof value} at ${location}`)
    }
}

function serializeString(value: string, location: string): string {
    if (LONE_SURROGATE.test(value)) throw new TypeError(`Canonical JSON rejects a lone surrogate at ${location}`)
    // ECMAScript string serialization is the RFC 8785 string form for well-formed input.
    return JSON.stringify(value)
}

function serializeArray(values: readonly unknown[], location: string): string {
    return `[${values.map((item, index) => serialize(item, `${location}[${index}]`)).join(",")}]`
}

function serializeObject(value: object, location: string): string {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`Canonical JSON admits plain objects only at ${location}`)
    }
    const members = Object.entries(value)
        .filter(([, member]) => member !== undefined)
        .sort(([left], [right]) => compareUtf16(left, right))
        .map(([key, member]) => `${serializeString(key, location)}:${serialize(member, `${location}.${key}`)}`)
    return `{${members.join(",")}}`
}

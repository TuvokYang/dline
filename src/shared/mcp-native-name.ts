import { createHash } from "node:crypto"
import { CLINE_MCP_TOOL_IDENTIFIER } from "./mcp"

/**
 * Native MCP function names: `<server key>0mcp0<tool segment>`.
 *
 * Both parts are derived from names alone, so the same server and tool get the
 * same function name in every process and after every restart, and a frozen
 * tool list stays resolvable. Extension-side only: it depends on `node:crypto`.
 */

/** Providers cap a function name at 64 characters. */
export const MAX_NATIVE_TOOL_NAME_LENGTH = 64
const HASHED_TOOL_PREFIX = "_"
const TOOL_HASH_LENGTH = 8
const HASHED_TOOL_SEGMENT = new RegExp(`^${HASHED_TOOL_PREFIX}[0-9a-f]{${TOOL_HASH_LENGTH}}$`)
/** Longest server key that still leaves room for the separator and a hashed tool segment. */
export const MCP_SERVER_KEY_MAX_LENGTH =
    MAX_NATIVE_TOOL_NAME_LENGTH - CLINE_MCP_TOOL_IDENTIFIER.length - HASHED_TOOL_PREFIX.length - TOOL_HASH_LENGTH

/** Characters every provider accepts in a function name. */
const INVALID_NAME_CHARACTER = /[^A-Za-z0-9_-]/g
const PROVIDER_SAFE_NAME = /^[A-Za-z0-9_-]+$/
const KEY_SEPARATOR = "_"
const COLLISION_SUFFIX_LENGTH = 6

/** Where a native MCP function name points. */
export interface McpToolAddress {
    readonly serverName: string
    readonly toolName: string
}

/**
 * Derive the key a native MCP function name starts with from the server's name.
 * Characters a provider rejects become `_`, and a key that does not start with a
 * letter is prefixed, as Gemini requires.
 */
export function deriveMcpServerKey(serverName: string): string {
    const sanitized = serverName
        .replace(INVALID_NAME_CHARACTER, KEY_SEPARATOR)
        .split(CLINE_MCP_TOOL_IDENTIFIER)
        .join(KEY_SEPARATOR)
    const lettered = /^[A-Za-z]/.test(sanitized) ? sanitized : `m${KEY_SEPARATOR}${sanitized}`
    return keepSeparatorBoundary(lettered.slice(0, MCP_SERVER_KEY_MAX_LENGTH))
}

/**
 * Derive a key no other server holds. Two names can sanitize to the same key
 * (`a b` and `a/b`); the later one gets a suffix from its own name so a call
 * can never reach the wrong server.
 */
export function deriveUniqueMcpServerKey(serverName: string, isTaken: (key: string) => boolean): string {
    const base = deriveMcpServerKey(serverName)
    if (!isTaken(base)) return base
    const digest = sha256Hex(serverName)
    const stem = base.slice(0, MCP_SERVER_KEY_MAX_LENGTH - COLLISION_SUFFIX_LENGTH - KEY_SEPARATOR.length)
    for (let offset = 0; offset + COLLISION_SUFFIX_LENGTH <= digest.length; offset++) {
        const candidate = keepSeparatorBoundary(
            `${stem}${KEY_SEPARATOR}${digest.slice(offset, offset + COLLISION_SUFFIX_LENGTH)}`,
        )
        if (!isTaken(candidate)) return candidate
    }
    throw new Error(`Cannot derive a unique MCP server key for "${serverName}"`)
}

/**
 * The native function name for one MCP tool. A tool whose name would push the
 * function name past the provider limit, or that holds characters a provider
 * rejects, is named by `_` and eight hex digits of its name's hash instead.
 */
export function nativeMcpToolName(serverKey: string, toolName: string): string {
    const name = `${serverKey}${CLINE_MCP_TOOL_IDENTIFIER}${toolName}`
    if (name.length <= MAX_NATIVE_TOOL_NAME_LENGTH && PROVIDER_SAFE_NAME.test(toolName)) return name
    return `${serverKey}${CLINE_MCP_TOOL_IDENTIFIER}${hashedToolSegment(toolName)}`
}

/**
 * Recover the tool a native tool segment names among one server's tools. A tool
 * that is really called `_<hex>` wins over a hash match; an unknown segment is
 * returned unchanged so the call fails with the name the model used.
 */
export function resolveMcpToolSegment(segment: string, toolNames: readonly string[]): string {
    if (!HASHED_TOOL_SEGMENT.test(segment) || toolNames.includes(segment)) return segment
    return toolNames.find((toolName) => hashedToolSegment(toolName) === segment) ?? segment
}

function hashedToolSegment(toolName: string): string {
    return `${HASHED_TOOL_PREFIX}${sha256Hex(toolName).slice(0, TOOL_HASH_LENGTH)}`
}

function sha256Hex(value: string): string {
    return createHash("sha256").update(value).digest("hex")
}

/**
 * Keep the separator's first occurrence at the end of the key. A key ending in a
 * prefix of the separator, such as `x0mcp`, would let the parser split
 * `x0mcp0mcp0tool` one segment too early; replacing the key's last character
 * breaks that overlap without lengthening the key.
 */
function keepSeparatorBoundary(key: string): string {
    if (`${key}${CLINE_MCP_TOOL_IDENTIFIER}`.indexOf(CLINE_MCP_TOOL_IDENTIFIER) === key.length) return key
    return `${key.slice(0, -1)}${KEY_SEPARATOR}`
}

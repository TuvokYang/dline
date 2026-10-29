import { describe, expect, it } from "vitest"
import { CLINE_MCP_TOOL_IDENTIFIER } from "../mcp"
import {
    deriveMcpServerKey,
    deriveUniqueMcpServerKey,
    MAX_NATIVE_TOOL_NAME_LENGTH,
    MCP_SERVER_KEY_MAX_LENGTH,
    nativeMcpToolName,
    resolveMcpToolSegment,
} from "../mcp-native-name"

const PROVIDER_FUNCTION_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/

/** Split a native name the way the provider decoder does: at the first separator. */
function decode(name: string): [string, string] {
    const marker = name.indexOf(CLINE_MCP_TOOL_IDENTIFIER)
    return [name.slice(0, marker), name.slice(marker + CLINE_MCP_TOOL_IDENTIFIER.length)]
}

describe("deriveMcpServerKey", () => {
    it("keeps a provider-safe server name as it is", () => {
        expect(deriveMcpServerKey("otel")).toBe("otel")
        expect(deriveMcpServerKey("github-tools_2")).toBe("github-tools_2")
    })

    it("replaces characters a provider rejects with underscores", () => {
        expect(deriveMcpServerKey("Snapshot MCP")).toBe("Snapshot_MCP")
        expect(deriveMcpServerKey("acme.docs/v2")).toBe("acme_docs_v2")
    })

    it("starts every key with a letter", () => {
        expect(deriveMcpServerKey("@modelcontextprotocol/server-github")).toMatch(/^m__modelcontextprotocol_server/)
        expect(deriveMcpServerKey("1password")).toBe("m_1password")
    })

    it("derives the same key every time, as a fresh process would", () => {
        expect(deriveMcpServerKey("Snapshot MCP")).toBe(deriveMcpServerKey("Snapshot MCP"))
        expect(deriveUniqueMcpServerKey("Snapshot MCP", () => false)).toBe("Snapshot_MCP")
    })

    it("bounds the key so a hashed tool segment always fits", () => {
        const key = deriveMcpServerKey("x".repeat(200))

        expect(key).toHaveLength(MCP_SERVER_KEY_MAX_LENGTH)
        expect(nativeMcpToolName(key, "y".repeat(200)).length).toBeLessThanOrEqual(MAX_NATIVE_TOOL_NAME_LENGTH)
    })

    it("never lets the decoder split inside the key", () => {
        for (const name of ["a0mcp0b", "x0mcp", "0mcp0"]) {
            const key = deriveMcpServerKey(name)
            expect(decode(nativeMcpToolName(key, "tool"))).toEqual([key, "tool"])
        }
    })
})

describe("deriveUniqueMcpServerKey", () => {
    it("gives a second server whose name sanitizes to a taken key its own key", () => {
        const first = deriveUniqueMcpServerKey("a b", () => false)
        const second = deriveUniqueMcpServerKey("a/b", (key) => key === first)

        expect(first).toBe("a_b")
        expect(second).not.toBe(first)
        expect(second).toMatch(/^a_b_[0-9a-f]{6}$/)
        expect(deriveUniqueMcpServerKey("a/b", (key) => key === first)).toBe(second)
    })
})

describe("nativeMcpToolName", () => {
    it("joins the key and the tool name when the result is provider-safe", () => {
        expect(nativeMcpToolName("otel", "query_logs")).toBe(`otel${CLINE_MCP_TOOL_IDENTIFIER}query_logs`)
    })

    it("names a tool that would exceed the limit by an eight-digit hash of its name", () => {
        const toolName = "list_every_alerting_notification_policy_contact_point"
        const name = nativeMcpToolName("grafana_observability", toolName)
        const [, segment] = decode(name)

        expect(segment).toMatch(/^_[0-9a-f]{8}$/)
        expect(name.length).toBeLessThanOrEqual(MAX_NATIVE_TOOL_NAME_LENGTH)
        expect(name).toMatch(PROVIDER_FUNCTION_NAME)
        expect(nativeMcpToolName("grafana_observability", toolName)).toBe(name)
        expect(resolveMcpToolSegment(segment, ["other", toolName])).toBe(toolName)
    })

    it("hashes a tool name that holds characters a provider rejects", () => {
        const [, segment] = decode(nativeMcpToolName("docs", "search.pages"))

        expect(segment).toMatch(/^_[0-9a-f]{8}$/)
        expect(resolveMcpToolSegment(segment, ["search.pages"])).toBe("search.pages")
    })
})

describe("resolveMcpToolSegment", () => {
    it("prefers a tool that is really called like a hashed segment", () => {
        const [, segment] = decode(nativeMcpToolName("docs", "search.pages"))

        expect(resolveMcpToolSegment(segment, ["search.pages", segment])).toBe(segment)
    })

    it("returns plain and unknown segments unchanged", () => {
        expect(resolveMcpToolSegment("query_logs", ["query_logs"])).toBe("query_logs")
        expect(resolveMcpToolSegment("_ffffffff", ["query_logs"])).toBe("_ffffffff")
    })
})

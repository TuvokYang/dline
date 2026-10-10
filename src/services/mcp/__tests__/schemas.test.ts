import deepEqual from "fast-deep-equal"
import { describe, expect, it } from "vitest"
import { ServerConfigSchema } from "../schemas"

/**
 * Regression tests for the zod schema transforms.
 *
 * The legacy `transportType` field must be dropped entirely (no own key with an
 * `undefined` value) so that an in-memory parsed config deep-equals the same
 * config after a JSON.stringify/parse round trip. Previously the transform kept
 * `transportType: undefined` as an own enumerable key, which JSON.stringify
 * drops — making `configsRequireRestart` always report a difference and forcing
 * a full MCP server reconnect on every reconcile.
 */
describe("ServerConfigSchema transform output", () => {
    it.each([
        ["stdio", { type: "stdio", command: "node" }],
        ["sse", { type: "sse", url: "https://example.com/sse" }],
        ["streamableHttp", { type: "streamableHttp", url: "https://example.com/mcp" }],
    ])("drops the legacy transportType key for %s configs", (_type, raw) => {
        const parsed = ServerConfigSchema.parse(raw)
        expect(Object.hasOwn(parsed, "transportType")).toBe(false)
    })

    it.each([
        ["stdio", { type: "stdio", command: "node" }],
        ["sse", { type: "sse", url: "https://example.com/sse" }],
        ["streamableHttp", { type: "streamableHttp", url: "https://example.com/mcp" }],
    ])("round-trips through JSON without changing config equality for %s", (_type, raw) => {
        const parsed = ServerConfigSchema.parse(raw)
        const roundTripped = JSON.parse(JSON.stringify(parsed))
        expect(deepEqual(parsed, roundTripped)).toBe(true)
    })

    it("drops the legacy transportType key even when it is the only discriminator", () => {
        // Without an explicit type the union resolves to the first branch (sse);
        // the important contract here is that the legacy key never leaks into
        // the parsed output, which is what broke config deep-equality before.
        const parsed = ServerConfigSchema.parse({ transportType: "http", url: "https://example.com/mcp" } as any)
        expect(Object.hasOwn(parsed, "transportType")).toBe(false)
        expect(parsed).not.toHaveProperty("transportType")
    })
})

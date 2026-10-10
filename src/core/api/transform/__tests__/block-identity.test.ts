import { describe, expect, expectTypeOf, it } from "vitest"
import { createIdentityFactory, MissingFunctionIdentityError } from "../block-identity"
import type { ApiRawStreamToolCallsChunk, ApiStreamToolCallsChunk } from "../stream"

/**
 * Create a deterministic ULID source for identity allocator tests.
 *
 * @param values Ordered ULID values returned by the source.
 * @returns Function returning the next configured ULID.
 */
function createUlidSource(values: string[]): () => string {
    let index = 0
    return () => {
        const value = values[index]
        index += 1
        if (value === undefined) {
            throw new Error("ULID source exhausted")
        }
        return value
    }
}

describe("stream identity types", () => {
    it("separates provider raw tool identity from canonical tool identity", () => {
        expectTypeOf<ApiRawStreamToolCallsChunk>().toHaveProperty("function_id")
        expectTypeOf<ApiStreamToolCallsChunk>().toMatchTypeOf<{
            function_id: string
            dline_tid: string
        }>()
    })
})

describe("block identity factory", () => {
    it("creates prefixed function and trace identities", () => {
        const factory = createIdentityFactory(createUlidSource(["01FUNCTION", "01TRACE"]))

        expect(factory.nextFunctionId()).toBe("dline_function_01FUNCTION")
        expect(factory.nextTraceId()).toBe("dline_tid_01TRACE")
    })

    it("preserves allocator order for identities created in one task", () => {
        const factory = createIdentityFactory(createUlidSource(["01A", "01B", "01C"]))
        const identities = [factory.nextFunctionId(), factory.nextFunctionId(), factory.nextFunctionId()]

        expect(new Set(identities).size).toBe(3)
        expect([...identities].sort()).toEqual(identities)
    })

    it("reports missing provider function identity without generating one", () => {
        const error = new MissingFunctionIdentityError({
            provider: "openai",
            apiFormat: "OPENAI_CHAT",
            itemId: "dline_item_01ITEM",
            traceId: "dline_tid_01TRACE",
            toolName: "execute_command",
        })

        expect(error.name).toBe("MissingFunctionIdentityError")
        expect(error.message).toContain("openai")
        expect(error.message).toContain("dline_tid_01TRACE")
    })
})

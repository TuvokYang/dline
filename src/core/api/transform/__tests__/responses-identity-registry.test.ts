import { describe, expect, it } from "vitest"
import {
    createResponsesRegistry,
    createResponsesToolChunk,
    ResponsesIdentityConflictError,
    ResponsesIdentityMissingError,
} from "../responses-identity-registry"

describe("ResponsesIdentityRegistry", () => {
    it("preserves item and function identities across added delta and done events", () => {
        const registry = createResponsesRegistry("openai")

        const added = registry.registerItem({
            itemId: "fc_item_123",
            functionId: "call_123",
            name: "read_file",
        })
        const delta = registry.resolveItem("fc_item_123")
        const done = registry.registerItem({
            itemId: "fc_item_123",
            functionId: "call_123",
            name: "read_file",
        })

        expect(added).toEqual({
            item_id: "fc_item_123",
            function_id: "call_123",
            name: "read_file",
        })
        expect(delta).toBe(added)
        expect(done).toBe(added)
        expect(added.item_id).not.toBe(added.function_id)
        expect(added).not.toHaveProperty("dline_tid")
    })

    it("creates a raw tool chunk without conflating item and function identities", () => {
        const registry = createResponsesRegistry("openai")
        const identity = registry.registerItem({
            itemId: "fc_item_123",
            functionId: "call_123",
            name: "read_file",
        })

        const chunk = createResponsesToolChunk(identity, "{}")

        expect(chunk.provider_metadata?.item_id).toBe("fc_item_123")
        expect(chunk.function_id).toBe("call_123")
        expect(chunk.tool_call).not.toHaveProperty("call_id")
        expect(chunk.tool_call.function).not.toHaveProperty("id")
        expect(chunk.tool_call.function.name).toBe("read_file")
    })

    it("rejects a delta for an unknown response item", () => {
        const registry = createResponsesRegistry("openai-codex")

        expect(() => registry.requireItem("missing_item")).toThrowError(ResponsesIdentityMissingError)
        expect(() => registry.requireItem("missing_item")).toThrowError(/provider=openai-codex.*item_id=missing_item/)
    })

    it("rejects conflicting function identities for the same response item", () => {
        const registry = createResponsesRegistry("responses-api-support")
        registry.registerItem({
            itemId: "fc_item_123",
            functionId: "call_123",
            name: "read_file",
        })

        expect(() =>
            registry.registerItem({
                itemId: "fc_item_123",
                functionId: "call_conflict",
                name: "read_file",
            }),
        ).toThrowError(ResponsesIdentityConflictError)
        expect(() =>
            registry.registerItem({
                itemId: "fc_item_123",
                functionId: "call_conflict",
                name: "read_file",
            }),
        ).toThrowError(/provider=responses-api-support.*item_id=fc_item_123.*call_123.*call_conflict/)
    })
})

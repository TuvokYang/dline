import { describe, expect, it } from "vitest"
import { normalizeLegacyConversation, requiresLegacyConversationMigration } from "../legacy-identity-migration"

describe("legacy conversation identity migration", () => {
    it("converts every legacy tool alias to canonical runtime identities", () => {
        const messages = normalizeLegacyConversation([
            {
                role: "assistant",
                id: "response-1",
                content: [
                    {
                        type: "tool_use",
                        id: "function-1",
                        item_id: "fc_item_1",
                        name: "read_file",
                        input: { path: "README.md" },
                    },
                ],
            },
            {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: "function-1", content: "contents" }],
            },
        ])

        const serialized = JSON.stringify(messages)
        expect(messages[0].provider_metadata?.response_id).toBe("response-1")
        expect(messages[0].content[0]).toMatchObject({
            function_id: "function-1",
            dline_tid: "legacy_tid_function-1",
            provider_metadata: { item_id: "fc_item_1" },
        })
        expect(messages[1].content[0]).toMatchObject({
            function_id: "function-1",
            dline_tid: "legacy_tid_function-1",
        })
        expect(serialized).not.toContain('"call_id"')
        expect(serialized).not.toContain('"tool_use_id"')
        expect(serialized).not.toContain('"item_id":"fc_item_1","function_id"')
    })

    it("leaves canonical provider identities on the read-only path", () => {
        const canonical = [
            {
                role: "assistant",
                content: [
                    {
                        type: "tool_use",
                        function_id: "call_1",
                        dline_tid: "dline_tid_1",
                        provider_metadata: { item_id: "fc_1" },
                        name: "make_plan",
                        input: { response: "plan" },
                    },
                ],
                ts: 100,
            },
        ]

        expect(requiresLegacyConversationMigration(canonical)).toBe(false)
        expect(requiresLegacyConversationMigration([{ role: "assistant", id: "response-1", content: [] }])).toBe(true)
    })
})

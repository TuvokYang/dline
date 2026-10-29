import type { ClineStorageMessage } from "@shared/messages/content"
import { describe, expect, it } from "vitest"
import {
    createCompactionProviderDiagnosticSnapshot,
    createCompactionWireDiagnosticSnapshot,
    findCompactionProviderFirstDivergence,
    findCompactionWireFirstDivergence,
} from "../compaction-dev-diagnostics"

function message(role: "user" | "assistant", text: string): ClineStorageMessage {
    return { role, content: [{ type: "text", text }] }
}

function snapshot(
    overrides: { systemPrompt?: string; messages?: ClineStorageMessage[]; tools?: unknown[]; serverTools?: unknown[] } = {},
) {
    return createCompactionProviderDiagnosticSnapshot({
        requestKind: "ordinary",
        providerId: "openai",
        modelId: "gpt-5.6-sol",
        apiFormat: "openai-responses",
        systemPrompt: overrides.systemPrompt ?? "stable prompt",
        messages: overrides.messages ?? [message("user", "first"), message("assistant", "second")],
        tools: overrides.tools ?? [{ name: "read_file" }],
        serverTools: overrides.serverTools ?? [],
    })
}

describe("compaction dev diagnostics", () => {
    it("reports the first changed provider-neutral message without exposing content", () => {
        const baseline = snapshot()
        const current = snapshot({ messages: [message("user", "first"), message("assistant", "changed")] })

        const divergence = findCompactionProviderFirstDivergence(baseline, current)

        expect(divergence).toMatchObject({
            component: "messages",
            messageIndex: 1,
            baselineShape: { role: "assistant", contentTypes: ["text"] },
            currentShape: { role: "assistant", contentTypes: ["text"] },
        })
        expect(JSON.stringify(divergence)).not.toContain("second")
        expect(JSON.stringify(divergence)).not.toContain("changed")
    })

    it("reports prompt identity components before message differences", () => {
        const divergence = findCompactionProviderFirstDivergence(snapshot(), snapshot({ tools: [{ name: "summarize_task" }] }))

        expect(divergence).toMatchObject({ component: "tools", messageIndex: null })
    })

    it("reports the first changed OpenAI Responses input item", () => {
        const baseline = createCompactionWireDiagnosticSnapshot({
            requestKind: "ordinary",
            promptCacheKey: "stable-key",
            instructions: "stable prompt",
            tools: [{ type: "function", name: "read_file" }],
            wireInput: [{ type: "message", role: "user", content: "first" }],
        })
        const current = createCompactionWireDiagnosticSnapshot({
            requestKind: "compaction",
            promptCacheKey: "stable-key",
            instructions: "stable prompt",
            tools: [{ type: "function", name: "read_file" }],
            wireInput: [{ type: "message", role: "user", content: "changed" }],
        })

        expect(findCompactionWireFirstDivergence(baseline, current)).toMatchObject({
            component: "input",
            inputIndex: 0,
            baselineShape: { type: "message" },
            currentShape: { type: "message" },
        })
    })

    it("reports Codex previous_response_id changes before input changes", () => {
        const baseline = createCompactionWireDiagnosticSnapshot({
            requestKind: "ordinary",
            promptCacheKey: "stable-key",
            previousResponseId: "response-a",
            wireInput: [{ type: "message", content: "same" }],
        })
        const current = createCompactionWireDiagnosticSnapshot({
            requestKind: "compaction",
            promptCacheKey: "stable-key",
            wireInput: [{ type: "message", content: "same" }],
        })

        expect(findCompactionWireFirstDivergence(baseline, current)).toMatchObject({
            component: "previous_response_id",
            inputIndex: null,
        })
    })

    it("reports no divergence for identical snapshots", () => {
        expect(findCompactionProviderFirstDivergence(snapshot(), snapshot())).toEqual({
            component: null,
            messageIndex: null,
            baselineHash: null,
            currentHash: null,
            baselineShape: null,
            currentShape: null,
        })
    })
})

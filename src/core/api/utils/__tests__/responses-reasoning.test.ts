import type OpenAI from "openai"
import { describe, expect, it } from "vitest"
import type { ApiStreamThinkingChunk } from "../../transform/stream"
import { handleResponsesApiStreamResponse } from "../responses_api_support"

type ResponseEvent = OpenAI.Responses.ResponseStreamEvent

function delta(itemId: string, summaryIndex: number, text: string): ResponseEvent {
    return {
        type: "response.reasoning_summary_text.delta",
        item_id: itemId,
        summary_index: summaryIndex,
        output_index: 0,
        sequence_number: 1,
        delta: text,
    }
}

function added(itemId: string, summaryIndex: number, text = ""): ResponseEvent {
    return {
        type: "response.reasoning_summary_part.added",
        item_id: itemId,
        summary_index: summaryIndex,
        output_index: 0,
        sequence_number: 1,
        part: { type: "summary_text", text },
    }
}

async function reasoning(events: readonly ResponseEvent[]): Promise<ApiStreamThinkingChunk[]> {
    async function* stream() {
        yield* events
    }
    const chunks: ApiStreamThinkingChunk[] = []
    for await (const chunk of handleResponsesApiStreamResponse(stream(), { id: "test-model" }, async () => 0)) {
        if (chunk.type === "reasoning") chunks.push(chunk)
    }
    return chunks
}

function visibleText(chunks: readonly ApiStreamThinkingChunk[]): string {
    return chunks.map((chunk) => chunk.reasoning).join("")
}

describe("Responses reasoning summary boundaries", () => {
    it("separates summary parts without inserting whitespace inside streamed tokens", async () => {
        const chunks = await reasoning([
            added("rs_1", 0),
            delta("rs_1", 0, "**Checking .agents"),
            delta("rs_1", 0, " changes**"),
            added("rs_1", 1),
            delta("rs_1", 1, "**Checking workflow metadata**"),
            added("rs_1", 2),
            delta("rs_1", 2, "**Checking project references**"),
        ])
        expect(visibleText(chunks)).toBe(
            "**Checking .agents changes**\n\n**Checking workflow metadata**\n\n**Checking project references**",
        )
    })

    it("also recognizes a part boundary when only delta events carry the indices", async () => {
        const chunks = await reasoning([delta("rs_1", 0, "First"), delta("rs_1", 1, "Second")])
        expect(visibleText(chunks)).toBe("First\n\nSecond")
    })

    it("separates different reasoning items even when each starts at summary index zero", async () => {
        const chunks = await reasoning([delta("rs_1", 0, "First"), delta("rs_2", 0, "Second")])
        expect(visibleText(chunks)).toBe("First\n\nSecond")
    })

    it.each([
        ["First\n\n", "Second"],
        ["First", "\n\nSecond"],
        ["First\n", "\nSecond"],
    ])("retains existing paragraph whitespace for %j and %j", async (first, second) => {
        const chunks = await reasoning([delta("rs_1", 0, first), delta("rs_1", 1, second)])
        expect(visibleText(chunks)).toBe("First\n\nSecond")
    })

    it("does not emit leading or trailing separators for empty parts", async () => {
        const chunks = await reasoning([
            added("rs_1", 0),
            added("rs_1", 1),
            delta("rs_1", 1, "Visible"),
            added("rs_1", 2),
            delta("rs_1", 2, ""),
        ])
        expect(visibleText(chunks)).toBe("Visible")
    })

    it("does not guess boundaries from Markdown delimiters or unindexed compatible deltas", async () => {
        const first = { ...delta("rs_1", 0, "**a****b**"), summary_index: undefined } as unknown as ResponseEvent
        const second = { ...delta("rs_1", 0, " continuation"), summary_index: undefined } as unknown as ResponseEvent
        expect(visibleText(await reasoning([first, second]))).toBe("**a****b** continuation")
    })

    it("keeps completed summary and encrypted replay payloads unchanged and does not repeat their text", async () => {
        const part = { type: "summary_text" as const, text: "Second" }
        const summary = [{ type: "summary_text" as const, text: "First" }, part]
        const chunks = await reasoning([
            delta("rs_1", 0, "First"),
            delta("rs_1", 1, "Second"),
            {
                type: "response.reasoning_summary_part.done",
                item_id: "rs_1",
                summary_index: 1,
                output_index: 0,
                sequence_number: 2,
                part,
            },
            {
                type: "response.output_item.done",
                output_index: 0,
                sequence_number: 3,
                item: { id: "rs_1", type: "reasoning", summary, encrypted_content: "opaque-payload" },
            },
        ])
        expect(visibleText(chunks)).toBe("First\n\nSecond")
        expect(chunks.filter((chunk) => chunk.details !== undefined).map((chunk) => chunk.details)).toEqual([part, summary])
        expect(chunks.at(-1)).toEqual({
            type: "reasoning",
            provider_metadata: { response_id: "rs_1" },
            reasoning: "",
            redacted_data: "opaque-payload",
            redacted_phase: "final",
        })
    })

    it("leaves raw reasoning text deltas untouched", async () => {
        const chunks = await reasoning([
            {
                type: "response.reasoning_text.delta",
                item_id: "rs_1",
                content_index: 0,
                output_index: 0,
                sequence_number: 1,
                delta: "unformatted",
            },
            {
                type: "response.reasoning_text.delta",
                item_id: "rs_2",
                content_index: 0,
                output_index: 1,
                sequence_number: 2,
                delta: " continuation",
            },
        ])
        expect(visibleText(chunks)).toBe("unformatted continuation")
    })
})

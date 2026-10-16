import type { ClineStorageMessage } from "@shared/messages"
import { describe, expect, it } from "vitest"
import { SubagentRoundContextProjection } from "../SubagentRoundContextProjection"

function textOf(message: ClineStorageMessage): string[] {
    return Array.isArray(message.content)
        ? message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
        : [message.content]
}

describe("SubagentRoundContextProjection", () => {
    it("keeps committed round suffixes at their original content boundaries", () => {
        const projection = new SubagentRoundContextProjection()
        const conversation: ClineStorageMessage[] = [{ role: "user", content: [{ type: "text", text: "task" }] }]

        const first = projection.freeze(conversation, "round-1")
        expect(textOf(projection.project(conversation, undefined, first)[0])).toEqual(["task", "round-1"])
        projection.commit(first)

        conversation[0] = {
            role: "user",
            content: [...(conversation[0].content as []), { type: "text", text: "feedback" }],
        }
        const second = projection.freeze(conversation, "round-2")
        expect(textOf(projection.project(conversation, undefined, second)[0])).toEqual(["task", "round-1", "feedback", "round-2"])
    })

    it("drops suffixes only with the canonical messages removed by truncation", () => {
        const projection = new SubagentRoundContextProjection()
        const conversation: ClineStorageMessage[] = [
            { role: "user", content: [{ type: "text", text: "initial" }] },
            { role: "assistant", content: [{ type: "text", text: "answer" }] },
            { role: "user", content: [{ type: "text", text: "old" }] },
            { role: "assistant", content: [{ type: "text", text: "old answer" }] },
            { role: "user", content: [{ type: "text", text: "current" }] },
        ]
        const oldRound = projection.freeze(conversation.slice(0, 3), "old suffix")
        projection.commit(oldRound)
        const currentRound = projection.freeze(conversation, "current suffix")
        const truncated = [conversation[0], conversation[1], conversation[4]]

        const projected = projection.project(truncated, [2, 3], currentRound)

        expect(textOf(projected[0])).toEqual(["initial"])
        expect(textOf(projected[2])).toEqual(["current", "current suffix"])
    })
})

import type { SubmittedInputFacts } from "@shared/input-semantics/submitted-input"
import { describe, expect, it } from "vitest"
import { markSubmittedEntities, parseSubmittedEntityLink } from "../highlight"

const facts = (...segments: SubmittedInputFacts["segments"]): SubmittedInputFacts[] => [{ segments }]

describe("markSubmittedEntities", () => {
    it("marks the entities that ran and keeps the rest of the Markdown verbatim", () => {
        const text = "/compact\n```\n/not-a-command\n```"
        const marked = markSubmittedEntities(
            text,
            facts(
                { text: "/compact", role: "command", active: true },
                { text: "\n```\n/not-a-command\n```", role: "text", active: false },
            ),
        )
        expect(marked).toBe("[/compact](#dline-entity/command/%2Fcompact)\n```\n/not-a-command\n```")
    })

    it("escapes Markdown syntax inside an entity so the link text reads as written", () => {
        const marked = markSubmittedEntities("@/src/a_[1].ts", facts({ text: "@/src/a_[1].ts", role: "mention", active: true }))
        expect(marked).toBe("[@/src/a\\_\\[1\\].ts](#dline-entity/mention/%40%2Fsrc%2Fa_%5B1%5D.ts)")
        expect(parseSubmittedEntityLink("#dline-entity/mention/%40%2Fsrc%2Fa_%5B1%5D.ts")).toEqual({
            role: "mention",
            text: "@/src/a_[1].ts",
        })
    })

    it.each([
        ["a legacy row", "/compact", undefined],
        ["facts that do not spell the text", "/compact now", facts({ text: "/compact", role: "command", active: true })],
        ["a row whose entities did not run", "/compact", facts({ text: "/compact", role: "command", active: false })],
    ])("leaves %s to the plain text", (_label, text, inputs) => {
        expect(markSubmittedEntities(text, inputs)).toBeUndefined()
    })
})

describe("parseSubmittedEntityLink", () => {
    it.each([
        undefined,
        "https://example.com",
        "#dline-entity/resource/x",
        "#dline-entity/command/%E0%A4%A",
    ])("ignores %s", (href) => {
        expect(parseSubmittedEntityLink(href)).toBeUndefined()
    })
})

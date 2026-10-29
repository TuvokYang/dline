import { describe, expect, it } from "vitest"
import type { MentionInputNode, SemanticInputDocument, SemanticInputNode, SlashCommandInputNode } from "../document"
import {
    ADMITTED_SUBMISSION,
    isSubmittedInputFacts,
    projectSubmittedInput,
    REPLY_AS_TYPED,
    rowHasVisibleContent,
    submittedInputRow,
} from "../submitted-input"

function command(overrides: Partial<SlashCommandInputNode> & { entityId: string; sourceText: string }): SlashCommandInputNode {
    return {
        kind: "slash_command",
        commandId: `command.${overrides.entityId}`,
        canonicalName: overrides.sourceText.slice(1),
        namespace: "cmd",
        compositionMode: "composable",
        state: "recognized",
        ...overrides,
    }
}

function mention(overrides: Partial<MentionInputNode> & { entityId: string; sourceText: string }): MentionInputNode {
    return {
        kind: "mention",
        mentionKind: "file",
        canonicalRef: overrides.sourceText.slice(1),
        state: "recognized",
        ...overrides,
    }
}

function document(nodes: readonly SemanticInputNode[]): SemanticInputDocument {
    return {
        schemaVersion: 1,
        parserVersion: "1.0.0",
        catalogRevision: "3",
        documentId: "doc-1",
        rawText: "",
        nodes,
        resources: [],
    }
}

const compact = command({ entityId: "compact", sourceText: "/compact", compositionMode: "lifecycle_barrier" })
const explain = command({ entityId: "explain", sourceText: "/explain-changes" })

describe("projectSubmittedInput", () => {
    it("marks the commands an admitted submission ran and the mentions it read", () => {
        const facts = projectSubmittedInput(
            document([explain, { kind: "text", text: " " }, mention({ entityId: "m", sourceText: "@/src/a.ts" })]),
            ADMITTED_SUBMISSION,
        )

        expect(facts.segments).toEqual([
            { text: "/explain-changes", role: "command", active: true },
            { text: " ", role: "text", active: false },
            { text: "@/src/a.ts", role: "mention", active: true },
        ])
    })

    it("keeps a command after the lifecycle barrier literal, because it was content for the barrier", () => {
        const facts = projectSubmittedInput(document([compact, { kind: "text", text: " then " }, explain]), ADMITTED_SUBMISSION)

        expect(facts.segments.filter((segment) => segment.role === "command")).toEqual([
            { text: "/compact", role: "command", active: true },
            { text: "/explain-changes", role: "command", active: false },
        ])
    })

    it("does not present an unresolved mention or an unresolved command as an entity", () => {
        const facts = projectSubmittedInput(
            document([
                command({ entityId: "gone", sourceText: "/gone", state: "unresolved" }),
                mention({ entityId: "m", sourceText: "@/missing.ts", state: "unresolved" }),
            ]),
            ADMITTED_SUBMISSION,
        )

        expect(facts.segments.every((segment) => !segment.active)).toBe(true)
    })

    it("shows nothing acting in a reply sent as typed", () => {
        const facts = projectSubmittedInput(
            document([explain, { kind: "text", text: " " }, mention({ entityId: "m", sourceText: "@/src/a.ts" })]),
            REPLY_AS_TYPED,
        )

        expect(facts.segments.some((segment) => segment.active)).toBe(false)
    })

    it("shows only the barrier a reply's owner claimed as having run", () => {
        const facts = projectSubmittedInput(document([compact, { kind: "text", text: " " }, explain]), {
            admitted: false,
            claimedBarrier: "compact",
        })

        expect(facts.segments.filter((segment) => segment.active)).toEqual([{ text: "/compact", role: "command", active: true }])
    })

    it("reads the mentions after a claimed barrier as its content, but not the ones before it", () => {
        const before = mention({ entityId: "m-before", sourceText: "@/src/before.ts" })
        const after = mention({ entityId: "m-after", sourceText: "@/src/after.ts" })
        const facts = projectSubmittedInput(
            document([before, { kind: "text", text: " " }, compact, { kind: "text", text: " keep " }, after]),
            { admitted: false, claimedBarrier: "compact" },
        )

        expect(facts.segments.filter((segment) => segment.role === "mention")).toEqual([
            { text: "@/src/before.ts", role: "mention", active: false },
            { text: "@/src/after.ts", role: "mention", active: true },
        ])
    })

    it("names a resource where the user placed it without its path or bytes", () => {
        const facts = projectSubmittedInput(
            document([
                { kind: "text", text: "see " },
                { kind: "image", entityId: "img", resourceId: "r-1", displayName: "diagram.png" },
            ]),
            REPLY_AS_TYPED,
        )

        expect(facts.segments).toEqual([
            { text: "see ", role: "text", active: false },
            { text: "[diagram.png]", role: "resource", active: true },
        ])
    })

    // The row keeps the stored resource's reference, never its path or bytes, so the chip can open it later.
    it("records the stored resource a resource segment names when the document binds one", () => {
        const ref = {
            resourceId: "r-1",
            expectedContentHash: "sha256:abc",
            mediaType: "image/png",
            byteLength: 42,
            owner: { kind: "task" as const, taskId: "task-1" },
            generation: 1,
        }
        const facts = projectSubmittedInput(
            {
                ...document([{ kind: "image", entityId: "img", resourceId: "r-1", displayName: "diagram.png" }]),
                resources: [ref],
            },
            REPLY_AS_TYPED,
        )

        expect(facts.segments).toEqual([{ text: "[diagram.png]", role: "resource", active: true, resource: ref }])
        expect(isSubmittedInputFacts(facts)).toBe(true)
        const malformed = { segments: [{ ...facts.segments[0], resource: { ...ref, owner: { kind: "task" } } }] }
        expect(isSubmittedInputFacts(malformed)).toBe(false)
    })

    it("reads pasted literal text as text whatever shape it has", () => {
        const facts = projectSubmittedInput(
            document([{ kind: "literal", text: "/compact @/x", source: "pasted" }]),
            ADMITTED_SUBMISSION,
        )

        expect(facts.segments).toEqual([{ text: "/compact @/x", role: "text", active: false }])
    })
})

describe("submittedInputRow", () => {
    it("joins a batch with one separator and keeps one fact entry per input", () => {
        const row = submittedInputRow([{ semanticInput: document([explain]) }, { text: "plain follow-up" }], ADMITTED_SUBMISSION)

        expect(row.text).toBe("/explain-changes\n\nplain follow-up")
        expect(row.submittedInputs).toEqual([
            { segments: [{ text: "/explain-changes", role: "command", active: true }] },
            { segments: [{ text: "plain follow-up", role: "text", active: false }] },
        ])
    })

    it("leaves a legacy row without facts and keeps its flat attachments", () => {
        const row = submittedInputRow(
            [{ text: "/compact", images: ["data:image/png;base64,AA"], files: ["/a.txt"] }],
            ADMITTED_SUBMISSION,
        )

        expect(row).toEqual({ text: "/compact", images: ["data:image/png;base64,AA"], files: ["/a.txt"] })
        expect(rowHasVisibleContent(row)).toBe(true)
    })

    // A dialog reply arrives here after its resources were resolved for the receiver;
    // the row names each resource once, in its text, and never as a second thumbnail.
    it("drops what a document's resources resolved to and keeps a text-only document's attachments", () => {
        const shot: SemanticInputNode = { kind: "image", entityId: "img-1", resourceId: "res-1", displayName: "shot.png" }
        const resolved = submittedInputRow(
            [{ semanticInput: document([shot]), images: ["data:image/png;base64,AA"], files: ["/tmp/shot.png"] }],
            REPLY_AS_TYPED,
        )
        const textOnly = submittedInputRow(
            [{ semanticInput: document([{ kind: "text", text: "see attached" } as SemanticInputNode]), images: ["data:x"] }],
            REPLY_AS_TYPED,
        )

        expect(resolved).toMatchObject({ text: "[shot.png]", images: [], files: [] })
        expect(textOnly.images).toEqual(["data:x"])
    })

    it("treats a row with only whitespace and no attachments as empty", () => {
        expect(rowHasVisibleContent(submittedInputRow([{ text: "  " }], REPLY_AS_TYPED))).toBe(false)
    })
})

describe("isSubmittedInputFacts", () => {
    it("accepts well-formed facts and rejects an unknown role or a missing flag", () => {
        expect(isSubmittedInputFacts({ segments: [{ text: "a", role: "text", active: false }] })).toBe(true)
        expect(isSubmittedInputFacts({ segments: [{ text: "a", role: "macro", active: false }] })).toBe(false)
        expect(isSubmittedInputFacts({ segments: [{ text: "a", role: "text" }] })).toBe(false)
        expect(isSubmittedInputFacts(null)).toBe(false)
    })
})

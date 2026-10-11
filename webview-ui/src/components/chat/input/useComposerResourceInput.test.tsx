import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog } from "@shared/input-semantics/catalog"
import type { SemanticResourceRef } from "@shared/input-semantics/document"
import { InputResourceKind, InputResourceStageResults } from "@shared/proto/dline/file"
import { toProtoSemanticResourceRef } from "@shared/proto-conversions/input-semantics/document"
import { renderHook } from "@testing-library/react"
import type React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createReadyResourceAtom } from "./semantic-composer/atoms"
import { COMPOSER_FRAGMENT_MIME } from "./semantic-composer/clipboard"
import { SemanticComposerEngine } from "./semantic-composer/engine"
import { ATOM_PLACEHOLDER, caretAt, flatTextOf, resourceAtomsOf, stateFromText } from "./semantic-composer/model"
import { composerSendBlock } from "./semantic-composer/send-draft"
import { type ComposerResourceInputOptions, useComposerResourceInput } from "./useComposerResourceInput"

const client = vi.hoisted(() => ({
    stageInputBytes: vi.fn(),
    stageInputUris: vi.fn(),
    stageInputText: vi.fn(),
    selectInputResources: vi.fn(),
    openInputResource: vi.fn(),
    getRelativePaths: vi.fn(),
}))

vi.mock("@/services/grpc-client", () => ({ FileServiceClient: client }))

const CATALOG = { revision: 1, descriptors: BUILTIN_INPUT_SEMANTICS } as unknown as InputSemanticCatalog
const DRAFT_ID = "draft-1"

function refOf(resourceId: string): SemanticResourceRef {
    return {
        resourceId,
        expectedContentHash: `sha256:${resourceId}`,
        mediaType: "text/plain",
        byteLength: 4,
        owner: { kind: "draft", draftId: DRAFT_ID },
        generation: 1,
    }
}

function stagedText(resourceId: string): InputResourceStageResults {
    return InputResourceStageResults.create({
        results: [
            {
                staged: {
                    ref: toProtoSemanticResourceRef(refOf(resourceId)),
                    displayName: "pasted.txt",
                    kind: InputResourceKind.INPUT_RESOURCE_KIND_PASTED_TEXT,
                },
            },
        ],
    })
}

/** An engine holding "ab" with the caret between the two letters. */
function draftEngine(): SemanticComposerEngine {
    const engine = new SemanticComposerEngine({ initial: stateFromText("ab") })
    engine.apply({ type: "select", selection: caretAt(1) })
    return engine
}

function setup(engine: SemanticComposerEngine, overrides: Partial<ComposerResourceInputOptions> = {}) {
    const options: ComposerResourceInputOptions = {
        engine,
        draftId: DRAFT_ID,
        catalog: CATALOG,
        attachmentsEnabled: true,
        freeSlots: 5,
        imagesAllowed: true,
        onRejectedFiles: vi.fn(),
        onOversizedImages: vi.fn(),
        onRefusedText: vi.fn(),
        onAttachmentLimit: vi.fn(),
        ...overrides,
    }
    return renderHook(() => useComposerResourceInput(options)).result.current
}

function paste(text: string, types: string[] = ["text/plain"]) {
    const preventDefault = vi.fn()
    const event = {
        preventDefault,
        clipboardData: { types, files: [], items: [], getData: (type: string) => (type === "text/plain" ? text : "") },
    } as unknown as React.ClipboardEvent<HTMLDivElement>
    return { event, preventDefault }
}

function drop(data: Record<string, string>) {
    const preventDefault = vi.fn()
    const event = {
        preventDefault,
        dataTransfer: { files: [], getData: (type: string) => data[type] ?? "" },
    } as unknown as React.DragEvent
    return { event, preventDefault }
}

/** An engine whose draft already holds `count` ready attachments, with the caret at its end. */
function engineWithResources(count: number): SemanticComposerEngine {
    const engine = new SemanticComposerEngine()
    for (let index = 0; index < count; index++) {
        engine.apply({
            type: "insert_atom",
            atom: createReadyResourceAtom({
                ref: refOf(`res-${index}`),
                displayName: `file-${index}.md`,
                nodeKind: "file",
                fileOrigin: "uploaded_file",
            }),
        })
    }
    return engine
}

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("useComposerResourceInput paste", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        client.stageInputText.mockResolvedValue(stagedText("res-paste"))
    })

    it.each([
        ["19 lines", lines(19)],
        ["4999 ASCII bytes", "x".repeat(4999)],
        ["4999 UTF-8 bytes of CJK text", `${"中".repeat(1666)}x`],
    ])("leaves a paste of %s to the editor as inline text", (_label, text) => {
        const engine = draftEngine()
        const { event, preventDefault } = paste(text)

        setup(engine).handlePaste(event)

        expect(preventDefault).not.toHaveBeenCalled()
        expect(client.stageInputText).not.toHaveBeenCalled()
        expect(flatTextOf(engine.getState().segments)).toBe("ab")
    })

    it.each([
        ["20 lines", lines(20)],
        ["5000 ASCII bytes", "x".repeat(5000)],
        ["5000 UTF-8 bytes of CJK text", `${"中".repeat(1666)}xx`],
    ])("stages a paste of %s as a text resource where it was pasted", async (_label, text) => {
        const engine = draftEngine()
        const { event, preventDefault } = paste(text)

        setup(engine).handlePaste(event)
        await flush()

        expect(preventDefault).toHaveBeenCalledOnce()
        expect(client.stageInputText).toHaveBeenCalledWith(expect.objectContaining({ draftId: DRAFT_ID, text }))
        expect(flatTextOf(engine.getState().segments)).toBe(`a${ATOM_PLACEHOLDER}b`)
        expect(resourceAtomsOf(engine.getState().segments)).toEqual([
            expect.objectContaining({ status: "ready", fileOrigin: "pasted_text", ref: refOf("res-paste") }),
        ])
    })

    it("makes a staged long paste sendable on every path once it is ready", async () => {
        const engine = draftEngine()
        setup(engine).handlePaste(paste(lines(20)).event)
        await flush()

        const segments = engine.getState().segments
        expect(composerSendBlock(segments)).toBeUndefined()
        expect(engine.getState().segments).toBe(segments)
    })

    it.each([
        ["the draft cannot take attachments", { attachmentsEnabled: false }],
        ["every attachment slot is taken", { freeSlots: 0 }],
    ])("refuses a long paste instead of inlining it when %s", (_label, overrides) => {
        const engine = draftEngine()
        const onRefusedText = vi.fn()
        const { event, preventDefault } = paste(lines(20))

        setup(engine, { ...overrides, onRefusedText }).handlePaste(event)

        expect(preventDefault).toHaveBeenCalledOnce()
        expect(onRefusedText).toHaveBeenCalledOnce()
        expect(client.stageInputText).not.toHaveBeenCalled()
        expect(flatTextOf(engine.getState().segments)).toBe("ab")
    })

    it("refuses a long paste that reaches it only as an insertion when no resource can be added", () => {
        const engine = draftEngine()
        const onRefusedText = vi.fn()

        const claimed = setup(engine, { attachmentsEnabled: false, onRefusedText }).handlePastedText(lines(20), {
            start: 1,
            end: 1,
        })

        expect(claimed).toBe(true)
        expect(onRefusedText).toHaveBeenCalledOnce()
        expect(flatTextOf(engine.getState().segments)).toBe("ab")
    })

    it("treats another draft's fragment as foreign text, so its long plain text is staged", async () => {
        // The editor reinserts only its own fragments and offers every other paste here.
        const engine = draftEngine()
        const { event, preventDefault } = paste(lines(30), ["text/plain", COMPOSER_FRAGMENT_MIME])

        setup(engine).handlePaste(event)
        await flush()

        expect(preventDefault).toHaveBeenCalledOnce()
        expect(client.stageInputText).toHaveBeenCalledWith(expect.objectContaining({ text: lines(30) }))
    })

    it("inserts a pasted URL as pasted text followed by a space", () => {
        const engine = draftEngine()
        const { event, preventDefault } = paste("https://example.com/compact")

        setup(engine).handlePaste(event)

        expect(preventDefault).toHaveBeenCalledOnce()
        expect(engine.getState().segments).toEqual([
            { kind: "text", text: "a", source: "typed" },
            { kind: "text", text: "https://example.com/compact ", source: "pasted" },
            { kind: "text", text: "b", source: "typed" },
        ])
    })

    it("stages pasted file URIs within the room the draft has left, and only claims them when attachments are off", () => {
        const uris = "file:///work/a.md\nfile:///work/b.md\nfile:///work/c.md"
        client.stageInputUris.mockReturnValue(new Promise(() => {}))
        const onAttachmentLimit = vi.fn()

        // 18 of the 20 attachments a message may carry are already in the draft.
        setup(engineWithResources(18), { freeSlots: 2, onAttachmentLimit }).handlePaste(paste(uris).event)
        expect(client.stageInputUris).toHaveBeenCalledWith(
            expect.objectContaining({ draftId: DRAFT_ID, uris: ["file:///work/a.md", "file:///work/b.md"] }),
        )
        expect(onAttachmentLimit).toHaveBeenCalledExactlyOnceWith(1)

        client.stageInputUris.mockClear()
        const disabled = draftEngine()
        const { event, preventDefault } = paste(uris)
        setup(disabled, { attachmentsEnabled: false }).handlePaste(event)
        expect(preventDefault).toHaveBeenCalledOnce()
        expect(client.stageInputUris).not.toHaveBeenCalled()
        expect(flatTextOf(disabled.getState().segments)).toBe("ab")
    })
})

describe("useComposerResourceInput drop", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it("attaches dropped documents and mentions readable files at the drop position", async () => {
        const engine = new SemanticComposerEngine({ initial: stateFromText("abcd") })
        client.stageInputUris.mockReturnValue(new Promise(() => {}))
        client.getRelativePaths.mockResolvedValue({ paths: ["/src/a.ts"] })
        const { event, preventDefault } = drop({
            resourceurls: JSON.stringify(["file:///work/spec.pdf", "file:///work/src/a.ts"]),
        })

        setup(engine).handleDrop(event, 2)
        await flush()

        expect(preventDefault).toHaveBeenCalledOnce()
        expect(client.stageInputUris).toHaveBeenCalledWith(expect.objectContaining({ uris: ["file:///work/spec.pdf"] }))
        expect(client.getRelativePaths).toHaveBeenCalledWith(expect.objectContaining({ uris: ["file:///work/src/a.ts"] }))
        const atoms = engine.getState().segments.flatMap((segment) => (segment.kind === "atom" ? [segment.atom] : []))
        expect(atoms.map((atom) => atom.kind).sort()).toEqual(["mention", "resource"])
        const mention = atoms.find((atom) => atom.kind === "mention")
        expect(mention?.kind === "mention" && mention.sourceText).toContain("src/a.ts")
        // A mention is padded with spaces so it reads as its own word; both land at the drop point.
        expect(flatTextOf(engine.getState().segments).replaceAll(" ", "")).toBe(`ab${ATOM_PLACEHOLDER}${ATOM_PLACEHOLDER}cd`)
    })

    it("inserts dropped text as pasted text at the drop position", () => {
        const engine = new SemanticComposerEngine({ initial: stateFromText("abcd") })

        setup(engine).handleDrop(drop({ text: "/compact" }).event, 2)

        expect(engine.getState().segments).toEqual([
            { kind: "text", text: "ab", source: "typed" },
            { kind: "text", text: "/compact", source: "pasted" },
            { kind: "text", text: "cd", source: "typed" },
        ])
    })

    it("stages dropped text too long to inline as a text resource, like a paste", async () => {
        const engine = new SemanticComposerEngine({ initial: stateFromText("abcd") })
        client.stageInputText.mockResolvedValue(stagedText("res-drop"))

        setup(engine).handleDrop(drop({ text: lines(20) }).event, 2)
        await flush()

        expect(client.stageInputText).toHaveBeenCalledWith(expect.objectContaining({ draftId: DRAFT_ID, text: lines(20) }))
        expect(flatTextOf(engine.getState().segments)).toBe(`ab${ATOM_PLACEHOLDER}cd`)
    })

    it("drops at the caret when the drop offset is unknown", () => {
        const engine = draftEngine()

        setup(engine).handleDrop(drop({ text: "x" }).event, undefined)

        expect(flatTextOf(engine.getState().segments)).toBe("axb")
    })
})

describe("useComposerResourceInput file dialog", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        client.selectInputResources.mockResolvedValue(InputResourceStageResults.create({ results: [] }))
    })

    it("opens the dialog with the draft, image permission and free slots", () => {
        setup(draftEngine(), { imagesAllowed: false, freeSlots: 2 }).selectResources()
        expect(client.selectInputResources).toHaveBeenCalledWith(
            expect.objectContaining({ draftId: DRAFT_ID, imagesAllowed: false, maxCount: 2 }),
        )
    })

    it.each([
        ["the draft cannot take attachments", { attachmentsEnabled: false }],
        ["no attachment slot is free", { freeSlots: 0 }],
    ])("does not open the dialog when %s", (_label, overrides) => {
        setup(draftEngine(), overrides).selectResources()
        expect(client.selectInputResources).not.toHaveBeenCalled()
    })
})

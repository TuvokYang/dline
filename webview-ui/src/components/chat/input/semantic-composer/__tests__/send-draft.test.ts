import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog } from "@shared/input-semantics/catalog"
import { describe, expect, it } from "vitest"
import { createCommandAtom } from "../atoms"
import type { ComposerSegment, ResourceAtom } from "../model"
import { captureComposerSend, composerSendBlock, describeSendBlock } from "../send-draft"

const CATALOG = { revision: 1, descriptors: BUILTIN_INPUT_SEMANTICS } as unknown as InputSemanticCatalog

const typed = (text: string): ComposerSegment => ({ kind: "text", text, source: "typed" })

function resource(entityId: string, status: ResourceAtom["status"]): ComposerSegment {
    return {
        kind: "atom",
        atom: {
            kind: "resource",
            entityId,
            nodeKind: "file",
            fileOrigin: "uploaded_file",
            displayName: `${entityId}.txt`,
            status,
        },
    }
}

describe("composerSendBlock", () => {
    it("lets a draft without attachments through on every path", () => {
        expect(composerSendBlock([typed("hello")], false)).toBeUndefined()
        expect(composerSendBlock([typed("hello")], true)).toBeUndefined()
    })

    it("waits for staging before reporting a failure", () => {
        expect(composerSendBlock([resource("a", "failed"), resource("b", "staging")])).toBe("staging")
    })

    it("refuses a failed attachment", () => {
        expect(composerSendBlock([typed("see "), resource("a", "failed")])).toBe("failed")
    })

    it("sends ready attachments on every path", () => {
        expect(composerSendBlock([typed("see "), resource("a", "ready")])).toBeUndefined()
    })
})

describe("captureComposerSend", () => {
    it("freezes the very segments it was given", () => {
        const segments = [typed("hello")]
        const capture = captureComposerSend(segments, { catalog: CATALOG, documentId: "doc-1" })

        expect(capture).toEqual({ ok: true, draft: { segments, text: "hello", images: [], files: [] } })
        if (capture.ok) expect(capture.draft.segments).toBe(segments)
    })

    it("sends a typed command as text alone, since the host reads the same command from it", () => {
        const capture = captureComposerSend([typed("/compact now")], { catalog: CATALOG, documentId: "doc-2" })

        expect(capture).toEqual({ ok: true, draft: expect.objectContaining({ text: "/compact now" }) })
        if (capture.ok) expect(capture.draft.semanticInput).toBeUndefined()
    })

    it("carries the document of a picked command under the draft's document identity", () => {
        const command = createCommandAtom(CATALOG, "command.compact", "/cmd:compact")
        if (!command) throw new Error("Expected the built-in compact command")
        const capture = captureComposerSend([{ kind: "atom", atom: command }, typed(" now")], {
            catalog: CATALOG,
            documentId: "doc-2",
        })

        expect(capture.ok).toBe(true)
        if (!capture.ok) return
        expect(capture.draft.semanticInput?.documentId).toBe("doc-2")
        expect(capture.draft.semanticInput?.nodes).toContainEqual(
            expect.objectContaining({ kind: "slash_command", commandId: "command.compact", state: "recognized" }),
        )
    })

    it("returns the block instead of a draft", () => {
        const capture = captureComposerSend([resource("a", "staging")], { catalog: CATALOG, documentId: "doc-3" })

        expect(capture).toEqual({ ok: false, block: "staging" })
    })
})

describe("describeSendBlock", () => {
    it("explains each block differently", () => {
        const messages = (["staging", "failed"] as const).map((refusal) => describeSendBlock(refusal))

        expect(new Set(messages).size).toBe(2)
        for (const message of messages) expect(message.length).toBeGreaterThan(0)
    })

    // A task another window holds never becomes ready here, so it must not be told to wait.
    it("names a read-only task instead of asking the user to wait", () => {
        const waiting = describeSendBlock("input_not_ready")
        const readOnly = describeSendBlock("input_not_ready", { taskReadOnly: true })

        expect(waiting).toContain("cannot take input yet")
        expect(readOnly).toContain("read-only")
        expect(readOnly).toContain("another Dline window")
        expect(readOnly).not.toContain("once the input is ready")
    })
})

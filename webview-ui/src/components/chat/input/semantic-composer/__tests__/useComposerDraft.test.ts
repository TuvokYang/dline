import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { ComposerSegment } from "../model"
import { owningDraftOf, useComposerDraft } from "../useComposerDraft"

const DRAFT_A = "00000000-0000-4000-8000-00000000000a"
const DRAFT_B = "00000000-0000-4000-8000-00000000000b"

function readyResource(entityId: string, owner: { kind: "draft"; draftId: string } | { kind: "task"; taskId: string }) {
    return {
        kind: "atom",
        atom: {
            kind: "resource",
            entityId,
            nodeKind: "image",
            fileOrigin: "pasted_file",
            displayName: `${entityId}.png`,
            status: "ready",
            ref: {
                resourceId: `res-${entityId}`,
                expectedContentHash: "sha256:abc",
                mediaType: "image/png",
                byteLength: 3,
                owner,
                generation: 1,
            },
        },
    } satisfies ComposerSegment
}

const typed = (text: string): ComposerSegment => ({ kind: "text", text, source: "typed" })

describe("owningDraftOf", () => {
    it("names the one draft that owns every draft-owned resource", () => {
        expect(owningDraftOf([typed("see "), readyResource("a", { kind: "draft", draftId: DRAFT_A })])).toBe(DRAFT_A)
    })

    it("ignores task-owned resources, which no draft identity can submit", () => {
        expect(owningDraftOf([readyResource("t", { kind: "task", taskId: "task-1" })])).toBeUndefined()
    })

    it("adopts no owner when resources belong to several drafts", () => {
        expect(
            owningDraftOf([
                readyResource("a", { kind: "draft", draftId: DRAFT_A }),
                readyResource("b", { kind: "draft", draftId: DRAFT_B }),
            ]),
        ).toBeUndefined()
    })
})

describe("useComposerDraft", () => {
    it("keeps the owner of a refused draft's resources when the draft is put back", () => {
        const { result } = renderHook(() => useComposerDraft())

        let identity: ReturnType<typeof result.current.load> | undefined
        act(() => {
            identity = result.current.load([typed("look "), readyResource("a", { kind: "draft", draftId: DRAFT_A })])
        })

        expect(identity?.draftId).toBe(DRAFT_A)
        expect(result.current.draftId).toBe(DRAFT_A)
    })

    it("starts a fresh draft identity for a draft without draft-owned resources", () => {
        const { result } = renderHook(() => useComposerDraft())
        const before = result.current.draftId

        act(() => {
            result.current.load([typed("plain")])
        })

        expect(result.current.draftId).not.toBe(before)
        expect(result.current.draftId).not.toBe(DRAFT_A)
    })

    it("renews the document identity on every load, even when the owner is kept", () => {
        const { result } = renderHook(() => useComposerDraft())
        const segments = [readyResource("a", { kind: "draft", draftId: DRAFT_A })]

        act(() => {
            result.current.load(segments)
        })
        const firstDocument = result.current.documentId
        act(() => {
            result.current.load(segments)
        })

        expect(result.current.draftId).toBe(DRAFT_A)
        expect(result.current.documentId).not.toBe(firstDocument)
    })

    it("shows a send refusal until the draft it answered is edited", () => {
        const { result } = renderHook(() => useComposerDraft())
        act(() => {
            result.current.load([typed("hello")])
        })

        act(() => {
            result.current.reportSendRefusal("input_not_ready")
        })
        expect(result.current.sendRefusal).toBe("input_not_ready")

        act(() => {
            result.current.setText("hello again")
        })
        expect(result.current.sendRefusal).toBeUndefined()
    })
})

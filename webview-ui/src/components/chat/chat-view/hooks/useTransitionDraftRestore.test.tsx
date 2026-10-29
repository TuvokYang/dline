import type { TransitionDraftProjection } from "@shared/TransitionDraft"
import { renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { isTransitionRunning, useTransitionDraftRestore } from "./useTransitionDraftRestore"

interface Props {
    taskId: string | undefined
    transitionDraft: TransitionDraftProjection | undefined
    transitionRunning: boolean
    composerBlank: boolean
}

const KEPT: TransitionDraftProjection = {
    taskId: "task-1",
    draftId: "draft-1",
    text: "kept reply",
    images: ["image"],
    files: [],
}

function renderRestore(initial: Props) {
    const restoreDraft = vi.fn()
    const view = renderHook((props: Props) => useTransitionDraftRestore({ ...props, restoreDraft }), {
        initialProps: initial,
    })
    return { ...view, restoreDraft }
}

const OPENED: Props = { taskId: "task-1", transitionDraft: KEPT, transitionRunning: false, composerBlank: true }

describe("useTransitionDraftRestore", () => {
    it("gives a blank composer back the draft the task kept when the view opened", () => {
        const { restoreDraft } = renderRestore(OPENED)

        expect(restoreDraft).toHaveBeenCalledWith({ text: "kept reply", images: ["image"], files: [] })
    })

    it("restores the kept document with the text", () => {
        const semanticInput = { documentId: "document-1" } as TransitionDraftProjection["semanticInput"]
        const { restoreDraft } = renderRestore({ ...OPENED, transitionDraft: { ...KEPT, semanticInput } })

        expect(restoreDraft).toHaveBeenCalledWith(expect.objectContaining({ semanticInput }))
    })

    it("restores at most once", () => {
        const { restoreDraft, rerender } = renderRestore(OPENED)
        rerender({ ...OPENED, composerBlank: true, transitionDraft: { ...KEPT } })

        expect(restoreDraft).toHaveBeenCalledOnce()
    })

    it("never writes over text typed since", () => {
        const { restoreDraft, rerender } = renderRestore({ ...OPENED, composerBlank: false })
        rerender({ ...OPENED, composerBlank: true })

        expect(restoreDraft).not.toHaveBeenCalled()
    })

    it("waits while a switch still carries the draft, then restores it", () => {
        const { restoreDraft, rerender } = renderRestore({ ...OPENED, transitionRunning: true })
        expect(restoreDraft).not.toHaveBeenCalled()

        rerender(OPENED)

        expect(restoreDraft).toHaveBeenCalledOnce()
    })

    it("does not restore a draft the dialog took while the switch ran", () => {
        const { restoreDraft, rerender } = renderRestore({ ...OPENED, transitionRunning: true })
        // The switch ends with the draft delivered, so the task no longer keeps it.
        rerender({ ...OPENED, transitionDraft: undefined })

        expect(restoreDraft).not.toHaveBeenCalled()
    })

    it("leaves a draft recorded while this view is open to the composer that still holds it", () => {
        const { restoreDraft, rerender } = renderRestore({ ...OPENED, transitionDraft: undefined, composerBlank: false })
        // The switch records the draft while its confirmation is shown.
        rerender({ ...OPENED, transitionRunning: true, composerBlank: false })
        rerender({ ...OPENED, composerBlank: false })
        // Emptying the composer afterwards does not bring the considered draft back.
        rerender(OPENED)

        expect(restoreDraft).not.toHaveBeenCalled()
    })

    it("restores a kept draft that arrives after the view opened", () => {
        const { restoreDraft, rerender } = renderRestore({ ...OPENED, transitionDraft: undefined })
        expect(restoreDraft).not.toHaveBeenCalled()

        rerender(OPENED)

        expect(restoreDraft).toHaveBeenCalledOnce()
    })

    it("considers each newly recorded draft once", () => {
        const { restoreDraft, rerender } = renderRestore({ ...OPENED, composerBlank: false })
        rerender({ ...OPENED, transitionDraft: { ...KEPT, draftId: "draft-2", text: "second" } })

        expect(restoreDraft).toHaveBeenCalledOnce()
        expect(restoreDraft).toHaveBeenCalledWith(expect.objectContaining({ text: "second" }))
    })

    it("ignores a draft kept for another task and considers each newly shown task afresh", () => {
        const { restoreDraft, rerender } = renderRestore({ ...OPENED, taskId: "task-2" })
        expect(restoreDraft).not.toHaveBeenCalled()

        rerender({ ...OPENED, taskId: undefined, transitionDraft: undefined })
        rerender(OPENED)

        expect(restoreDraft).toHaveBeenCalledOnce()
    })
})

describe("isTransitionRunning", () => {
    it("treats only an active phase as carrying the draft", () => {
        expect(isTransitionRunning(undefined)).toBe(false)
        expect(isTransitionRunning("idle")).toBe(false)
        expect(isTransitionRunning("failed")).toBe(false)
        expect(isTransitionRunning("awaiting_confirmation")).toBe(true)
        expect(isTransitionRunning("compacting")).toBe(true)
    })
})

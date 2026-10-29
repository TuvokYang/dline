import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { InteractionDraft } from "@/task-interaction/types"
import { useComposerDraftKeepAlive } from "../useComposerDraftKeepAlive"

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))

vi.mock("@/config/platform.config", () => ({
    webviewState: {
        get: () => store.state,
        patch: (changes: Record<string, unknown>) => {
            const next = { ...store.state, ...changes }
            for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key]
            store.state = next
        },
    },
}))

const EMPTY: InteractionDraft = { text: "", images: [], files: [], activeQuote: null }
const draft = (text: string): InteractionDraft => ({ text, images: [], files: [], activeQuote: null })

function keepAlive(props: { taskId?: string; draft: InteractionDraft; composerBlank: boolean }) {
    const restoreDraft = vi.fn()
    const hook = renderHook((current: typeof props) => useComposerDraftKeepAlive({ ...current, restoreDraft }), {
        initialProps: props,
    })
    return { ...hook, restoreDraft }
}

describe("useComposerDraftKeepAlive", () => {
    beforeEach(() => {
        store.state = { taskId: "panel-task" }
    })

    it("keeps the draft beside other webview state and drops it once the composer empties", () => {
        const { rerender } = keepAlive({ taskId: "t1", draft: draft("unsent"), composerBlank: false })
        expect(store.state).toEqual({ taskId: "panel-task", composerDraft: { taskId: "t1", draft: draft("unsent") } })

        rerender({ taskId: "t1", draft: EMPTY, composerBlank: true })
        expect(store.state).toEqual({ taskId: "panel-task" })
    })

    it("restores a kept draft once the reloaded view shows the task it was written in", () => {
        store.state = { composerDraft: { taskId: "t1", draft: draft("unsent") } }
        const { rerender, restoreDraft } = keepAlive({ draft: EMPTY, composerBlank: true })

        // The welcome view comes first and must neither take nor erase the draft.
        expect(restoreDraft).not.toHaveBeenCalled()
        expect(store.state).toEqual({ composerDraft: { taskId: "t1", draft: draft("unsent") } })

        rerender({ taskId: "t1", draft: EMPTY, composerBlank: true })
        expect(restoreDraft).toHaveBeenCalledExactlyOnceWith(draft("unsent"))
    })

    it("does not overwrite what the user already typed after the reload", () => {
        store.state = { composerDraft: { taskId: "t1", draft: draft("unsent") } }
        const { restoreDraft } = keepAlive({ taskId: "t1", draft: draft("typed"), composerBlank: false })

        expect(restoreDraft).not.toHaveBeenCalled()
        expect(store.state).toEqual({ composerDraft: { taskId: "t1", draft: draft("typed") } })
    })

    it("ignores a malformed kept value", () => {
        store.state = { composerDraft: { taskId: 1, draft: { text: 2 } } }
        const { restoreDraft } = keepAlive({ taskId: undefined, draft: EMPTY, composerBlank: true })

        expect(restoreDraft).not.toHaveBeenCalled()
    })
})

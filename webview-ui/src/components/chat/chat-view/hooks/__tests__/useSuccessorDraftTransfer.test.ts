import type { TaskHandoffSource } from "@shared/ExtensionMessage"
import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { InteractionDraft, PendingSuccessorDraftTransfer } from "@/task-interaction/types"
import { useSuccessorDraftTransfer } from "../useSuccessorDraftTransfer"

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

const draft: InteractionDraft = { text: "unsent", images: [], files: [], activeQuote: null }
const transfer: PendingSuccessorDraftTransfer = { sourceTaskId: "source", interactionId: "tid-1", draft }
const successorOpening: TaskHandoffSource = { taskId: "source", interactionId: "tid-1" }

interface Surface {
    taskId?: string
    projectedTaskId?: string
    handoffSource?: TaskHandoffSource
    composerBlank?: boolean
}

function mount(surface: Surface) {
    const restoreDraft = vi.fn()
    const hook = renderHook(
        ({ composerBlank = true, ...current }: Surface) => useSuccessorDraftTransfer({ ...current, composerBlank, restoreDraft }),
        { initialProps: surface },
    )
    return { ...hook, restoreDraft }
}

describe("useSuccessorDraftTransfer", () => {
    beforeEach(() => {
        store.state = { taskId: "panel-task" }
    })

    it("restores a retained draft into the successor its handoff opened and then forgets it", () => {
        const { result, rerender, restoreDraft } = mount({ taskId: "source", projectedTaskId: "source" })

        act(() => result.current(transfer))
        expect(store.state).toEqual({ taskId: "panel-task", successorDraft: transfer })
        expect(restoreDraft).not.toHaveBeenCalled()

        rerender({ taskId: "successor", projectedTaskId: "successor", handoffSource: successorOpening })
        expect(restoreDraft).toHaveBeenCalledExactlyOnceWith(draft)
        expect(store.state).toEqual({ taskId: "panel-task" })
    })

    // The source is torn down while the successor starts; a reload in that
    // window starts a new document, which must still hand the draft over.
    it("hands the draft over after a reload during the handoff", () => {
        store.state = { taskId: "panel-task", successorDraft: transfer }

        const { rerender, restoreDraft } = mount({})
        expect(restoreDraft).not.toHaveBeenCalled()

        rerender({ taskId: "successor", projectedTaskId: "successor", handoffSource: successorOpening })
        expect(restoreDraft).toHaveBeenCalledExactlyOnceWith(draft)
        expect(store.state).toEqual({ taskId: "panel-task" })
    })

    // Whatever the composer already holds wins, as with the composer's other restores.
    it("drops the draft rather than overwrite a composer that is no longer blank", () => {
        store.state = { successorDraft: transfer }

        const { rerender, restoreDraft } = mount({})
        rerender({ taskId: "successor", projectedTaskId: "successor", handoffSource: successorOpening, composerBlank: false })

        expect(restoreDraft).not.toHaveBeenCalled()
        expect(store.state).toEqual({})
    })

    it("drops the draft when another task is shown instead of the successor", () => {
        store.state = { successorDraft: transfer }

        const { rerender, restoreDraft } = mount({ taskId: "source", projectedTaskId: "source" })
        rerender({ taskId: "other", projectedTaskId: "other" })

        expect(restoreDraft).not.toHaveBeenCalled()
        expect(store.state).toEqual({})
    })

    it("ignores a malformed retained value", () => {
        store.state = { successorDraft: { sourceTaskId: "source", draft: { text: 1 } } }

        const { restoreDraft } = mount({ taskId: "successor", projectedTaskId: "successor", handoffSource: successorOpening })

        expect(restoreDraft).not.toHaveBeenCalled()
    })
})

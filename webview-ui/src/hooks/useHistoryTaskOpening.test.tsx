import type { TaskViewState } from "@shared/ExtensionMessage"
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useHistoryTaskOpening } from "./useHistoryTaskOpening"

function deferred() {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((done, fail) => {
        resolve = done
        reject = fail
    })
    return { promise, resolve, reject }
}
const view = (taskId: string, taskInstanceId: string) => ({ taskId, taskInstanceId }) as TaskViewState

function harness(initialView = view("old", "old-opening")) {
    const requests = [deferred(), deferred()]
    const requestOpen = vi.fn().mockReturnValueOnce(requests[0].promise).mockReturnValueOnce(requests[1].promise)
    const onOpenFailed = vi.fn()
    const hook = renderHook(
        ({ taskViewState }: { taskViewState?: TaskViewState }) =>
            useHistoryTaskOpening({ taskViewState, requestOpen, onOpenFailed }),
        { initialProps: { taskViewState: initialView } },
    )
    return { ...hook, requests, requestOpen, onOpenFailed }
}

describe("useHistoryTaskOpening", () => {
    it("keeps local loading on the source surface until the matching canonical opening arrives", async () => {
        const { result, rerender, requestOpen } = harness()
        act(() => result.current.openHistoryTask({ id: "next", task: "Saved next task" }))
        expect(result.current.historyTaskOpening?.status).toBe("loading")
        await act(async () => {
            await Promise.resolve()
        })
        expect(requestOpen).toHaveBeenCalledWith("next")
        rerender({ taskViewState: view("next", "new-opening") })
        expect(result.current.historyTaskOpening).toBeUndefined()
    })

    it("does not accept the old opening when reopening the same task", () => {
        const { result, rerender } = harness(view("same", "opening-1"))
        act(() => result.current.openHistoryTask({ id: "same", task: "Same task" }))
        rerender({ taskViewState: view("same", "opening-1") })
        expect(result.current.historyTaskOpening?.status).toBe("loading")
        rerender({ taskViewState: view("same", "opening-2") })
        expect(result.current.historyTaskOpening).toBeUndefined()
    })

    it("ignores stale failures and reports a current failure without changing the source surface", async () => {
        const { result, requests, rerender, onOpenFailed } = harness()
        act(() => result.current.openHistoryTask({ id: "first", task: "First" }))
        act(() => result.current.openHistoryTask({ id: "second", task: "Second" }))
        await act(async () => {
            requests[0].reject(new Error("old request failed"))
        })
        rerender({ taskViewState: view("first", "first-opening") })
        expect(result.current.historyTaskOpening).toMatchObject({ target: { id: "second" }, status: "loading" })
        await act(async () => {
            requests[1].reject(new Error("current request failed"))
        })
        expect(result.current.historyTaskOpening).toBeUndefined()
        expect(onOpenFailed).toHaveBeenCalledOnce()
        expect(onOpenFailed).toHaveBeenCalledWith(expect.objectContaining({ id: "second" }), expect.any(Error))
    })

    it("allows a later explicit open and ignores a late failure after dismissal", async () => {
        const { result, requests, requestOpen, onOpenFailed } = harness()
        const target = { id: "next", task: "Next" }
        act(() => result.current.openHistoryTask(target))
        await act(async () => {
            requests[0].reject(new Error("failed"))
        })
        expect(result.current.historyTaskOpening).toBeUndefined()
        expect(onOpenFailed).toHaveBeenCalledOnce()
        act(() => result.current.openHistoryTask(target))
        expect(result.current.historyTaskOpening?.status).toBe("loading")
        act(() => result.current.dismissHistoryTaskOpening())
        await act(async () => {
            requests[1].reject(new Error("late"))
        })
        expect(result.current.historyTaskOpening).toBeUndefined()
        expect(requestOpen).toHaveBeenCalledTimes(2)
    })

    it("does not resurrect feedback when the canonical opening is closed before a late RPC failure", async () => {
        const { result, requests, rerender } = harness()
        act(() => result.current.openHistoryTask({ id: "next", task: "Next" }))
        rerender({ taskViewState: view("next", "new-opening") })
        expect(result.current.historyTaskOpening).toBeUndefined()
        // Close is an explicit user action; an empty state alone also occurs on load failure.
        act(() => result.current.dismissHistoryTaskOpening())
        rerender({ taskViewState: undefined })
        await act(async () => {
            requests[0].reject(new Error("closed during hydration"))
        })
        expect(result.current.historyTaskOpening).toBeUndefined()
    })

    it("does not remove source loading merely because the RPC finished before canonical state", async () => {
        const { result, requests, rerender } = harness()
        act(() => result.current.openHistoryTask({ id: "next", task: "Next" }))
        await act(async () => {
            requests[0].resolve()
        })
        expect(result.current.historyTaskOpening?.status).toBe("loading")
        rerender({ taskViewState: view("next", "new-opening") })
        expect(result.current.historyTaskOpening).toBeUndefined()
    })
})

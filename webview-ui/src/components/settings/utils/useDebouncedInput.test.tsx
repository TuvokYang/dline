import { act, renderHook } from "@testing-library/react"
import { flushPendingDebouncedInputs, useDebouncedInput } from "./useDebouncedInput"

describe("useDebouncedInput", () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it("does not persist the initial value on mount", () => {
        const onChange = vi.fn()
        renderHook(() => useDebouncedInput("initial", onChange))

        act(() => vi.advanceTimersByTime(100))

        expect(onChange).not.toHaveBeenCalled()
    })

    it("persists a user edit after the debounce delay", async () => {
        const onChange = vi.fn()
        const { result } = renderHook(() => useDebouncedInput("initial", onChange))

        act(() => result.current[1]("edited"))
        await act(async () => vi.advanceTimersByTimeAsync(99))
        expect(onChange).not.toHaveBeenCalled()

        await act(async () => vi.advanceTimersByTimeAsync(1))
        expect(onChange).toHaveBeenCalledOnce()
        expect(onChange).toHaveBeenCalledWith("edited")
    })

    it("synchronizes an external value without persisting it back", () => {
        const onChange = vi.fn()
        const { result, rerender } = renderHook(({ initialValue }) => useDebouncedInput(initialValue, onChange), {
            initialProps: { initialValue: "initial" },
        })

        rerender({ initialValue: "external" })
        act(() => vi.advanceTimersByTime(100))

        expect(result.current[0]).toBe("external")
        expect(onChange).not.toHaveBeenCalled()
    })

    it("keeps accepting external values after an edit round-trips through the backend", async () => {
        const onChange = vi.fn()
        const { result, rerender } = renderHook(({ initialValue }) => useDebouncedInput(initialValue, onChange), {
            initialProps: { initialValue: "2" },
        })

        act(() => result.current[1]("2.5"))
        await act(async () => vi.advanceTimersByTimeAsync(100))
        expect(onChange).toHaveBeenCalledWith("2.5")

        // The backend echoes the saved value back, which must not be mistaken for
        // an uncommitted draft; otherwise the field detaches from external state.
        rerender({ initialValue: "2.5" })
        rerender({ initialValue: "7" })

        expect(result.current[0]).toBe("7")
    })

    it("keeps an uncommitted draft when an unrelated external value arrives", () => {
        const onChange = vi.fn()
        const { result, rerender } = renderHook(({ initialValue }) => useDebouncedInput(initialValue, onChange), {
            initialProps: { initialValue: "initial" },
        })

        act(() => result.current[1]("draft"))
        rerender({ initialValue: "external" })

        expect(result.current[0]).toBe("draft")
    })

    it("flushes a pending edit before the debounce delay", async () => {
        const onChange = vi.fn().mockResolvedValue(undefined)
        const { result } = renderHook(() => useDebouncedInput("initial", onChange))

        act(() => result.current[1]("edited"))
        await act(async () => {
            await result.current[2]()
        })

        expect(onChange).toHaveBeenCalledOnce()
        expect(onChange).toHaveBeenCalledWith("edited")
    })

    it("flushes a pending edit when the hook unmounts", async () => {
        const onChange = vi.fn().mockResolvedValue(undefined)
        const { result, unmount } = renderHook(() => useDebouncedInput("initial", onChange))

        act(() => result.current[1]("edited"))
        unmount()
        await act(async () => {
            await Promise.resolve()
        })

        expect(onChange).toHaveBeenCalledOnce()
        expect(onChange).toHaveBeenCalledWith("edited")
    })

    it("waits for every mounted input before propagating a save failure", async () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
        const firstOnChange = vi.fn().mockRejectedValue(new Error("first save failed"))
        let releaseSecondSave!: () => void
        const secondSave = new Promise<void>((resolve) => {
            releaseSecondSave = resolve
        })
        const secondOnChange = vi.fn(() => secondSave)
        const first = renderHook(() => useDebouncedInput("initial", firstOnChange))
        const second = renderHook(() => useDebouncedInput("initial", secondOnChange))

        act(() => {
            first.result.current[1]("first edit")
            second.result.current[1]("second edit")
        })

        let settled = false
        const flushPromise = flushPendingDebouncedInputs().finally(() => {
            settled = true
        })
        await act(async () => Promise.resolve())

        expect(firstOnChange).toHaveBeenCalledWith("first edit")
        expect(secondOnChange).toHaveBeenCalledWith("second edit")
        expect(settled).toBe(false)

        releaseSecondSave()
        await act(async () => {
            await expect(flushPromise).rejects.toThrow("first save failed")
        })
        expect(settled).toBe(true)

        first.unmount()
        second.unmount()
        consoleError.mockRestore()
    })

    it("propagates asynchronous save failures from an explicit flush", async () => {
        const onChange = vi.fn().mockRejectedValue(new Error("save failed"))
        const { result } = renderHook(() => useDebouncedInput("initial", onChange))

        act(() => result.current[1]("edited"))
        await act(async () => {
            await expect(result.current[2]()).rejects.toThrow("save failed")
        })
    })
})

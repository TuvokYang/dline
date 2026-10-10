// @vitest-environment jsdom
import { renderHook } from "@testing-library/react"
import { vi } from "vitest"
import { useMetaKeyDetection, useShortcut } from "../hooks"

describe("useShortcut", () => {
    it("should call the callback when the shortcut is pressed", () => {
        const callback = vi.fn()

        renderHook(() => useShortcut("Meta+k", callback))

        // Simulate keydown event
        const event = new KeyboardEvent("keydown", { key: "k", metaKey: true })
        window.dispatchEvent(event)

        expect(callback).toHaveBeenCalled()
    })

    it("should not call the callback when the shortcut is not pressed", () => {
        const callback = vi.fn()
        renderHook(() => useShortcut("Meta+k", callback))

        // Simulate different key
        const event = new KeyboardEvent("keydown", { key: "j", metaKey: true })
        window.dispatchEvent(event)

        expect(callback).not.toHaveBeenCalled()
    })

    it("should not call the callback when typing in a text input when disableTextInputs is true", () => {
        const callback = vi.fn()
        renderHook(() => useShortcut("Meta+k", callback, { disableTextInputs: true }))

        // Simulate typing in input
        const input = document.createElement("input")
        const event = new KeyboardEvent("keydown", { key: "k", metaKey: true }) as any
        Object.defineProperty(event, "target", { value: input, writable: false })
        window.dispatchEvent(event)

        expect(callback).not.toHaveBeenCalled()
    })
})

describe("useMetaKeyDetection", () => {
    it("should detect Windows OS and metaKey from platform", () => {
        const { result } = renderHook(() => useMetaKeyDetection("win32"))

        expect(result.current).toEqual(["windows", "Win"])
    })

    it("should detect Mac OS and metaKey from platform", () => {
        const { result } = renderHook(() => useMetaKeyDetection("darwin"))

        expect(result.current).toEqual(["mac", "CMD"])
    })

    it("should detect Linux OS and metaKey from platform", () => {
        const { result } = renderHook(() => useMetaKeyDetection("linux"))

        expect(result.current).toEqual(["linux", "Alt"])
    })
})

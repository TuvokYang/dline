import { afterEach, describe, expect, it, vi } from "vitest"
import { HistoryActivityGate } from "../HistoryActivityGate"

function track(gate: HistoryActivityGate): { readonly opened: () => boolean } {
    let opened = false
    void gate.whenOpen().then(() => {
        opened = true
    })
    return { opened: () => opened }
}

describe("HistoryActivityGate", () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it("opens only on the turn after a window was served, so the window is posted first", async () => {
        const gate = new HistoryActivityGate()
        const state = track(gate)

        gate.openAfterServing()
        await Promise.resolve()
        expect(state.opened()).toBe(false)

        await new Promise((resolve) => setImmediate(resolve))
        expect(state.opened()).toBe(true)
    })

    it("opens after the fallback when the Webview never asks for a window", async () => {
        vi.useFakeTimers()
        const gate = new HistoryActivityGate(2_000)
        const state = track(gate)

        gate.armFallback()
        await vi.advanceTimersByTimeAsync(1_999)
        expect(state.opened()).toBe(false)

        await vi.advanceTimersByTimeAsync(1)
        expect(state.opened()).toBe(true)
    })

    it("stays shut until it is published or served", async () => {
        vi.useFakeTimers()
        const state = track(new HistoryActivityGate(2_000))

        await vi.advanceTimersByTimeAsync(60_000)
        expect(state.opened()).toBe(false)
    })

    it("drops the fallback once it opened, and opening again changes nothing", async () => {
        vi.useFakeTimers()
        const gate = new HistoryActivityGate(2_000)
        const state = track(gate)

        gate.armFallback()
        gate.open()
        gate.open()
        gate.armFallback()
        await vi.advanceTimersByTimeAsync(0)

        expect(state.opened()).toBe(true)
        expect(vi.getTimerCount()).toBe(0)
    })
})

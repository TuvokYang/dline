import type { Writable } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import { writeTerminalOutputFrame } from "../output-stream"

describe("writeTerminalOutputFrame", () => {
    it("rejects when a backpressured writable stream emits an error", async () => {
        let streamError: ((error: Error) => void) | undefined
        const stream = {
            write: vi.fn(() => false),
            once: vi.fn((event: string, listener: (error: Error) => void) => {
                if (event === "error") streamError = listener
                return stream
            }),
            off: vi.fn(() => stream),
        } as unknown as Writable
        const writing = writeTerminalOutputFrame(stream, [{ line: "one", stream: "stdout" }])
        const failure = new Error("synthetic stream failure")

        streamError?.(failure)
        await expect(writing).rejects.toBe(failure)
    })

    it("waits for drain when the writable stream applies backpressure", async () => {
        let drain: (() => void) | undefined
        const stream = {
            write: vi.fn(() => false),
            once: vi.fn((event: string, listener: () => void) => {
                if (event === "drain") drain = listener
                return stream
            }),
            off: vi.fn(() => stream),
        } as unknown as Writable
        let settled = false
        const writing = writeTerminalOutputFrame(stream, [{ line: "one", stream: "stdout" }]).then(() => {
            settled = true
        })

        await Promise.resolve()
        expect(settled).toBe(false)
        expect(stream.write).toHaveBeenCalledWith("[O] one\n")
        drain?.()
        await writing
        expect(settled).toBe(true)
    })
})

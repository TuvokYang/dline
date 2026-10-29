import { describe, expect, it, vi } from "vitest"
import { TokenCountGate } from "../token-count-gate"

function httpError(status: number): Error {
    return Object.assign(new Error(`HTTP ${status}`), { status })
}

describe("TokenCountGate", () => {
    it("returns the counted tokens and keeps counting after a success", async () => {
        const gate = new TokenCountGate("Test")
        const attempt = vi.fn(async () => 1234)

        expect(await gate.count(attempt)).toBe(1234)
        expect(await gate.count(attempt)).toBe(1234)
        expect(attempt).toHaveBeenCalledTimes(2)
    })

    it.each([404, 405])("sends no further request after HTTP %i", async (status) => {
        const gate = new TokenCountGate("Test")
        const attempt = vi.fn(async (): Promise<number> => {
            throw httpError(status)
        })

        expect(await gate.count(attempt)).toBeUndefined()
        expect(await gate.count(attempt)).toBeUndefined()
        expect(attempt).toHaveBeenCalledTimes(1)
    })

    it("reads a statusCode field as well", async () => {
        const gate = new TokenCountGate("Test")
        const attempt = vi.fn(async (): Promise<number> => {
            throw Object.assign(new Error("not found"), { statusCode: 404 })
        })

        await gate.count(attempt)
        await gate.count(attempt)
        expect(attempt).toHaveBeenCalledTimes(1)
    })

    it.each([
        ["HTTP 500", httpError(500)],
        ["HTTP 429", httpError(429)],
        ["a network error without a status", new Error("ECONNRESET")],
        ["a 404 named only in the message", new Error("404 page not found")],
    ])("keeps counting after %s", async (_label, failure) => {
        const gate = new TokenCountGate("Test")
        const attempt = vi.fn<() => Promise<number>>().mockRejectedValueOnce(failure).mockResolvedValueOnce(77)

        expect(await gate.count(attempt)).toBeUndefined()
        expect(await gate.count(attempt)).toBe(77)
        expect(attempt).toHaveBeenCalledTimes(2)
    })

    it("keeps each handler's gate separate", async () => {
        const absent = new TokenCountGate("A")
        const present = new TokenCountGate("B")
        await absent.count(async () => {
            throw httpError(404)
        })
        const attempt = vi.fn(async () => 5)

        expect(await present.count(attempt)).toBe(5)
        expect(attempt).toHaveBeenCalledTimes(1)
    })
})

import { describe, expect, it } from "vitest"
import { providerFailureAttributes, providerFailureClassOf, usageFailureClassOf } from "./provider-failure"

function wrapped(cause: unknown): Error {
    return new Error("Provider request failed", { cause })
}

describe("usageFailureClassOf", () => {
    it.each([
        [{ status: 429 }, "rate_limited"],
        [{ status: 529 }, "provider_unavailable"],
        [{ status: 504 }, "timeout"],
        [{ status: 403 }, "authentication"],
        [{ status: 422 }, "provider_rejected"],
        [Object.assign(new Error("x"), { code: "ECONNRESET" }), "network"],
        [new Error("model refused"), "unknown"],
        [undefined, "unknown"],
    ] as const)("names %o in the Usage failure catalog", (error, expected) => {
        expect(usageFailureClassOf(wrapped(error))).toBe(expected)
    })
})

describe("providerFailureClassOf", () => {
    it.each([
        [429, "rate_limited"],
        [529, "overloaded"],
        [503, "overloaded"],
        [504, "timeout"],
        [401, "auth"],
        [403, "auth"],
        [400, "invalid_request"],
        [500, "other"],
    ] as const)("reads HTTP %i through the wrapper Dline puts around provider errors", (status, expected) => {
        expect(providerFailureClassOf(wrapped(Object.assign(new Error("upstream"), { status })))).toBe(expected)
    })

    it("reads a response status and a provider error type", () => {
        expect(providerFailureClassOf({ response: { status: "429" } })).toBe("rate_limited")
        expect(providerFailureClassOf({ error: { type: "overloaded_error" } })).toBe("overloaded")
    })

    it("prefers a status over the message when both are present", () => {
        expect(providerFailureClassOf(Object.assign(new Error("request timed out"), { status: 401 }))).toBe("auth")
    })

    it("reads transport codes as timeouts or network failures", () => {
        expect(providerFailureClassOf(wrapped(Object.assign(new Error("x"), { code: "UND_ERR_HEADERS_TIMEOUT" })))).toBe(
            "timeout",
        )
        expect(providerFailureClassOf(wrapped(Object.assign(new Error("x"), { code: "ECONNRESET" })))).toBe("network")
        expect(providerFailureClassOf(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe("timeout")
    })

    it("falls back to the wording when no status or code survived", () => {
        expect(providerFailureClassOf(new Error("Rate limit reached for requests"))).toBe("rate_limited")
        expect(providerFailureClassOf(wrapped(new TypeError("fetch failed")))).toBe("network")
    })

    it("reports anything unrecognised as other, including non-errors and cyclic causes", () => {
        const cyclic: { cause?: unknown; message: string } = { message: "loop" }
        cyclic.cause = cyclic

        expect(providerFailureClassOf(new Error("model refused"))).toBe("other")
        expect(providerFailureClassOf(undefined)).toBe("other")
        expect(providerFailureClassOf("boom")).toBe("other")
        expect(providerFailureClassOf(cyclic)).toBe("other")
    })
})

describe("providerFailureAttributes", () => {
    it("names the class, exception type, provider code and status without the message", () => {
        const upstream = Object.assign(new Error("secret prompt text in the message"), {
            status: 429,
            error: { type: "rate_limit_error" },
        })

        const attributes = providerFailureAttributes(wrapped(upstream))

        expect(attributes).toEqual({
            "error.class": "rate_limited",
            "error.type": "Error",
            "error.code": "rate_limit_error",
            "http.status": 429,
        })
        expect(JSON.stringify(attributes)).not.toContain("secret")
    })

    it("omits what the failure did not carry", () => {
        expect(providerFailureAttributes(new TypeError("fetch failed"))).toEqual({
            "error.class": "network",
            "error.type": "TypeError",
        })
    })
})

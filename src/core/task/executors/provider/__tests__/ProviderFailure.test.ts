import { describe, expect, it } from "vitest"
import { ProviderFailure, recoveryOf } from "../ProviderFailure"

/** An SDK-style HTTP error: the status and body travel as properties, not in the message. */
function httpError(status: number, body: Record<string, unknown>, message = `${status} provider error`): Error {
    return Object.assign(new Error(message), { status, error: body })
}

describe("recoveryOf", () => {
    it("asks for a Profile change when the provider rejected the credentials", () => {
        // OpenAI: 401 with code invalid_api_key, as task 1792149608241 received it.
        const openAi = httpError(
            401,
            { code: "invalid_api_key", type: "invalid_request_error" },
            "401 Incorrect API key provided",
        )
        // Anthropic streams the rejection as a typed error body without an HTTP status.
        const anthropic = Object.assign(new Error("authentication failed"), {
            error: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
        })

        expect(recoveryOf(openAi)).toBe("profile_change")
        expect(recoveryOf(anthropic)).toBe("profile_change")
        // The executor sees the failure wrapped with its chat presentation.
        expect(recoveryOf(new ProviderFailure(openAi, '{"status":401}'))).toBe("profile_change")
    })

    it("keeps Retry for failures a resend can still fix or that say nothing about the key", () => {
        expect(recoveryOf(httpError(429, { code: "rate_limit_exceeded" }))).toBeUndefined()
        expect(recoveryOf(httpError(500, { type: "server_error" }))).toBeUndefined()
        // The Auth error type also covers 404 and 422; neither names the credentials.
        expect(recoveryOf(httpError(404, { code: "model_not_found" }))).toBeUndefined()
        expect(recoveryOf(httpError(422, { type: "invalid_request_error" }))).toBeUndefined()
        expect(recoveryOf(Object.assign(new Error("aborted"), { name: "AbortError", status: 401 }))).toBeUndefined()
    })
})

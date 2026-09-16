import { describe, expect, it } from "vitest"
import { ClineError } from "@/services/error/ClineError"
import { RuntimeContentPolicy } from "../content-policy"
import { normalizeRuntimeError } from "../error-normalizer"
import { exceptionAttributes } from "../exception-attributes"

describe("API error diagnostic fields", () => {
	it("extracts canonical ClineError status/code without exporting its payload", () => {
		const raw = Object.assign(new Error("private prompt and server body"), {
			status: 429,
			code: "rate_limit",
			request_id: "private-request",
			details: { apiKey: "secret" },
		})
		const normalized = normalizeRuntimeError(new ClineError(raw))
		expect(normalized).toMatchObject({ status: 429, code: "rate_limit", message: "*****" })
		expect(JSON.stringify(normalized)).not.toMatch(/private|secret/)
		const fields = RuntimeContentPolicy.forEvents().apply(exceptionAttributes(normalized)).attributes
		expect(fields["http.response.status_code"]).toBe(429)
		expect(fields["dline.exception.code"]).toBe("rate_limit")
	})

	it("groups by safe structure, not message text; status is significant", () => {
		const first = normalizeRuntimeError({ name: "ApiError", status: 401, code: "AUTH", message: "user alice" })
		const second = normalizeRuntimeError({ name: "ApiError", status: 401, code: "AUTH", message: "user bob" })
		expect(first.fingerprint).toBe(second.fingerprint)
		expect(first.fingerprint).not.toBe(normalizeRuntimeError({ name: "ApiError", status: 500, code: "AUTH" }).fingerprint)
	})

	it("rejects malformed status and credential-shaped identifiers", () => {
		const fields = normalizeRuntimeError({
			name: "Bearer secret",
			code: "sk-sensitive-key",
			status: Number.POSITIVE_INFINITY,
		})
		expect(fields).toMatchObject({ name: "Error", status: undefined, code: undefined })
		expect(normalizeRuntimeError({ response: { status: 503, data: "private" } }).status).toBe(503)
	})
})

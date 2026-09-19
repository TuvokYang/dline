import { describe, expect, it } from "vitest"
import { formatDiagnosticArgument, redactDiagnosticString, toSafeDiagnosticValue } from "../safe-diagnostic-value"

describe("redactDiagnosticString", () => {
	it("replaces bearer and basic credentials while keeping the scheme", () => {
		expect(redactDiagnosticString("Authorization: Bearer sk-live-123")).toBe("Authorization: Bearer [REDACTED]")
		expect(redactDiagnosticString("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: Basic [REDACTED]")
	})

	it("redacts labeled credentials and common token prefixes", () => {
		expect(redactDiagnosticString('apiKey="sk-live-123456" token=ghp_1234567890123456')).toBe(
			'apiKey="[REDACTED]" token=[REDACTED]',
		)
		expect(redactDiagnosticString("client_secret: top-secret-value")).toBe("client_secret: [REDACTED]")
	})

	it("leaves ordinary diagnostics untouched", () => {
		expect(redactDiagnosticString("request failed after 3 retries")).toBe("request failed after 3 retries")
	})
})

describe("toSafeDiagnosticValue secret handling", () => {
	it("redacts credential-bearing keys regardless of casing or separators", () => {
		const value = toSafeDiagnosticValue({
			apiKey: "sk-live-123",
			"X-Api-Key": "sk-live-456",
			access_token: "token-789",
			Accept: "application/json",
		})

		expect(value).toEqual({
			apiKey: "[REDACTED]",
			"X-Api-Key": "[REDACTED]",
			access_token: "[REDACTED]",
			Accept: "application/json",
		})
	})
})

describe("toSafeDiagnosticValue content handling", () => {
	it("summarizes user and tool content instead of reproducing it", () => {
		const value = toSafeDiagnosticValue({
			serverName: "github",
			command: "npx -y @modelcontextprotocol/server-github",
			args: ["--token", "ghp_secret"],
			stdout: "line one\nline two",
		}) as Record<string, unknown>

		expect(value.serverName).toBe("github")
		expect(value.command).toBe("[content chars=42]")
		expect(value.args).toBe("[content items=2]")
		expect(value.stdout).toBe("[content chars=17 lines=2]")
	})

	it("keeps error identity fields inside a summarized wrapper", () => {
		const value = toSafeDiagnosticValue({
			response: { status: 429, retryAfter: 30 },
		}) as Record<string, unknown>

		expect(value.response).toEqual({ status: 429, summary: "[content keys=2]" })
	})

	it("keeps the message readable on error-shaped objects", () => {
		const value = toSafeDiagnosticValue({
			name: "AxiosError",
			message: "Request failed with status code 404",
			code: "ERR_BAD_REQUEST",
		})

		expect(value).toEqual({
			name: "AxiosError",
			message: "Request failed with status code 404",
			code: "ERR_BAD_REQUEST",
		})
	})

	it("still summarizes message on payload-shaped objects", () => {
		const value = toSafeDiagnosticValue({
			channel: "mcp",
			message: "user typed this",
		}) as Record<string, unknown>

		expect(value.channel).toBe("mcp")
		expect(value.message).toBe("[content chars=15]")
	})
})

describe("toSafeDiagnosticValue structural limits", () => {
	it("preserves Error identity, message, and stack", () => {
		const error = new Error("boom")
		error.stack = "Error: boom\n    at somewhere"

		const value = toSafeDiagnosticValue(error) as Record<string, unknown>

		expect(value.name).toBe("Error")
		expect(value.message).toBe("boom")
		expect(value.stack).toBe("Error: boom\n    at somewhere")
	})

	it("marks circular references instead of recursing forever", () => {
		const node: Record<string, unknown> = { id: "root" }
		node.self = node

		const value = toSafeDiagnosticValue(node) as Record<string, unknown>

		expect(value.id).toBe("root")
		expect(value.self).toBe("[Circular]")
	})

	it("stops descending past the depth limit", () => {
		const deep = { a: { b: { c: { d: { e: { f: { g: "too deep" } } } } } } }

		const value = toSafeDiagnosticValue(deep) as Record<string, Record<string, unknown>>

		expect(JSON.stringify(value)).toContain("[depth limit]")
		expect(JSON.stringify(value)).not.toContain("too deep")
	})

	it("truncates oversized strings and reports the original size", () => {
		const value = toSafeDiagnosticValue("x".repeat(600)) as string

		expect(value.endsWith("[truncated chars=600]")).toBe(true)
		expect(value.length).toBeLessThan(600)
	})
})

describe("formatDiagnosticArgument", () => {
	it("serializes safe values as JSON", () => {
		expect(formatDiagnosticArgument({ serverName: "github", apiKey: "sk-live" })).toBe(
			'{"serverName":"github","apiKey":"[REDACTED]"}',
		)
	})

	it("falls back to String() when a value cannot be serialized", () => {
		const unserializable = { toJSON: () => BigInt(1) }

		expect(formatDiagnosticArgument(unserializable)).toBe(String(unserializable))
	})
})

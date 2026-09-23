import { describe, expect, it } from "vitest"
import { CLAUDE_CODE_PRODUCTION_RUNTIME_CONFIG, resolveClaudeCodeRuntimeConfig } from "../runtime-config"

/**
 * The override exists so an E2E run can point the sign-in flow at a mock.
 * These tests pin the two properties that keep that safe: overrides apply only
 * inside an E2E run, and only to loopback destinations.
 */

function env(values: Record<string, string>): NodeJS.ProcessEnv {
	return values as NodeJS.ProcessEnv
}

describe("resolveClaudeCodeRuntimeConfig", () => {
	it("uses the production endpoints outside an E2E run", () => {
		const config = resolveClaudeCodeRuntimeConfig(
			env({
				DLINE_E2E_CLAUDE_CODE_OAUTH_BASE_URL: "http://127.0.0.1:43100/oauth",
				DLINE_E2E_CLAUDE_CODE_USAGE_URL: "http://127.0.0.1:43100/usage",
			}),
		)

		expect(config).toEqual(CLAUDE_CODE_PRODUCTION_RUNTIME_CONFIG)
	})

	it("redirects every endpoint at the loopback mock during an E2E run", () => {
		const config = resolveClaudeCodeRuntimeConfig(
			env({
				E2E_TEST: "true",
				DLINE_E2E_CLAUDE_CODE_OAUTH_BASE_URL: "http://127.0.0.1:43100/oauth/",
				DLINE_E2E_CLAUDE_CODE_USAGE_URL: "http://localhost:43200/usage",
				DLINE_E2E_CLAUDE_CODE_CALLBACK_PORTS: "43101, 0",
				DLINE_E2E_CLAUDE_CODE_OAUTH_TIMEOUT_MS: "1250",
			}),
		)

		expect(config).toEqual({
			authorizationEndpoint: "http://127.0.0.1:43100/oauth/authorize",
			tokenEndpoint: "http://127.0.0.1:43100/oauth/token",
			manualRedirectUri: "http://127.0.0.1:43100/oauth/code/callback",
			usageUrl: "http://localhost:43200/usage",
			callbackPorts: [43101, 0],
			timeoutMs: 1250,
		})
	})

	it("keeps production endpoints an E2E run did not override", () => {
		const config = resolveClaudeCodeRuntimeConfig(env({ E2E_TEST: "true" }))

		expect(config).toEqual(CLAUDE_CODE_PRODUCTION_RUNTIME_CONFIG)
	})

	// A non-loopback override would send a real authorization code, or a real
	// credential, to whatever host the variable happened to name.
	it.each([
		["DLINE_E2E_CLAUDE_CODE_OAUTH_BASE_URL", "https://auth.example.com"],
		["DLINE_E2E_CLAUDE_CODE_OAUTH_BASE_URL", "http://192.0.2.10/oauth"],
		["DLINE_E2E_CLAUDE_CODE_USAGE_URL", "file:///tmp/usage"],
	])("rejects non-loopback %s overrides", (name, value) => {
		expect(() => resolveClaudeCodeRuntimeConfig(env({ E2E_TEST: "true", [name]: value }))).toThrow(name)
	})

	it.each([
		["DLINE_E2E_CLAUDE_CODE_CALLBACK_PORTS", "1455,invalid"],
		["DLINE_E2E_CLAUDE_CODE_CALLBACK_PORTS", "70000"],
		["DLINE_E2E_CLAUDE_CODE_OAUTH_TIMEOUT_MS", "0"],
		["DLINE_E2E_CLAUDE_CODE_OAUTH_TIMEOUT_MS", "1.5"],
	])("rejects invalid %s values", (name, value) => {
		expect(() =>
			resolveClaudeCodeRuntimeConfig(
				env({
					E2E_TEST: "true",
					DLINE_E2E_CLAUDE_CODE_OAUTH_BASE_URL: "http://127.0.0.1:43100",
					[name]: value,
				}),
			),
		).toThrow(name)
	})
})

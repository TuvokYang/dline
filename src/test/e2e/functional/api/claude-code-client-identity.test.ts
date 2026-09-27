import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"
import { CLAUDE_CODE_SDK_VERSION } from "@/integrations/anthropic-claude-code/client-headers"

/**
 * Verifies the identity the subscription provider actually puts on the wire.
 *
 * Unit tests cover the header builder in isolation. Only a real run shows that
 * every declared header survives the SDK, the shared transport, and the
 * per-request override path, and that the bearer credential is read from the
 * per-Profile OAuth document rather than an API key.
 */

interface SystemBlock {
	type?: string
	text?: string
	cache_control?: unknown
}

const BILLING_PREFIX = "x-anthropic-billing-header:"
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

async function selectClaudeCodeForBothModes(dlineDir: string): Promise<void> {
	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
	settings.actModeProfile = E2E_PROFILE_NAMES.mockClaudeCode
	settings.planModeProfile = E2E_PROFILE_NAMES.mockClaudeCode
	settings.clineWebToolsEnabled = false
	settings.useAutoCondense = false
	await writeFile(settingsPath(dlineDir), `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

async function selectProfile(sidebar: Frame, profileName: string): Promise<void> {
	const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
	if ((await modelSwitcher.innerText()).trim() === profileName) return
	await modelSwitcher.click()
	await expect(sidebar.getByText("Available Models", { exact: true })).toBeVisible()
	const profileOption = sidebar.getByRole("option").filter({ has: sidebar.getByText(profileName, { exact: true }) })
	await expect(profileOption).toHaveCount(1)
	await profileOption.click()
	await expect(modelSwitcher).toHaveText(profileName)
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled()
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
}

/** Node lower-cases incoming header names. */
function headerOf(requestHeaders: Readonly<Record<string, string | string[]>> | undefined, name: string): string {
	const value = requestHeaders?.[name.toLowerCase()]
	return Array.isArray(value) ? (value[0] ?? "") : (value ?? "")
}

e2e(
	"Claude Code client identity - the subscription request declares the full client fingerprint",
	async ({ dlineDir, helper, server, sidebar, userDataDir }, testInfo) => {
		e2e.setTimeout(180_000)
		await selectClaudeCodeForBothModes(dlineDir)
		server.resetOpenAiMock()
		// The identity claim is made on every request, so the assertions read the
		// first one. Later turns are scripted only so a queue exhaustion cannot
		// masquerade as an identity failure.
		server.enqueueResponses(
			"claude-code-messages",
			{
				type: "tool",
				id: "call_claude_code_identity",
				name: "attempt_completion",
				arguments: { result: "E2E_CLAUDE_CODE_IDENTITY_OK" },
			},
			{
				type: "tool",
				id: "call_claude_code_identity_followup",
				name: "attempt_completion",
				arguments: { result: "E2E_CLAUDE_CODE_IDENTITY_OK" },
			},
		)

		await helper.signin(sidebar)
		await selectProfile(sidebar, E2E_PROFILE_NAMES.mockClaudeCode)
		await sendTask(sidebar, "E2E_CLAUDE_CODE_IDENTITY_TASK")
		await expect(sidebar.getByText("E2E_CLAUDE_CODE_IDENTITY_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.getRequestCount("claude-code-messages"), { timeout: 30_000 }).toBeGreaterThanOrEqual(1)

		const consumption = server.getMockConsumptions("claude-code-messages")[0]
		expect(consumption?.contractError).toBeUndefined()
		const headers = consumption?.requestHeaders
		const system = (consumption?.requestBody as { system?: SystemBlock[] } | undefined)?.system ?? []

		await testInfo.attach("claude-code-client-identity", {
			body: Buffer.from(JSON.stringify({ headers, system }, null, 2)),
			contentType: "application/json",
		})

		// A subscription token is a bearer credential read from the per-Profile
		// OAuth document; sending it as x-api-key is rejected upstream.
		expect(headerOf(headers, "authorization")).toBe("Bearer dline-e2e-claude-code-token")
		expect(headerOf(headers, "x-api-key")).toBe("")

		// Upstream checks the User-Agent before anything else, so it must claim
		// the CLI rather than Dline.
		const userAgent = headerOf(headers, "user-agent")
		expect(userAgent).toMatch(/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/)

		// The Stainless headers are read together with the agent: a plausible
		// agent next to missing SDK headers is a weaker claim than sending none.
		expect(headerOf(headers, "x-stainless-lang")).toBe("js")
		expect(headerOf(headers, "x-stainless-package-version")).toBe(CLAUDE_CODE_SDK_VERSION)
		expect(headerOf(headers, "x-stainless-runtime")).toBe("node")
		expect(headerOf(headers, "x-app")).toBe("cli")
		// Retry count describes one in-flight attempt, so the SDK emits the real
		// value rather than Dline declaring a fixed one. Hard-coding it would
		// contradict the observable request once a retry actually happens.
		expect(headerOf(headers, "x-stainless-retry-count")).toBe("0")

		// Upstream classifies the caller by the whole beta set, so the request
		// declares the fixed client set rather than only what it uses. The
		// long-context beta is metered extra usage a subscription cannot buy,
		// and redact-thinking would let upstream strip thinking content.
		const betas = headerOf(headers, "anthropic-beta")
		expect(betas).toBe(
			[
				"claude-code-20250219",
				"oauth-2025-04-20",
				"interleaved-thinking-2025-05-14",
				"prompt-caching-scope-2026-01-05",
				"effort-2025-11-24",
				"context-management-2025-06-27",
				"thinking-binding-controls-2026-08-01",
				"mid-conversation-output-config-2026-07-01",
				"extended-cache-ttl-2025-04-11",
			].join(","),
		)
		expect(betas).not.toContain("context-1m")
		expect(betas).not.toContain("redact-thinking")

		// The attribution block leads the system array and must attribute the very
		// version the agent declares; upstream treats a mismatch as third-party.
		expect(system[0]?.text ?? "").toContain(BILLING_PREFIX)
		expect(system[0]).not.toHaveProperty("cache_control")
		const declaredVersion = /^claude-cli\/(\d+\.\d+\.\d+) /.exec(userAgent)?.[1]
		expect(system[0]?.text).toContain(`cc_version=${declaredVersion}.`)
		// The retired cch segment must not come back.
		expect(system[0]?.text ?? "").not.toContain("cch=")

		// The catalog declares prompt caching, so the breakpoint must be present
		// and must sit on the system prompt rather than the attribution block.
		expect(system.at(-1)?.cache_control).toEqual({ type: "ephemeral" })

		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

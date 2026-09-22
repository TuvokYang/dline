import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Locator, type Page } from "@playwright/test"

/**
 * Verifies how the Claude Code billing attribution block is assembled into the
 * outbound `system` array.
 *
 * The unit tests already cover the fingerprint algorithm. What only a real run
 * can show is that the block reaches the wire in the right position, that the
 * cache breakpoint stays on the system prompt, and that leaving the toggle off
 * keeps the request byte-identical to the pre-change shape.
 */

interface StoredProfile {
	name: string
	webToolsMode?: string
	anthropic?: {
		claudeCodeIdentity?: {
			enabled?: boolean
			clientVersionOverride?: string
			entrypointOverride?: string
		}
	}
}

interface SystemBlock {
	type?: string
	text?: string
	cache_control?: unknown
}

const BILLING_PREFIX = "x-anthropic-billing-header:"
/** Pinned so the expected text stays independent of the npm registry. */
const PINNED_CLIENT_VERSION = "2.1.280"

const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

/** Pins the declared version so the request never depends on the npm registry. */
async function configureAnthropicProfile(dlineDir: string): Promise<void> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockAnthropic)
	if (!profile) throw new Error("Configurable Anthropic E2E profile is missing")
	profile.anthropic = {
		...profile.anthropic,
		claudeCodeIdentity: { enabled: false, clientVersionOverride: PINNED_CLIENT_VERSION },
	}
	profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
	settings.actModeProfile = E2E_PROFILE_NAMES.mockAnthropic
	settings.planModeProfile = E2E_PROFILE_NAMES.mockAnthropic
	settings.clineWebToolsEnabled = false
	settings.useAutoCondense = false
	await writeFile(settingsPath(dlineDir), `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

function escapeForRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Matches on the expand/collapse toggle, whose accessible name always carries
 * the profile name, so a collapsed card is still addressable.
 */
function getProfileCard(sidebar: Frame, profileName: string): Locator {
	return sidebar.getByTestId("api-profile-card").filter({
		has: sidebar.getByRole("button", { name: new RegExp(`^(Expand|Collapse) ${escapeForRegExp(profileName)}$`) }),
	})
}

/** Expanding is idempotent: the toggle is only clicked while it still offers to expand. */
async function expandProfileCard(card: Locator): Promise<void> {
	const expandToggle = card.getByRole("button", { name: /^Expand / })
	if (await expandToggle.isVisible()) {
		await expandToggle.click()
	}
	await expect(card.getByRole("button", { name: /^Collapse / })).toBeVisible()
}

/** Turns the toggle on through the settings UI, exercising the real round trip. */
async function enableBillingHeaderFromSettings(page: Page, sidebar: Frame): Promise<void> {
	await page.getByRole("button", { name: "Settings", exact: true }).click()
	const card = getProfileCard(sidebar, E2E_PROFILE_NAMES.mockAnthropic)
	await expect(card).toHaveCount(1, { timeout: 30_000 })
	// The provider options only render once the card is expanded.
	await expandProfileCard(card)

	const checkbox = card.getByRole("checkbox", { name: "Send Claude Code billing header" })
	await checkbox.scrollIntoViewIfNeeded()
	await expect(checkbox).toBeVisible({ timeout: 30_000 })
	await expect(checkbox).toHaveAttribute("aria-checked", "false")
	await checkbox.click()
	await expect(checkbox).toHaveAttribute("aria-checked", "true")

	await sidebar.getByRole("button", { name: "Done", exact: true }).click()
	await expect(sidebar.getByTestId("chat-input")).toBeEnabled({ timeout: 30_000 })
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

function systemBlocksOf(requestBody: unknown): SystemBlock[] {
	const system = (requestBody as { system?: unknown } | undefined)?.system
	if (!Array.isArray(system)) throw new Error("Anthropic request body carries no system array")
	return system as SystemBlock[]
}

/** Node lower-cases incoming header names, so read the declared agent that way. */
function userAgentOf(requestHeaders: Readonly<Record<string, string | string[]>> | undefined): string {
	const agent = requestHeaders?.["user-agent"]
	return Array.isArray(agent) ? (agent[0] ?? "") : (agent ?? "")
}

e2e(
	"Anthropic billing attribution - the block only appears when enabled and never takes the cache breakpoint",
	async ({ dlineDir, helper, page, server, sidebar, userDataDir }, testInfo) => {
		e2e.setTimeout(180_000)
		await configureAnthropicProfile(dlineDir)
		server.resetOpenAiMock()
		server.enqueueResponses(
			"anthropic-messages",
			{
				type: "tool",
				id: "call_billing_off",
				name: "attempt_completion",
				arguments: { result: "E2E_BILLING_OFF_OK" },
			},
			{
				type: "tool",
				id: "call_billing_on",
				name: "attempt_completion",
				arguments: { result: "E2E_BILLING_ON_OK" },
			},
		)

		await helper.signin(sidebar)
		await selectProfile(sidebar, E2E_PROFILE_NAMES.mockAnthropic)
		await sendTask(sidebar, "E2E_BILLING_ATTRIBUTION_TASK_OFF")
		await expect(sidebar.getByText("E2E_BILLING_OFF_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		await expect.poll(() => server.getRequestCount("anthropic-messages"), { timeout: 30_000 }).toBe(1)

		const disabledConsumption = server.getMockConsumptions("anthropic-messages")[0]
		const disabledSystem = systemBlocksOf(disabledConsumption?.requestBody)
		// With the toggle off the array must stay exactly the one system-prompt
		// block the provider sent before this feature existed.
		expect(disabledSystem).toHaveLength(1)
		expect(disabledSystem[0]?.text ?? "").not.toContain(BILLING_PREFIX)
		expect(disabledSystem[0]?.cache_control).toEqual({ type: "ephemeral" })
		// Dline keeps announcing itself honestly while the toggle is off.
		expect(userAgentOf(disabledConsumption?.requestHeaders)).toMatch(/^Dline\//)

		await enableBillingHeaderFromSettings(page, sidebar)
		await sendTask(sidebar, "E2E_BILLING_ATTRIBUTION_TASK_ON")
		await expect(sidebar.getByText("E2E_BILLING_ON_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		await expect.poll(() => server.getRequestCount("anthropic-messages"), { timeout: 30_000 }).toBe(2)

		const consumptions = server.getMockConsumptions("anthropic-messages")
		expect(consumptions.every(({ contractError }) => contractError === undefined)).toBe(true)
		const enabledSystem = systemBlocksOf(consumptions[1]?.requestBody)

		await testInfo.attach("anthropic-billing-attribution-system-blocks", {
			body: Buffer.from(JSON.stringify({ disabled: disabledSystem, enabled: enabledSystem }, null, 2)),
			contentType: "application/json",
		})

		// The attribution block leads the array, matching real client traffic.
		expect(enabledSystem).toHaveLength(2)
		expect(enabledSystem[0]?.type).toBe("text")
		expect(enabledSystem[0]?.text).toMatch(
			/^x-anthropic-billing-header: cc_version=2\.1\.280\.[0-9a-f]{3}; cc_entrypoint=cli;$/,
		)
		// The retired cch segment must not come back.
		expect(enabledSystem[0]?.text ?? "").not.toContain("cch=")
		// The cache breakpoint stays on the system prompt, so enabling the
		// toggle does not move the cached prefix.
		expect(enabledSystem[0]).not.toHaveProperty("cache_control")
		expect(enabledSystem[1]?.cache_control).toEqual({ type: "ephemeral" })
		expect(enabledSystem[1]?.text).toBe(disabledSystem[0]?.text)

		// The declared agent must carry the very version the block attributes.
		// Upstream treats a mismatch between the two as a third-party client.
		const enabledUserAgent = userAgentOf(consumptions[1]?.requestHeaders)
		expect(enabledUserAgent).toBe(`claude-cli/${PINNED_CLIENT_VERSION} (external, cli)`)
		expect(enabledSystem[0]?.text).toContain(`cc_version=${PINNED_CLIENT_VERSION}.`)

		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

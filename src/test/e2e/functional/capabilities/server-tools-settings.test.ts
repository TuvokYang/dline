import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Locator, type Page } from "@playwright/test"
import { ServerTool } from "@shared/proto/dline/models/metadata"
import type { ElectronApplication } from "playwright"

interface StoredCapabilities {
	supportsImages?: boolean
	supportsBrowserAction?: boolean
	tools?: Array<string | number>
}

interface StoredProviderConfig {
	customModelEnabled?: boolean
	capabilities?: StoredCapabilities
	disabledServerTools?: Array<string | number>
}

interface StoredProfile {
	name: string
	webToolsMode?: string
	openai?: StoredProviderConfig
	anthropic?: StoredProviderConfig
}

const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")
const providerCatalogPath = (dlineDir: string, providerId: string) => path.join(dlineDir, "providers", `${providerId}.json`)

async function readProfiles(dlineDir: string): Promise<StoredProfile[]> {
	return JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
}

async function readSettings(dlineDir: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
}

function hasWebSearchCapability(capabilities: StoredCapabilities | undefined): boolean {
	return capabilities?.tools?.some((tool) => tool === "WEB_SEARCH" || tool === ServerTool.WEB_SEARCH) === true
}

/**
 * The switch subtracts from the registry declaration, so an absent list means
 * the profile follows whatever the model declares.
 */
function hostedWebSearchEnabled(config: StoredProviderConfig | undefined): boolean {
	return config?.disabledServerTools?.some((tool) => tool === "WEB_SEARCH" || tool === ServerTool.WEB_SEARCH) !== true
}

async function expectBuiltInWebSearchCatalogs(dlineDir: string): Promise<void> {
	for (const providerId of ["openai", "openai-codex", "anthropic"]) {
		const catalog = await E2ETestHelper.waitForValue(async () => {
			try {
				return JSON.parse(await readFile(providerCatalogPath(dlineDir, providerId), "utf8")) as {
					models?: Record<string, { capabilities?: StoredCapabilities }>
				}
			} catch {
				return undefined
			}
		}, 15_000)
		const models = Object.values(catalog.models ?? {})
		expect(models.length).toBeGreaterThan(0)
		expect(models.every((model) => hasWebSearchCapability(model.capabilities))).toBe(true)
	}
}

async function waitForProfile(
	dlineDir: string,
	name: string,
	predicate: (profile: StoredProfile) => boolean,
): Promise<StoredProfile> {
	return E2ETestHelper.waitForValue(async () => {
		const profile = (await readProfiles(dlineDir)).find((candidate) => candidate.name === name)
		return profile && predicate(profile) ? profile : undefined
	}, 15_000)
}

async function openSidebar(app: ElectronApplication, helper: E2ETestHelper): Promise<{ page: Page; sidebar: Frame }> {
	const page = await app.firstWindow()
	await E2ETestHelper.openClineSidebar(page)
	const sidebar = await helper.getSidebar(page)
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	await helper.signin(sidebar)
	return { page, sidebar }
}

async function openSettings(page: Page, sidebar: Frame): Promise<void> {
	await page.getByRole("button", { name: "Settings", exact: true }).click()
	await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible()
}

/**
 * Matches on the expand/collapse toggle, whose accessible name always carries
 * the profile name. The name input only exists while the card is expanded, so
 * matching on it cannot find a collapsed card.
 */
function getProfileCard(sidebar: Frame, profileName: string): Locator {
	return sidebar.getByTestId("api-profile-card").filter({
		has: sidebar.getByRole("button", { name: new RegExp(`^(Expand|Collapse) ${escapeForRegExp(profileName)}$`) }),
	})
}

function escapeForRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function openProfileEditor(sidebar: Frame, profileName: string): Promise<Locator> {
	const card = getProfileCard(sidebar, profileName)
	await expect(card).toHaveCount(1)
	const expandToggle = card.getByRole("button", { name: /^Expand / })
	if (await expandToggle.isVisible()) {
		await expandToggle.click()
	}
	const providerSelector = card.getByRole("combobox", { name: "Provider", exact: true })
	await expect(providerSelector).toBeVisible()
	return card
}

function capabilityCheckbox(card: Locator, label: string): Locator {
	return card.locator("vscode-checkbox").filter({ hasText: label })
}

async function setCapability(card: Locator, label: string, value: boolean): Promise<void> {
	const checkbox = capabilityCheckbox(card, label)
	await expect(checkbox).toHaveCount(1)
	await expect(checkbox).toBeVisible()
	const current = await checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
	if (current !== value) await checkbox.click()
	await expect.poll(() => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))).toBe(value)
}

async function openModelConfiguration(card: Locator): Promise<void> {
	const toggle = card.getByText("Model Configuration", { exact: true })
	await expect(toggle).toBeVisible()
	// The label carries a suffix when the model declares no hosted Web Search,
	// so the disclosure is detected on the shared prefix.
	const webSearch = capabilityCheckbox(card, "Use hosted Web Search")
	if (!(await webSearch.isVisible())) await toggle.click()
	await expect(webSearch).toBeVisible()
}

async function expectCapabilities(card: Locator, expected: Record<string, boolean>): Promise<void> {
	for (const [label, value] of Object.entries(expected)) {
		const checkbox = capabilityCheckbox(card, label)
		await expect(checkbox).toBeVisible()
		await expect.poll(() => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))).toBe(value)
	}
}

e2e(
	"ServerTool settings - saves Web Tools routing and custom model capabilities after reopening VS Code",
	async ({ dlineDir, dlineDocsDir, dlineHomeDir, helper, openVSCode, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		expect(path.resolve(dlineHomeDir)).toBe(path.resolve(dlineDir))
		expect(path.resolve(dlineDocsDir)).not.toBe(path.resolve(dlineDir))

		let firstApp: ElectronApplication | undefined
		let reopenedApp: ElectronApplication | undefined
		try {
			firstApp = await openVSCode(workspaceDir)
			const first = await openSidebar(firstApp, helper)
			await openSettings(first.page, first.sidebar)
			await expectBuiltInWebSearchCatalogs(dlineDir)

			await first.sidebar.getByTestId("tab-features").click()
			await expect(first.sidebar.getByRole("heading", { name: "Feature Settings" })).toBeVisible()
			const webToolsSwitch = first.sidebar.locator('[id="Web Tools"]')
			await expect(webToolsSwitch).toBeVisible()
			await expect(webToolsSwitch).toHaveAttribute("aria-checked", "true")
			await webToolsSwitch.click()
			await expect(webToolsSwitch).toHaveAttribute("aria-checked", "false")
			await expect.poll(async () => (await readSettings(dlineDir)).clineWebToolsEnabled).toBe(false)

			await first.sidebar.getByTestId("tab-api-config").click()
			await expect(first.sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible()
			const openAiCard = await openProfileEditor(first.sidebar, E2E_PROFILE_NAMES.persistence)
			const routingMode = openAiCard.getByRole("combobox", { name: "Web Tools mode" })
			await expect(routingMode).toHaveValue("0")

			for (const mode of [
				{ label: "Local only", value: "1", stored: "WEB_TOOLS_MODE_FORCE_LOCAL" },
				{ label: "Auto", value: "0", stored: "WEB_TOOLS_MODE_AUTO" },
				{ label: "Off", value: "2", stored: "WEB_TOOLS_MODE_FORCE_OFF" },
				{ label: "Hosted only", value: "3", stored: "WEB_TOOLS_MODE_FORCE_REMOTE" },
			]) {
				await routingMode.selectOption({ label: mode.label })
				await expect(routingMode).toHaveValue(mode.value)
				await waitForProfile(dlineDir, E2E_PROFILE_NAMES.persistence, (profile) => profile.webToolsMode === mode.stored)
			}

			await openModelConfiguration(openAiCard)
			// This profile runs a free-form model id, so no registry entry declares
			// hosted Web Search. The switch must stay unavailable instead of letting
			// the profile invent a capability the model does not have.
			const openAiHostedWebSearch = capabilityCheckbox(openAiCard, "Use hosted Web Search")
			await expect(openAiHostedWebSearch).toContainText("not offered by this model")
			await expect(openAiHostedWebSearch).toHaveAttribute("disabled", "")
			await setCapability(openAiCard, "Supports Browser Actions", true)
			await waitForProfile(
				dlineDir,
				E2E_PROFILE_NAMES.persistence,
				(profile) => profile.openai?.capabilities?.supportsBrowserAction === true,
			)
			await setCapability(openAiCard, "Supports Images", false)
			await waitForProfile(
				dlineDir,
				E2E_PROFILE_NAMES.persistence,
				(profile) => profile.openai?.capabilities?.supportsImages === false,
			)

			// Capability editing is available for every model, and the hosted switch
			// round-trips through disabledServerTools rather than the declaration.
			const anthropicCard = await openProfileEditor(first.sidebar, E2E_PROFILE_NAMES.mockAnthropic)
			await openModelConfiguration(anthropicCard)
			for (const label of ["Use hosted Web Search", "Supports Browser Actions", "Supports Images"]) {
				const checkbox = capabilityCheckbox(anthropicCard, label)
				await expect(checkbox).not.toHaveAttribute("disabled", "")
				const initiallyEnabled = await checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
				if (initiallyEnabled) {
					await setCapability(anthropicCard, label, false)
					await waitForProfile(dlineDir, E2E_PROFILE_NAMES.mockAnthropic, (profile) => {
						const capabilities = profile.anthropic?.capabilities
						if (label === "Use hosted Web Search") return hostedWebSearchEnabled(profile.anthropic) === false
						if (label === "Supports Browser Actions") return capabilities?.supportsBrowserAction === false
						return capabilities?.supportsImages === false
					})
				}
				await setCapability(anthropicCard, label, true)
				await waitForProfile(dlineDir, E2E_PROFILE_NAMES.mockAnthropic, (profile) => {
					const capabilities = profile.anthropic?.capabilities
					if (label === "Use hosted Web Search") {
						return hostedWebSearchEnabled(profile.anthropic) && capabilities?.tools === undefined
					}
					if (label === "Supports Browser Actions") return capabilities?.supportsBrowserAction === true
					return capabilities?.supportsImages === true
				})
			}

			await firstApp.close()
			firstApp = undefined
			helper.clearCachedFrame()

			reopenedApp = await openVSCode(workspaceDir)
			const reopened = await openSidebar(reopenedApp, helper)
			await openSettings(reopened.page, reopened.sidebar)
			await reopened.sidebar.getByTestId("tab-features").click()
			await expect(reopened.sidebar.locator('[id="Web Tools"]')).toHaveAttribute("aria-checked", "false")

			await reopened.sidebar.getByTestId("tab-api-config").click()
			const reopenedOpenAiCard = await openProfileEditor(reopened.sidebar, E2E_PROFILE_NAMES.persistence)
			await expect(reopenedOpenAiCard.getByRole("combobox", { name: "Web Tools mode" })).toHaveValue("3")
			await openModelConfiguration(reopenedOpenAiCard)
			await expectCapabilities(reopenedOpenAiCard, {
				"Supports Browser Actions": true,
				"Supports Images": false,
			})
			await expect(capabilityCheckbox(reopenedOpenAiCard, "Use hosted Web Search")).toHaveAttribute("disabled", "")

			const reopenedAnthropicCard = await openProfileEditor(reopened.sidebar, E2E_PROFILE_NAMES.mockAnthropic)
			// The custom model ID switch stays available; merging the two pickers
			// never removed the free-form id entry.
			await expect(reopenedAnthropicCard.locator("vscode-checkbox").filter({ hasText: "Use custom model ID" })).toHaveCount(
				1,
			)
			await openModelConfiguration(reopenedAnthropicCard)
			await expectCapabilities(reopenedAnthropicCard, {
				"Use hosted Web Search": true,
				"Supports Browser Actions": true,
				"Supports Images": true,
			})
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await reopenedApp?.close()
			await firstApp?.close()
		}
	},
)

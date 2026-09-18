import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { startSettingControlStabilityObserver, stopSettingControlStabilityObserver } from "@e2e/utils/ui-stability"
import { expect, type Frame, type Locator, type Page } from "@playwright/test"
import { ApiFormat } from "@shared/proto/dline/models/metadata"
import type { ElectronApplication } from "playwright"

interface StoredProfile {
	id: string
	name: string
	provider: string
	modelId: string
	baseUrl?: string
	webToolsMode?: string
	openai?: {
		apiFormat?: string
		customModelEnabled?: boolean
		serviceTier?: string
		azureApiVersion?: string
		azureIdentity?: boolean
		streamIncludeUsage?: boolean
		openAiHeaders?: Record<string, string>
		reasoning?: {
			enableThinking?: boolean
			effort?: string
			thinkingBudget?: number
		}
		capabilities?: {
			contextWindow?: number
			maxTokens?: number
			supportsPromptCache?: boolean
			supportsTools?: boolean
			contextWindowTiers?: Array<{ id: string; contextWindow: number; label?: string }>
		}
		pricing?: {
			inputPrice?: number
			outputPrice?: number
			cacheWritesPrice?: number
			cacheReadsPrice?: number
			tiers?: Array<{ contextWindow: number; inputPrice?: number; outputPrice?: number }>
		}
	}
	anthropic?: {
		enableLongContext?: boolean
		reasoning?: {
			enableThinking?: boolean
			effort?: string
			thinkingBudget?: number
		}
		capabilities?: {
			contextWindow?: number
			contextWindowTiers?: Array<{ id: string; contextWindow: number; label?: string; apiModelSuffix?: string }>
		}
		pricing?: {
			tiers?: Array<{ contextWindow: number; inputPrice?: number; outputPrice?: number }>
		}
	}
}

interface StoredApiKey {
	apiKey: string
	name: string
}

const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")
const apiKeysPath = (dlineDir: string) => path.join(dlineDir, "data", "secrets", "api_keys.json")

async function readProfiles(dlineDir: string): Promise<StoredProfile[]> {
	return JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
}

async function readSettings(dlineDir: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
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

async function waitForApiKey(dlineDir: string, profileId: string, apiKey: string): Promise<StoredApiKey> {
	return E2ETestHelper.waitForValue(async () => {
		const apiKeys = JSON.parse(await readFile(apiKeysPath(dlineDir), "utf8")) as Record<string, StoredApiKey>
		return apiKeys[profileId]?.apiKey === apiKey ? apiKeys[profileId] : undefined
	}, 15_000)
}

async function openApiSettings(page: Page, sidebar: Frame): Promise<void> {
	await page.getByRole("button", { name: "Settings", exact: true }).click()
	await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible()
}

/**
 * Matches on the expand/collapse toggle, whose accessible name always carries
 * the profile name. Plain `hasText` would also match a card whose expanded
 * body happens to contain the name, such as a provider dropdown option.
 */
function getProfileCard(sidebar: Frame, profileName: string): Locator {
	return sidebar.getByTestId("api-profile-card").filter({
		has: sidebar.getByRole("button", { name: new RegExp(`^(Expand|Collapse) ${escapeForRegExp(profileName)}$`) }),
	})
}

function escapeForRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Expanding is idempotent: the toggle is only clicked while it still offers to expand. */
async function expandProfileCard(card: Locator): Promise<void> {
	const expandToggle = card.getByRole("button", { name: /^Expand / })
	if (await expandToggle.isVisible()) {
		await expandToggle.click()
	}
	await expect(card.getByRole("button", { name: /^Collapse / })).toBeVisible()
}

async function openProfileEditor(sidebar: Frame, profileName: string): Promise<Locator> {
	const card = getProfileCard(sidebar, profileName)
	await expect(card).toHaveCount(1)
	await expandProfileCard(card)
	const providerSelector = card.getByRole("combobox", { name: "Provider" })
	await expect(providerSelector).toBeVisible()
	return card
}

async function openModelConfiguration(sidebar: Frame, profileName: string): Promise<Locator> {
	const card = getProfileCard(sidebar, profileName)
	await expect(card).toHaveCount(1)
	await expandProfileCard(card)

	// "Model Configuration" is a disclosure button; its fields only mount once opened.
	const modelConfiguration = card.getByRole("button", { name: "Model Configuration" })
	await expect(modelConfiguration).toBeVisible()

	const contextWindow = card.getByRole("textbox", { name: "Context Window Size" })
	if (!(await contextWindow.isVisible())) {
		await modelConfiguration.click()
	}
	await expect(contextWindow).toBeVisible()
	return card
}

async function setCapability(card: Locator, label: string, value: boolean): Promise<void> {
	const checkbox = card.locator("vscode-checkbox").filter({ hasText: label })
	await expect(checkbox).toHaveCount(1)
	await expect(checkbox).toBeVisible()
	const current = await checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
	if (current !== value) {
		await checkbox.click()
	}
	await expect.poll(() => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))).toBe(value)
}

async function setTextField(card: Locator, name: string, value: string): Promise<void> {
	const field = card.getByRole("textbox", { name })
	await field.fill(value)
	await field.press("Tab")
	await expect(field).toHaveValue(value)
}

async function setPlaceholderField(card: Locator, placeholder: string, value: string): Promise<void> {
	const field = card.locator(`vscode-text-field[placeholder=${JSON.stringify(placeholder)}] input`)
	await expect(field).toHaveCount(1)
	await field.fill(value)
	await field.press("Tab")
	await expect(field).toHaveValue(value)
}

async function selectLabeledOption(card: Locator, sidebar: Frame, label: string, option: string): Promise<void> {
	const container = card.getByText(label, { exact: true }).locator("..")
	const trigger = container.getByRole("combobox")
	await expect(trigger).toHaveCount(1)
	await trigger.click()
	await sidebar.getByRole("option", { name: option, exact: true }).click()
}

/** Capability rows are always visible; they are no longer behind a disclosure. */
async function expectAdvancedValue(card: Locator, label: string, value: string): Promise<void> {
	const row = card.getByText(label, { exact: true }).locator("..")
	await expect(row).toBeVisible()
	await expect(row).toContainText(value)
}

async function expectModelInfoValue(card: Locator, label: string, value: string): Promise<void> {
	const row = card.getByText(label, { exact: true }).locator("..")
	await expect(row).toBeVisible()
	await expect(row).toContainText(value)
}

e2e(
	"OpenAI provider - fetches remote models after entering Base URL and API key",
	async ({ dlineDir, helper, page, server, sidebar, userDataDir }) => {
		const profileName = E2E_PROFILE_NAMES.persistence
		const modelDiscoveryBaseUrl = `${server.baseUrl}/mock/openai-compatible/chat`
		const modelDiscoveryApiKey = "dline-e2e-entered-model-discovery-key"

		await helper.signin(sidebar)
		await openApiSettings(page, sidebar)
		const card = await openModelConfiguration(sidebar, profileName)
		const profile = (await readProfiles(dlineDir)).find((candidate) => candidate.name === profileName)
		if (!profile) throw new Error("OpenAI persistence profile is missing")

		await setPlaceholderField(card, "Enter base URL...", modelDiscoveryBaseUrl)
		await waitForProfile(dlineDir, profileName, (candidate) => candidate.baseUrl === modelDiscoveryBaseUrl)
		await setPlaceholderField(card, "Enter API Key...", modelDiscoveryApiKey)
		await waitForApiKey(dlineDir, profile.id, modelDiscoveryApiKey)

		// The picker lists against the credentials the profile carried when it
		// last rendered, so a listing issued while the key was still being
		// saved sees the previous endpoint. Reopening re-runs discovery, which
		// is also what a user does after finishing the form.
		server.resetOpenAiMock()
		await expect
			.poll(
				async () => {
					await openModelPicker(card)
					return sidebar.getByRole("option", { name: modelOptionName("dline-e2e-discovered-model") }).count()
				},
				{ timeout: 30_000 },
			)
			.toBeGreaterThan(0)
		expect(server.getModelListRequests().at(-1)).toMatchObject({
			path: "/mock/openai-compatible/chat/v1/models",
			authorization: `Bearer ${modelDiscoveryApiKey}`,
		})
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Model configuration - updates Model Info immediately and persists after reopening VS Code",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		const profileName = E2E_PROFILE_NAMES.persistence
		const modelDiscoveryBaseUrl = `${server.baseUrl}/mock/openai-compatible/chat`
		let firstApp: ElectronApplication | undefined
		let reopenedApp: ElectronApplication | undefined
		const profiles = await readProfiles(dlineDir)
		const persistenceProfile = profiles.find((profile) => profile.name === profileName)
		if (!persistenceProfile?.openai?.capabilities) throw new Error("OpenAI persistence profile is missing")
		delete persistenceProfile.openai.capabilities.supportsTools
		await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

		try {
			firstApp = await openVSCode(workspaceDir)
			const firstPage = await firstApp.firstWindow()
			await E2ETestHelper.openClineSidebar(firstPage)
			const firstSidebar = await helper.getSidebar(firstPage)
			await helper.signin(firstSidebar)
			await openApiSettings(firstPage, firstSidebar)

			const officialCard = await openModelConfiguration(firstSidebar, E2E_PROFILE_NAMES.mockOpenAiOfficialResponses)
			await expect(modelPickerInput(officialCard)).toHaveValue("gpt-5.4-mini")
			const officialApiFormat = officialCard.getByRole("combobox", { name: "API Format" })
			await expect(officialApiFormat).toHaveValue(String(ApiFormat.OPENAI_RESPONSES))
			expect(await officialApiFormat.evaluate((element) => (element as HTMLElement).style.backgroundColor)).toBe(
				"var(--vscode-dropdown-background)",
			)
			await officialApiFormat.selectOption(String(ApiFormat.OPENAI_CHAT))
			await waitForProfile(
				dlineDir,
				E2E_PROFILE_NAMES.mockOpenAiOfficialResponses,
				(profile) => profile.openai?.apiFormat === "OPENAI_CHAT",
			)
			await officialApiFormat.selectOption(String(ApiFormat.OPENAI_RESPONSES))
			await waitForProfile(
				dlineDir,
				E2E_PROFILE_NAMES.mockOpenAiOfficialResponses,
				(profile) => profile.openai?.apiFormat === "OPENAI_RESPONSES",
			)

			const card = await openModelConfiguration(firstSidebar, profileName)
			await setPlaceholderField(card, "Enter base URL...", modelDiscoveryBaseUrl)
			await waitForProfile(dlineDir, profileName, (profile) => profile.baseUrl === modelDiscoveryBaseUrl)
			await expect(card.locator("vscode-checkbox").filter({ hasText: "Use custom model ID" })).toHaveCount(1)
			await setPlaceholderField(card, "Enter Model ID...", "dline-e2e-discovered-model")
			await waitForProfile(
				dlineDir,
				profileName,
				(profile) => profile.modelId === "dline-e2e-discovered-model" && profile.openai?.customModelEnabled === true,
			)
			const apiFormatSelector = card.getByRole("combobox", { name: "API Format" })
			await expect(apiFormatSelector).toHaveValue(String(ApiFormat.OPENAI_CHAT))
			await apiFormatSelector.selectOption(String(ApiFormat.OPENAI_RESPONSES))
			await expect(apiFormatSelector).toHaveValue(String(ApiFormat.OPENAI_RESPONSES))
			await waitForProfile(dlineDir, profileName, (profile) => profile.openai?.apiFormat === "OPENAI_RESPONSES")

			await startSettingControlStabilityObserver(
				firstSidebar,
				{
					label: "Supports Prompt Cache",
				},
				"checked",
			)
			await setCapability(card, "Supports Prompt Cache", false)
			await expectAdvancedValue(card, "Prompt Caching", "No")
			const promptCacheSamples = await stopSettingControlStabilityObserver(firstSidebar)
			const firstUncheckedSample = promptCacheSamples.indexOf("false")
			expect(firstUncheckedSample).toBeGreaterThanOrEqual(0)
			expect(promptCacheSamples.slice(firstUncheckedSample)).not.toContain("true")
			await setCapability(card, "Supports Prompt Cache", true)
			await expectAdvancedValue(card, "Prompt Caching", "Yes")
			const nativeTools = card.locator("vscode-checkbox").filter({ hasText: "Supports Native Tool Calls" })
			await expect.poll(() => nativeTools.evaluate((element) => Boolean((element as HTMLInputElement).checked))).toBe(true)
			await setCapability(card, "Supports Native Tool Calls", false)
			await waitForProfile(dlineDir, profileName, (profile) => profile.openai?.capabilities?.supportsTools === false)
			await setCapability(card, "Supports Native Tool Calls", true)
			await waitForProfile(dlineDir, profileName, (profile) => profile.openai?.capabilities?.supportsTools === true)

			await setTextField(card, "Context Window Size", "234567")
			await waitForProfile(dlineDir, profileName, (profile) => profile.openai?.capabilities?.contextWindow === 234_567)
			await setTextField(card, "Max Output Tokens", "32768")
			await waitForProfile(dlineDir, profileName, (profile) => profile.openai?.capabilities?.maxTokens === 32_768)
			await setTextField(card, "Input Price ($/1M tokens)", "1.25")
			await waitForProfile(dlineDir, profileName, (profile) => profile.openai?.pricing?.inputPrice === 1.25)
			await setTextField(card, "Output Price ($/1M tokens)", "2.5")
			await waitForProfile(dlineDir, profileName, (profile) => profile.openai?.pricing?.outputPrice === 2.5)
			await setTextField(card, "Cache Writes ($/M)", "0.75")
			await waitForProfile(dlineDir, profileName, (profile) => profile.openai?.pricing?.cacheWritesPrice === 0.75)
			await setTextField(card, "Cache Reads ($/M)", "0.25")
			await waitForProfile(dlineDir, profileName, (profile) => profile.openai?.pricing?.cacheReadsPrice === 0.25)
			await expect(card.getByText("235K", { exact: true })).toBeVisible()
			await expectModelInfoValue(card, "Input:", "$1.25/M")
			await expectModelInfoValue(card, "Output:", "$2.50/M")

			const storedBeforeReasoning = await waitForProfile(
				dlineDir,
				profileName,
				(profile) =>
					profile.baseUrl === modelDiscoveryBaseUrl &&
					profile.modelId === "dline-e2e-discovered-model" &&
					profile.openai?.customModelEnabled === true &&
					profile.openai?.capabilities?.contextWindow === 234_567 &&
					profile.openai.capabilities.maxTokens === 32_768 &&
					profile.openai.capabilities.supportsPromptCache === true &&
					profile.openai.capabilities.supportsTools === true &&
					profile.openai?.pricing?.inputPrice === 1.25 &&
					profile.openai.pricing.outputPrice === 2.5 &&
					profile.openai.pricing.cacheWritesPrice === 0.75 &&
					profile.openai.pricing.cacheReadsPrice === 0.25,
			)
			expect(storedBeforeReasoning.openai?.capabilities?.contextWindow).toBe(234_567)
			expect(storedBeforeReasoning.openai?.pricing).toMatchObject({
				inputPrice: 1.25,
				outputPrice: 2.5,
				cacheWritesPrice: 0.75,
				cacheReadsPrice: 0.25,
			})

			await setCapability(card, "Enable Thinking", false)
			await expect(card.getByText("Reasoning Effort", { exact: true }).last()).not.toBeVisible()
			await waitForProfile(dlineDir, profileName, (profile) => profile.openai?.reasoning?.enableThinking === false)
			await setCapability(card, "Enable Thinking", true)
			await expect(card.getByText("Reasoning Effort", { exact: true }).last()).toBeVisible()
			await waitForProfile(dlineDir, profileName, (profile) => profile.openai?.reasoning?.enableThinking === true)
			await selectLabeledOption(card, firstSidebar, "Thinking Mode", "Thinking Budget")
			await waitForProfile(dlineDir, profileName, (profile) => profile.openai?.reasoning?.thinkingBudget === 1_024)
			await selectLabeledOption(card, firstSidebar, "Thinking Mode", "Reasoning Effort")
			await selectLabeledOption(card, firstSidebar, "Reasoning Effort", "Ultra")
			await waitForProfile(dlineDir, profileName, (profile) => profile.openai?.reasoning?.effort === "ultra")
			await setCapability(card, "Enable Service Tier", false)
			await expect(card.getByText("Service Tier", { exact: true }).last()).not.toBeVisible()
			// The stored profile omits a disabled flag rather than writing false, so
			// "off" covers both an absent and an explicitly false value.
			await waitForProfile(dlineDir, profileName, (profile) => profile.openai?.serviceTierEnabled !== true)
			await setCapability(card, "Enable Service Tier", true)
			await expect(card.getByText("Service Tier", { exact: true }).last()).toBeVisible()
			await waitForProfile(dlineDir, profileName, (profile) => profile.openai?.serviceTierEnabled === true)
			await selectLabeledOption(card, firstSidebar, "Service Tier", "Priority")
			await waitForProfile(dlineDir, profileName, (profile) => profile.openai?.serviceTier === "priority")

			await card.getByRole("button", { name: "Add Header", exact: true }).click()
			await setPlaceholderField(card, "Header name", "X-Dline-E2E")
			await waitForProfile(dlineDir, profileName, (profile) => profile.openai?.openAiHeaders?.["X-Dline-E2E"] === "")
			await setPlaceholderField(card, "Header value", "header-value")
			await waitForProfile(
				dlineDir,
				profileName,
				(profile) => profile.openai?.openAiHeaders?.["X-Dline-E2E"] === "header-value",
			)
			await setCapability(card, "Set Azure API version", true)
			await setPlaceholderField(card, "Default: 2024-10-01-preview", "2025-04-01-preview")
			await setCapability(card, "Use Azure Identity Authentication", true)
			await setCapability(card, "Include usage stats in stream responses", false)
			await waitForProfile(dlineDir, profileName, (profile) => profile.openai?.azureApiVersion === "2025-04-01-preview")
			await waitForProfile(dlineDir, profileName, (profile) => profile.openai?.azureIdentity === true)
			await waitForProfile(dlineDir, profileName, (profile) => profile.openai?.streamIncludeUsage !== true)

			await firstApp.close()
			firstApp = undefined
			helper.clearCachedFrame()

			reopenedApp = await openVSCode(workspaceDir)
			const reopenedPage = await reopenedApp.firstWindow()
			await E2ETestHelper.openClineSidebar(reopenedPage)
			const reopenedSidebar = await helper.getSidebar(reopenedPage)
			await helper.signin(reopenedSidebar)
			await openApiSettings(reopenedPage, reopenedSidebar)

			const reopenedCard = await openModelConfiguration(reopenedSidebar, profileName)
			await expect(reopenedCard.locator('vscode-text-field[placeholder="Enter base URL..."] input')).toHaveValue(
				modelDiscoveryBaseUrl,
			)
			await expect(reopenedCard.locator('vscode-text-field[placeholder="Enter Model ID..."] input')).toHaveValue(
				"dline-e2e-discovered-model",
			)
			await expect(reopenedCard.getByRole("combobox", { name: "API Format" })).toHaveValue(
				String(ApiFormat.OPENAI_RESPONSES),
			)
			await expect(reopenedCard.getByRole("textbox", { name: "Context Window Size" })).toHaveValue("234567")
			await expect(reopenedCard.getByRole("textbox", { name: "Max Output Tokens" })).toHaveValue("32768")
			await expect(reopenedCard.getByRole("textbox", { name: "Input Price ($/1M tokens)" })).toHaveValue("1.25")
			await expect(reopenedCard.getByRole("textbox", { name: "Output Price ($/1M tokens)" })).toHaveValue("2.5")
			await expect(reopenedCard.getByRole("textbox", { name: "Cache Writes ($/M)" })).toHaveValue("0.75")
			await expect(reopenedCard.getByRole("textbox", { name: "Cache Reads ($/M)" })).toHaveValue("0.25")
			await setCapability(reopenedCard, "Supports Prompt Cache", true)
			await setCapability(reopenedCard, "Supports Native Tool Calls", true)
			await setCapability(reopenedCard, "Enable Thinking", true)
			await expectAdvancedValue(reopenedCard, "Prompt Caching", "Yes")
			await expect(reopenedCard.getByText("Reasoning Effort", { exact: true }).last()).toBeVisible()
			await expect(reopenedCard.getByText("Ultra", { exact: true }).last()).toBeVisible()
			await expect(reopenedCard.getByText("Priority", { exact: true }).last()).toBeVisible()
			await expect(reopenedCard.locator('vscode-text-field[placeholder="Header name"] input')).toHaveValue("X-Dline-E2E")
			await expect(reopenedCard.locator('vscode-text-field[placeholder="Header value"] input')).toHaveValue("header-value")
			await expect(reopenedCard.locator('vscode-text-field[placeholder="Default: 2024-10-01-preview"] input')).toHaveValue(
				"2025-04-01-preview",
			)
			await expect
				.poll(() =>
					reopenedCard
						.locator("vscode-checkbox")
						.filter({ hasText: "Use Azure Identity Authentication" })
						.evaluate((element) => Boolean((element as HTMLInputElement).checked)),
				)
				.toBe(true)
			await expect
				.poll(() =>
					reopenedCard
						.locator("vscode-checkbox")
						.filter({ hasText: "Include usage stats in stream responses" })
						.evaluate((element) => Boolean((element as HTMLInputElement).checked)),
				)
				.toBe(false)
			await expect(reopenedCard.getByText("235K", { exact: true })).toBeVisible()
			await expectModelInfoValue(reopenedCard, "Input:", "$1.25/M")
			await expectModelInfoValue(reopenedCard, "Output:", "$2.50/M")
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await reopenedApp?.close()
			await firstApp?.close()
		}
	},
)

e2e(
	"OpenAI task profiles - selection, rename, and task-local switch route subsequent turns",
	async ({ dlineDir, helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await openApiSettings(page, sidebar)

		const mockCard = await openModelConfiguration(sidebar, E2E_PROFILE_NAMES.mockOpenAi)
		await setTextField(mockCard, "Context Window Size", "131072")
		// The tier list only renders once the profile opts in.
		await setCapability(mockCard, "Enable Service Tier", true)
		await selectLabeledOption(mockCard, sidebar, "Service Tier", "Priority")
		await waitForProfile(
			dlineDir,
			E2E_PROFILE_NAMES.mockOpenAi,
			(profile) =>
				profile.openai?.apiFormat === "OPENAI_CHAT" &&
				profile.openai.capabilities?.contextWindow === 131_072 &&
				profile.openai.serviceTier === "priority",
		)

		const responsesCard = await openModelConfiguration(sidebar, E2E_PROFILE_NAMES.mockOpenAiResponses)
		await setTextField(responsesCard, "Context Window Size", "262144")
		await setCapability(responsesCard, "Enable Thinking", true)
		await selectLabeledOption(responsesCard, sidebar, "Thinking Mode", "Reasoning Effort")
		await selectLabeledOption(responsesCard, sidebar, "Reasoning Effort", "Ultra")
		// The tier list only renders once the profile opts in.
		await setCapability(responsesCard, "Enable Service Tier", true)
		await selectLabeledOption(responsesCard, sidebar, "Service Tier", "Flex")
		await waitForProfile(
			dlineDir,
			E2E_PROFILE_NAMES.mockOpenAiResponses,
			(profile) =>
				profile.openai?.apiFormat === "OPENAI_RESPONSES" &&
				profile.openai.capabilities?.contextWindow === 262_144 &&
				profile.openai.reasoning?.effort === "ultra" &&
				profile.openai.serviceTier === "flex",
		)

		await sidebar.getByRole("button", { name: "Done" }).click()
		const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
		await modelSwitcher.click()
		await sidebar.getByRole("option").filter({ hasText: E2E_PROFILE_NAMES.mockOpenAiResponses }).click()
		await expect(modelSwitcher).toHaveText(E2E_PROFILE_NAMES.mockOpenAiResponses)
		await modelSwitcher.click()
		await sidebar.getByRole("option").filter({ hasText: E2E_PROFILE_NAMES.mockOpenAi }).click()
		await expect(modelSwitcher).toHaveText(E2E_PROFILE_NAMES.mockOpenAi)

		server.resetOpenAiMock()
		server.enqueueResponses("openai-compatible-chat", {
			type: "tool",
			id: "call_openai_chat_profile_completion",
			name: "attempt_completion",
			arguments: { result: "E2E_OPENAI_CHAT_PROFILE_OK" },
			expectedRequestIncludes: ["E2E_OPENAI_CHAT_PROFILE_TURN"],
		})
		server.enqueueResponses("openai-compatible-responses", {
			type: "tool",
			id: "call_openai_responses_profile_completion",
			name: "attempt_completion",
			arguments: { result: "E2E_OPENAI_RESPONSES_PROFILE_OK" },
			expectedRequestIncludes: ["E2E_OPENAI_RESPONSES_PROFILE_TURN"],
		})

		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_OPENAI_CHAT_PROFILE_TURN")
		await sidebar.getByTestId("send-button").click()
		await expect(sidebar.getByText("E2E_OPENAI_CHAT_PROFILE_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(1)
		const chatRequest = server.getMockConsumptions("openai-compatible-chat")[0]
		expect(chatRequest).toMatchObject({
			protocol: "openai-chat",
			thinking: { mode: "effort", effort: "high" },
		})
		expect(chatRequest.requestBody).toMatchObject({
			model: "dline-e2e-model",
			service_tier: "priority",
			reasoning_effort: "high",
		})

		const expandTaskHeader = sidebar.getByLabel("Expand task header")
		if (await expandTaskHeader.isVisible()) {
			await expandTaskHeader.click()
		}
		await expect(modelSwitcher).toHaveText(E2E_PROFILE_NAMES.mockOpenAi)
		const contextMaximum = sidebar.locator('[title="Maximum context window size for this model"]')
		await expect(contextMaximum).toHaveText("131.1k")

		await openApiSettings(page, sidebar)
		const renamedProfile = `${E2E_PROFILE_NAMES.mockOpenAi} Renamed`
		const renameCard = getProfileCard(sidebar, E2E_PROFILE_NAMES.mockOpenAi)
		await expandProfileCard(renameCard)
		const profileNameInput = renameCard.locator('input[aria-label="Profile name"]')
		await profileNameInput.fill(renamedProfile)
		await profileNameInput.blur()
		await waitForProfile(dlineDir, renamedProfile, () => true)
		await sidebar.getByRole("button", { name: "Done" }).click()

		await expect(modelSwitcher).toHaveText(renamedProfile)
		await expect(contextMaximum).toHaveText("131.1k")

		await modelSwitcher.click()
		await sidebar.getByRole("option").filter({ hasText: E2E_PROFILE_NAMES.mockOpenAiResponses }).click()
		await expect(modelSwitcher).toHaveText(E2E_PROFILE_NAMES.mockOpenAiResponses)
		await expect(contextMaximum).toHaveText("262.1k")

		await expect(input).toBeEnabled()
		await input.fill("E2E_OPENAI_RESPONSES_PROFILE_TURN")
		await input.press("Enter")
		await expect(sidebar.getByText("E2E_OPENAI_RESPONSES_PROFILE_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(1)
		const responsesRequest = server.getMockConsumptions("openai-compatible-responses")[0]
		expect(responsesRequest).toMatchObject({
			protocol: "openai-responses",
			thinking: { mode: "effort", effort: "ultra" },
		})
		expect(responsesRequest.requestBody).toMatchObject({
			model: "dline-e2e-model",
			service_tier: "flex",
			reasoning: { effort: "ultra" },
		})
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Mode-specific profiles - Plan uses OpenAI Max and Act uses Anthropic High",
	async ({ dlineDir, helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(210_000)
		await helper.signin(sidebar)
		await openApiSettings(page, sidebar)

		const openAiCard = await openModelConfiguration(sidebar, E2E_PROFILE_NAMES.mockOpenAi)
		await setCapability(openAiCard, "Enable Thinking", true)
		await selectLabeledOption(openAiCard, sidebar, "Thinking Mode", "Reasoning Effort")
		await selectLabeledOption(openAiCard, sidebar, "Reasoning Effort", "Max")
		await waitForProfile(
			dlineDir,
			E2E_PROFILE_NAMES.mockOpenAi,
			(profile) =>
				profile.provider === "openai" &&
				profile.openai?.reasoning?.enableThinking === true &&
				profile.openai.reasoning.effort === "max",
		)

		const anthropicCard = await openProfileEditor(sidebar, E2E_PROFILE_NAMES.mockAnthropic)
		const anthropicWebToolsMode = anthropicCard.getByRole("combobox", { name: "Web Tools mode" })
		await anthropicWebToolsMode.selectOption({ label: "Off" })
		await expect(anthropicWebToolsMode).toHaveValue("2")
		await waitForProfile(
			dlineDir,
			E2E_PROFILE_NAMES.mockAnthropic,
			(profile) => profile.webToolsMode === "WEB_TOOLS_MODE_FORCE_OFF",
		)
		await selectOfficialModel(anthropicCard, sidebar, "claude-opus-4-8")
		await waitForProfile(
			dlineDir,
			E2E_PROFILE_NAMES.mockAnthropic,
			(profile) => profile.provider === "anthropic" && profile.modelId === "claude-opus-4-8",
		)
		await setCapability(anthropicCard, "Enable Thinking", true)
		await selectLabeledOption(anthropicCard, sidebar, "Adaptive Thinking", "High")
		await waitForProfile(
			dlineDir,
			E2E_PROFILE_NAMES.mockAnthropic,
			(profile) =>
				profile.modelId === "claude-opus-4-8" &&
				profile.anthropic?.reasoning?.enableThinking === true &&
				profile.anthropic.reasoning.effort === "high" &&
				!profile.anthropic.reasoning.thinkingBudget,
		)

		await sidebar.getByRole("button", { name: "Done" }).click()
		const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
		await modelSwitcher.click()
		const enableSplitModels = sidebar.getByTitle("Use different models per mode")
		if (await enableSplitModels.isVisible()) {
			await expect(enableSplitModels).toHaveAttribute("aria-checked", "false")
			await enableSplitModels.focus()
			await enableSplitModels.press("Enter")
			await expect(sidebar.getByTitle("Disable per-mode models")).toHaveAttribute("aria-checked", "true")
			await E2ETestHelper.waitForValue(async () => {
				const settings = await readSettings(dlineDir)
				return settings.planActSeparateModelsSetting === true ? true : undefined
			})
		}
		await sidebar.getByRole("button", { name: "Act", exact: true }).press("Enter")
		await sidebar
			.getByRole("option")
			.filter({ has: sidebar.getByText(E2E_PROFILE_NAMES.mockAnthropic, { exact: true }) })
			.press("Enter")
		await expect(modelSwitcher).toHaveText(E2E_PROFILE_NAMES.mockAnthropic)

		await modelSwitcher.click()
		await sidebar.getByRole("button", { name: "Plan", exact: true }).press("Enter")
		await sidebar
			.getByRole("option")
			.filter({ has: sidebar.getByText(E2E_PROFILE_NAMES.mockOpenAi, { exact: true }) })
			.press("Enter")
		await E2ETestHelper.waitForValue(async () => {
			const settings = await readSettings(dlineDir)
			return settings.planActSeparateModelsSetting === true &&
				settings.planModeProfile === E2E_PROFILE_NAMES.mockOpenAi &&
				settings.actModeProfile === E2E_PROFILE_NAMES.mockAnthropic
				? settings
				: undefined
		})

		const planMode = sidebar.getByRole("switch", { name: "Plan" })
		const actMode = sidebar.getByRole("switch", { name: "Act" })
		await expect(actMode).toHaveAttribute("aria-checked", "true")
		await expect(modelSwitcher).toHaveText(E2E_PROFILE_NAMES.mockAnthropic)
		await planMode.click()
		await expect(planMode).toHaveAttribute("aria-checked", "true")
		await expect(modelSwitcher).toHaveText(E2E_PROFILE_NAMES.mockOpenAi)

		server.resetOpenAiMock()
		server.enqueueResponses("openai-compatible-chat", {
			type: "tool",
			id: "call_mode_profile_plan_qna",
			name: "qna_respond",
			arguments: { response: "E2E_MODE_PROFILE_PLAN_OPENAI_OK" },
			expectedRequestIncludes: ["E2E_MODE_PROFILE_PLAN_TURN"],
		})
		server.enqueueResponses("anthropic-messages", {
			type: "tool",
			id: "call_mode_profile_act_completion",
			name: "attempt_completion",
			arguments: { result: "E2E_MODE_PROFILE_ACT_ANTHROPIC_OK" },
			// The Act turn must carry the Plan history plus the new Act message, so
			// this proves the mode's own Profile served the follow-up request.
			expectedRequestIncludes: ["E2E_MODE_PROFILE_PLAN_TURN", "E2E_MODE_PROFILE_ACT_TURN", "ACT MODE"],
		})

		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_MODE_PROFILE_PLAN_TURN")
		await sidebar.getByTestId("send-button").click()
		await expect(sidebar.getByText("E2E_MODE_PROFILE_PLAN_OPENAI_OK", { exact: true })).toBeVisible({
			timeout: 60_000,
		})
		await expect(input).toBeEnabled()
		await expect(input).toHaveValue("")
		await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(1)
		const planRequest = server.getMockConsumptions("openai-compatible-chat")[0]
		expect(planRequest).toMatchObject({
			protocol: "openai-chat",
			thinking: { mode: "effort", effort: "max" },
		})
		expect(planRequest.requestBody).toMatchObject({
			model: "dline-e2e-model",
			reasoning_effort: "max",
		})

		await actMode.evaluate((element) => element.click())
		await expect(actMode).toHaveAttribute("aria-checked", "true")
		await expect(modelSwitcher).toHaveText(E2E_PROFILE_NAMES.mockAnthropic)

		// A Q&A answer is the user's to give, so switching to Act only rebinds the
		// mode and its Profile. Sending the next message is what runs the Act turn,
		// which is the routing this test covers.
		await input.fill("E2E_MODE_PROFILE_ACT_TURN")
		await sidebar.getByTestId("send-button").click()
		await expect(sidebar.getByText("E2E_MODE_PROFILE_ACT_ANTHROPIC_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.getRequestCount("anthropic-messages")).toBe(1)
		const actRequest = server.getMockConsumptions("anthropic-messages")[0]
		expect(actRequest).toMatchObject({
			protocol: "anthropic-messages",
			thinking: { mode: "effort", effort: "high" },
		})
		expect(actRequest.requestBody).toMatchObject({
			model: "claude-opus-4-8",
			thinking: { type: "adaptive" },
			output_config: { effort: "high" },
		})
		expect(actRequest.requestHeaders["anthropic-beta"]).toBeUndefined()
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Model configuration - OpenAI official models keep usage-based pricing tiers editable without context tiers",
	async ({ dlineDir, helper, page, sidebar, userDataDir }) => {
		const profileName = E2E_PROFILE_NAMES.mockOpenAiOfficialResponses

		await helper.signin(sidebar)
		await openApiSettings(page, sidebar)
		const card = await openModelConfiguration(sidebar, profileName)

		// OpenAI models have no context-window tiers; context is controlled directly.
		await expect(card.getByRole("button", { name: "Add Context Tier" })).toHaveCount(0)

		// Usage-based pricing tiers stay editable and persist as provider overrides.
		const addPricingTier = card.getByRole("button", { name: "Add Pricing Tier" })
		await expect(addPricingTier).toBeVisible()
		await addPricingTier.click()
		await waitForProfile(dlineDir, profileName, (profile) => profile.openai?.pricing?.tiers?.length === 1)

		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

/**
 * The picker merges catalog and listed models. Its placeholder differs per
 * provider, and the toolkit field renders its input inside a shadow root, so
 * the field is matched on the shared `role="combobox"` the picker sets.
 */
function modelPickerInput(card: Locator): Locator {
	return card.locator('vscode-text-field[role="combobox"] input')
}

/**
 * Opens the listed-model picker, switching away from a persisted custom-model
 * field when necessary. Opening clears the query and triggers remote discovery,
 * so the assertions that follow cover both catalog and freshly listed models.
 */
async function openModelPicker(card: Locator): Promise<Locator> {
	const customModelToggle = card.locator("vscode-checkbox").filter({ hasText: "Use custom model ID" })
	if ((await customModelToggle.count()) === 1) {
		const customModelEnabled = () => customModelToggle.evaluate((element) => Boolean((element as HTMLInputElement).checked))
		if (await customModelEnabled()) await customModelToggle.click()
		await expect.poll(customModelEnabled).toBe(false)
	}
	const input = modelPickerInput(card)
	await expect(input).toHaveCount(1)
	await input.click()
	return input
}

/**
 * Picks a model through the picker's own listbox.
 *
 * A row's accessible name is the model id plus an optional origin badge, and
 * ids can be prefixes of one another, so the name is anchored on both ends.
 */
async function selectOfficialModel(card: Locator, sidebar: Frame, modelId: string): Promise<void> {
	const input = await openModelPicker(card)
	await input.fill(modelId)
	await sidebar.getByRole("option", { name: modelOptionName(modelId) }).click()
	await expect(input).toHaveValue(modelId)
}

/** Matches exactly one picker row: the model id, optionally followed by a badge. */
function modelOptionName(modelId: string): RegExp {
	return new RegExp(`^${escapeRegExp(modelId)}( (New|Custom))?$`)
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

e2e(
	"Model configuration - official model dropdown merges catalog and remote models without custom model ID",
	async ({ helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)

		await helper.signin(sidebar)
		await openApiSettings(page, sidebar)
		server.resetOpenAiMock()

		// OpenAI official profile: one picker covers catalog and remote models while
		// the custom model ID switch stays available for ids no listing returns.
		const openAiCard = await openModelConfiguration(sidebar, E2E_PROFILE_NAMES.mockOpenAiOfficialResponses)
		await expect(openAiCard.locator("vscode-checkbox").filter({ hasText: "Use custom model ID" })).toHaveCount(1)
		await openModelPicker(openAiCard)
		await expect(sidebar.getByRole("option", { name: modelOptionName("gpt-5.4-mini") })).toBeVisible()
		// Models only the provider lists are badged as newly discovered.
		const discoveredOption = sidebar.getByRole("option", { name: modelOptionName("dline-e2e-discovered-model") })
		await expect(discoveredOption).toBeVisible()
		await expect(discoveredOption).toContainText("New")
		await expect
			.poll(() => server.getModelListRequests().filter((request) => request.target === "openai-official-responses").length)
			.toBeGreaterThan(0)

		// Anthropic profile: same merged contract, listed with x-api-key.
		const anthropicCard = await openModelConfiguration(sidebar, E2E_PROFILE_NAMES.mockAnthropic)
		await openModelPicker(anthropicCard)
		await expect(sidebar.getByRole("option", { name: modelOptionName("claude-sonnet-4-6") })).toBeVisible()
		await expect(sidebar.getByRole("option", { name: modelOptionName("dline-e2e-discovered-model") })).toBeVisible()
		await expect
			.poll(() => server.getModelListRequests().filter((request) => request.target === "anthropic-messages").length)
			.toBeGreaterThan(0)
		expect(server.getModelListRequests().find((request) => request.target === "anthropic-messages")).toMatchObject({
			path: "/mock/anthropic/v1/models",
			apiKey: "dline-e2e-api-key",
		})

		// DeepSeek profile: the vendor listing is an OpenAI-style `GET /models`.
		// This provider has no Model Configuration disclosure, so expanding the card is enough.
		const deepSeekCard = await openProfileEditor(sidebar, E2E_PROFILE_NAMES.mockDeepSeek)
		await openModelPicker(deepSeekCard)
		await expect(sidebar.getByRole("option", { name: modelOptionName("deepseek-v4-flash") })).toBeVisible()
		await expect(sidebar.getByRole("option", { name: modelOptionName("dline-e2e-discovered-model") })).toBeVisible()
		await expect
			.poll(() => server.getModelListRequests().filter((request) => request.target === "deepseek-chat").length)
			.toBeGreaterThan(0)

		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Model configuration - official Anthropic models keep a native window and base API id",
	async ({ dlineDir, helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		const profileName = E2E_PROFILE_NAMES.mockAnthropic

		await helper.signin(sidebar)
		await openApiSettings(page, sidebar)
		const card = await openModelConfiguration(sidebar, profileName)
		const webToolsMode = card.getByRole("combobox", { name: "Web Tools mode" })
		await webToolsMode.selectOption({ label: "Off" })
		await waitForProfile(dlineDir, profileName, (profile) => profile.webToolsMode === "WEB_TOOLS_MODE_FORCE_OFF")
		await expect(card.locator("vscode-checkbox").filter({ hasText: "Enable Long Context" })).toHaveCount(0)
		await expect(card.getByRole("button", { name: "Add Context Tier" })).toHaveCount(0)
		const contextWindow = card.getByRole("textbox", { name: "Context Window Size" })
		await expect(contextWindow).toHaveValue("1000000")
		await setTextField(card, "Context Window Size", "1500000")
		await waitForProfile(
			dlineDir,
			profileName,
			(profile) =>
				profile.anthropic?.capabilities?.contextWindow === 1_500_000 &&
				profile.anthropic.capabilities.contextWindowTiers === undefined,
		)

		await sidebar.getByRole("button", { name: "Done" }).click()
		const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
		if ((await modelSwitcher.innerText()).trim() !== profileName) {
			await modelSwitcher.click()
			await sidebar
				.getByRole("option")
				.filter({ has: sidebar.getByText(profileName, { exact: true }) })
				.click()
		}

		server.resetOpenAiMock()
		server.enqueueResponses("anthropic-messages", {
			type: "tool",
			name: "attempt_completion",
			arguments: { result: "E2E_ANTHROPIC_NATIVE_DONE" },
			expectedRequestIncludes: ["E2E_ANTHROPIC_NATIVE_TASK"],
		})

		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_ANTHROPIC_NATIVE_TASK")
		await sidebar.getByTestId("send-button").click()
		await expect(sidebar.getByText("E2E_ANTHROPIC_NATIVE_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		const expandTaskHeader = sidebar.getByLabel("Expand task header")
		if (await expandTaskHeader.isVisible()) await expandTaskHeader.click()
		await expect(sidebar.locator('[title="Maximum context window size for this model"]')).toHaveText("1.5m")
		await expect.poll(() => server.getRequestCount("anthropic-messages")).toBe(1)
		const request = server.getMockConsumptions("anthropic-messages")[0]
		expect(request.requestBody).toMatchObject({ model: "claude-sonnet-4-6" })
		expect(request.requestHeaders["anthropic-beta"]).toBeUndefined()

		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

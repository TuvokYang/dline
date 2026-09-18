import { mkdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { resizePrimarySidebar } from "@e2e/utils/resize-primary-sidebar"
import { expect } from "@playwright/test"
import { ApiFormat } from "@shared/proto/dline/models/metadata"
import { PROVIDER_OPTIONS } from "@shared/providers/providers"
import type { ElectronApplication, Frame, Locator } from "playwright"

interface StoredProfile {
	id: string
	name: string
	provider: string
	modelId?: string
	baseUrl?: string
	deepseek?: { apiFormat?: string }
	openaiCodex?: {
		apiFormat?: string
		websocketEnabled?: boolean
		capabilities?: { contextWindow?: number; maxTokens?: number }
	}
	bedrock?: Record<string, unknown>
	sapaicore?: Record<string, unknown>
}

interface StoredProviderSecret {
	name: string
	provider: string
	secrets: Record<string, string>
}

interface ProviderModel {
	id?: string
	name?: string
	[key: string]: unknown
}

interface ProviderCatalog {
	defaultModelId?: string
	models: Record<string, ProviderModel>
}

async function readJson<T>(filePath: string): Promise<T> {
	return JSON.parse(await readFile(filePath, "utf8")) as T
}

const API_KEY_LABELS: Partial<Record<string, string>> = {
	aihubmix: "AIHubMix API Key",
	anthropic: "Anthropic API Key",
	asksage: "AskSage API Key",
	baseten: "Baseten API Key",
	cerebras: "Cerebras API Key",
	deepseek: "DeepSeek API Key",
	dify: "Dify API Key",
	doubao: "Doubao API Key",
	fireworks: "Fireworks API Key",
	gemini: "Gemini API Key",
	groq: "Groq API Key",
	hicap: "Hicap API Key",
	"huawei-cloud-maas": "Huawei Cloud MaaS API Key",
	huggingface: "Hugging Face API Key",
	litellm: "API Key",
	minimax: "MiniMax API Key",
	mistral: "Mistral API Key",
	moonshot: "Moonshot API Key",
	nebius: "Nebius API Key",
	nousResearch: "Nous Research API Key",
	ollama: "Ollama API Key",
	openai: "OpenAI API Key",
	openrouter: "OpenRouter API Key",
	qwen: "Qwen API Key",
	requesty: "Requesty API Key",
	sambanova: "Sambanova API Key",
	sapaicore: "SAP AI Core API Key",
	together: "Together API Key",
	"vercel-ai-gateway": "Vercel AI Gateway API Key",
	wandb: "W&B API Key",
	xai: "xAI API Key",
	zai: "Z AI API Key",
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

/** Expands the named profile and returns its editable name field. */
async function openProfileNameInput(sidebar: Frame, profileName: string): Promise<Locator> {
	const card = getProfileCard(sidebar, profileName)
	await expect(card).toHaveCount(1)
	await expandProfileCard(card)
	const nameInput = card.locator('input[aria-label="Profile name"]')
	await expect(nameInput).toBeVisible()
	return nameInput
}

e2e(
	"Settings API Config - preserves an API key across an ordinary Profile edit and VS Code restart",
	async ({ dlineDir, helper, openVSCode, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		const profilesPath = path.join(dlineDir, "data", "settings", "api_profiles.json")
		const apiKeysPath = path.join(dlineDir, "data", "secrets", "api_keys.json")
		const apiKey = "e2e-profile-preserved-key"
		const renamedProfile = "Anthropic key persistence"
		let firstApp: ElectronApplication | undefined
		let reopenedApp: ElectronApplication | undefined

		try {
			firstApp = await openVSCode(workspaceDir)
			const firstPage = await firstApp.firstWindow()
			await E2ETestHelper.openClineSidebar(firstPage)
			const firstSidebar = await helper.getSidebar(firstPage)
			await helper.signin(firstSidebar)
			await firstPage.getByRole("button", { name: "Settings", exact: true }).click()
			await expect(firstSidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible()

			const existingProfileIds = new Set((await readJson<StoredProfile[]>(profilesPath)).map((profile) => profile.id))
			await firstSidebar.getByRole("button", { name: "Add profile" }).click()
			const profileCard = firstSidebar.getByTestId("api-profile-card").last()
			const profileId = await E2ETestHelper.waitForValue(async () => {
				const profiles = await readJson<StoredProfile[]>(profilesPath)
				return profiles.find((profile) => !existingProfileIds.has(profile.id))?.id
			})
			await profileCard.getByRole("combobox", { name: "Provider", exact: true }).selectOption("anthropic")
			await E2ETestHelper.waitUntil(async () => {
				const profile = (await readJson<StoredProfile[]>(profilesPath)).find((candidate) => candidate.id === profileId)
				return profile?.provider === "anthropic"
			})

			const apiKeyInput = profileCard.getByRole("textbox", { name: "Anthropic API Key", exact: true })
			await apiKeyInput.fill(apiKey)
			await apiKeyInput.press("Tab")
			await E2ETestHelper.waitUntil(async () => {
				const apiKeys = await readJson<Record<string, { apiKey?: string }>>(apiKeysPath)
				return apiKeys[profileId]?.apiKey === apiKey
			})

			const storedProfile = (await readJson<StoredProfile[]>(profilesPath)).find((profile) => profile.id === profileId)
			if (!storedProfile) throw new Error("Created Anthropic Profile is missing")
			const profileNameInput = profileCard.locator('input[aria-label="Profile name"]')
			await profileNameInput.fill(renamedProfile)
			await profileNameInput.blur()
			await E2ETestHelper.waitUntil(async () => {
				const profiles = await readJson<StoredProfile[]>(profilesPath)
				return profiles.find((profile) => profile.id === profileId)?.name === renamedProfile
			})
			expect((await readJson<Record<string, { apiKey?: string }>>(apiKeysPath))[profileId]?.apiKey).toBe(apiKey)
			expect(await readFile(profilesPath, "utf8")).not.toContain(apiKey)

			await firstApp.close()
			firstApp = undefined
			helper.clearCachedFrame()

			reopenedApp = await openVSCode(workspaceDir)
			const reopenedPage = await reopenedApp.firstWindow()
			await E2ETestHelper.openClineSidebar(reopenedPage)
			const reopenedSidebar = await helper.getSidebar(reopenedPage)
			await helper.signin(reopenedSidebar)
			await reopenedPage.getByRole("button", { name: "Settings", exact: true }).click()

			const reopenedCard = getProfileCard(reopenedSidebar, renamedProfile)
			await expect(reopenedCard).toHaveCount(1)
			await expandProfileCard(reopenedCard)
			await expect(reopenedCard.getByRole("combobox", { name: "Provider", exact: true })).toBeVisible()
			await expect(reopenedCard.getByRole("textbox", { name: "Anthropic API Key", exact: true })).toHaveValue(apiKey)
			expect((await readJson<Record<string, { apiKey?: string }>>(apiKeysPath))[profileId]?.apiKey).toBe(apiKey)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await reopenedApp?.close()
			await firstApp?.close()
		}
	},
)

e2e(
	"Settings API Config - stores Bedrock and SAP structured credentials only in provider secrets and restores them",
	async ({ dlineDir, helper, openVSCode, workspaceDir }) => {
		e2e.setTimeout(180_000)
		const profilesPath = path.join(dlineDir, "data", "settings", "api_profiles.json")
		const providerSecretsPath = path.join(dlineDir, "data", "secrets", "provider_secrets.json")
		let firstApp: ElectronApplication | undefined
		let reopenedApp: ElectronApplication | undefined

		const readProviderSecrets = async () =>
			readFile(providerSecretsPath, "utf8")
				.then((contents) => JSON.parse(contents) as Record<string, StoredProviderSecret>)
				.catch(() => ({}))

		try {
			firstApp = await openVSCode(workspaceDir)
			const firstPage = await firstApp.firstWindow()
			await E2ETestHelper.openClineSidebar(firstPage)
			const firstSidebar = await helper.getSidebar(firstPage)
			await helper.signin(firstSidebar)
			await firstPage.getByRole("button", { name: "Settings", exact: true }).click()
			await expect(firstSidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible()

			const addProviderProfile = async (provider: string) => {
				const existingIds = new Set((await readJson<StoredProfile[]>(profilesPath)).map((profile) => profile.id))
				await firstSidebar.getByRole("button", { name: "Add profile" }).click()
				const card = firstSidebar.getByTestId("api-profile-card").last()
				const id = await E2ETestHelper.waitForValue(async () => {
					const profiles = await readJson<StoredProfile[]>(profilesPath)
					return profiles.find((profile) => !existingIds.has(profile.id))?.id
				})
				await card.getByRole("combobox", { name: "Provider", exact: true }).selectOption(provider)
				const stored = await E2ETestHelper.waitForValue(async () => {
					const profile = (await readJson<StoredProfile[]>(profilesPath)).find((candidate) => candidate.id === id)
					return profile?.provider === provider ? profile : undefined
				})
				return { card, id, name: stored.name }
			}

			const bedrock = await addProviderProfile("bedrock")
			for (const [name, value, secretField] of [
				["AWS Access Key", "E2E_BEDROCK_ACCESS", "awsAccessKey"],
				["AWS Secret Key", "E2E_BEDROCK_SECRET", "awsSecretKey"],
				["AWS Session Token", "E2E_BEDROCK_SESSION", "awsSessionToken"],
			] as const) {
				const field = bedrock.card.getByRole("textbox", { name, exact: true })
				await expect(field).toBeVisible()
				await field.fill(value)
				await field.press("Tab")
				await E2ETestHelper.waitUntil(
					async () => (await readProviderSecrets())[bedrock.id]?.secrets[secretField] === value,
				)
			}

			const sap = await addProviderProfile("sapaicore")
			const sapClientId = sap.card.getByRole("textbox", { name: "Client ID", exact: true })
			await sapClientId.fill("E2E_SAP_CLIENT_ID")
			await sapClientId.press("Tab")
			const sapTokenUrl = sap.card.getByRole("textbox", { name: "Token URL", exact: true })
			await sapTokenUrl.fill("https://auth.example.test/oauth/token")
			await sapTokenUrl.press("Tab")
			const sapSecret = sap.card.getByRole("textbox", { name: "Client Secret", exact: true })
			await sapSecret.fill("E2E_SAP_CLIENT_SECRET")
			await sapSecret.press("Tab")
			await E2ETestHelper.waitUntil(
				async () => (await readProviderSecrets())[sap.id]?.secrets.clientSecret === "E2E_SAP_CLIENT_SECRET",
			)
			await E2ETestHelper.waitUntil(async () => {
				const profile = (await readJson<StoredProfile[]>(profilesPath)).find((candidate) => candidate.id === sap.id)
				return (
					profile?.sapaicore?.clientId === "E2E_SAP_CLIENT_ID" &&
					profile.sapaicore.tokenUrl === "https://auth.example.test/oauth/token"
				)
			})

			const profilesOnDisk = await readFile(profilesPath, "utf8")
			expect(profilesOnDisk).not.toContain("E2E_BEDROCK_ACCESS")
			expect(profilesOnDisk).not.toContain("E2E_BEDROCK_SECRET")
			expect(profilesOnDisk).not.toContain("E2E_BEDROCK_SESSION")
			expect(profilesOnDisk).not.toContain("E2E_SAP_CLIENT_SECRET")

			await firstApp.close()
			firstApp = undefined
			helper.clearCachedFrame()

			reopenedApp = await openVSCode(workspaceDir)
			const reopenedPage = await reopenedApp.firstWindow()
			await E2ETestHelper.openClineSidebar(reopenedPage)
			const reopenedSidebar = await helper.getSidebar(reopenedPage)
			await helper.signin(reopenedSidebar)
			await reopenedPage.getByRole("button", { name: "Settings", exact: true }).click()

			const reopenedBedrock = getProfileCard(reopenedSidebar, bedrock.name)
			await expect(reopenedBedrock).toHaveCount(1)
			await expandProfileCard(reopenedBedrock)
			await expect(reopenedBedrock.getByRole("textbox", { name: "AWS Access Key", exact: true })).toHaveValue(
				"E2E_BEDROCK_ACCESS",
			)
			await expect(reopenedBedrock.getByRole("textbox", { name: "AWS Secret Key", exact: true })).toHaveValue(
				"E2E_BEDROCK_SECRET",
			)
			await expect(reopenedBedrock.getByRole("textbox", { name: "AWS Session Token", exact: true })).toHaveValue(
				"E2E_BEDROCK_SESSION",
			)

			const reopenedSap = getProfileCard(reopenedSidebar, sap.name)
			await expect(reopenedSap).toHaveCount(1)
			await expandProfileCard(reopenedSap)
			await expect(reopenedSap.getByRole("textbox", { name: "Client ID", exact: true })).toHaveValue("E2E_SAP_CLIENT_ID")
			await expect(reopenedSap.getByRole("textbox", { name: "Client Secret", exact: true })).toHaveValue(
				"E2E_SAP_CLIENT_SECRET",
			)
			await expect(reopenedSap.getByRole("textbox", { name: "Token URL", exact: true })).toHaveValue(
				"https://auth.example.test/oauth/token",
			)
		} finally {
			await reopenedApp?.close()
			await firstApp?.close()
		}
	},
)

e2e(
	"Settings API Config - upgrades legacy DeepSeek metadata while preserving user-defined models",
	async ({ dlineHomeDir, helper, openVSCode, userDataDir, workspaceDir }) => {
		e2e.setTimeout(150_000)
		const providerPath = path.join(dlineHomeDir, "providers", "deepseek.json")
		const builtInModelId = "deepseek-v4-pro"
		const catalog = {
			provider: "deepseek",
			providerName: "DeepSeek",
			billingMode: "token",
			defaultModelId: builtInModelId,
			models: {
				[builtInModelId]: {
					id: builtInModelId,
					name: "Legacy DeepSeek V4 Pro",
				},
				"deepseek-user-model": {
					id: "deepseek-user-model",
					name: "DeepSeek User Model",
					userDefined: true,
					apiFormats: [ApiFormat.OPENAI_CHAT],
				},
			},
		}
		await mkdir(path.dirname(providerPath), { recursive: true })
		await writeFile(providerPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8")

		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await helper.signin(sidebar)
			await page.getByRole("button", { name: "Settings", exact: true }).click()

			await sidebar.getByRole("button", { name: "Add profile" }).click()
			const profileCard = sidebar.getByTestId("api-profile-card").last()
			await profileCard.getByRole("combobox", { name: "Provider", exact: true }).selectOption("deepseek")
			const apiFormatSelector = profileCard.getByRole("combobox", { name: "API Format" })
			await expect(apiFormatSelector).toBeVisible()
			await expect(apiFormatSelector.getByRole("option", { name: "OpenAI Responses" })).toHaveCount(1)
			await expect(apiFormatSelector.getByRole("option", { name: "Anthropic Messages" })).toHaveCount(1)

			const updatedCatalog = await readJson<ProviderCatalog>(providerPath)
			expect(updatedCatalog.models[builtInModelId].apiFormats).toEqual([
				ApiFormat.OPENAI_CHAT,
				ApiFormat.OPENAI_RESPONSES,
				ApiFormat.ANTHROPIC_CHAT,
			])
			expect(updatedCatalog.models["deepseek-user-model"]).toMatchObject({
				name: "DeepSeek User Model",
				userDefined: true,
			})
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Settings API Config - hot reloads provider models and persists the selected model",
	async ({ dlineDir, dlineHomeDir, helper, page, sidebar }) => {
		e2e.setTimeout(120_000)
		await helper.signin(sidebar)
		await page.getByRole("button", { name: "Settings", exact: true }).click()
		await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible()

		const profilesPath = path.join(dlineDir, "data", "settings", "api_profiles.json")
		const existingProfileIds = new Set((await readJson<StoredProfile[]>(profilesPath)).map((profile) => profile.id))
		await sidebar.getByRole("button", { name: "Add profile" }).click()
		const profileCard = sidebar.getByTestId("api-profile-card").last()
		await expect(profileCard.locator('input[aria-label="Profile name"]')).toHaveValue("New Model")
		const profileId = await E2ETestHelper.waitForValue(async () => {
			const profiles = await readJson<StoredProfile[]>(profilesPath)
			return profiles.find((profile) => !existingProfileIds.has(profile.id))?.id
		})
		await profileCard.getByRole("combobox", { name: "Provider" }).selectOption("deepseek")
		await E2ETestHelper.waitUntil(async () => {
			const profiles = await readJson<StoredProfile[]>(profilesPath)
			return profiles.find((profile) => profile.id === profileId)?.modelId === "deepseek-v4-pro"
		})

		const apiFormatSelector = profileCard.getByRole("combobox", { name: "API Format" })
		await expect(apiFormatSelector).toHaveValue(String(ApiFormat.OPENAI_CHAT))
		await expect(apiFormatSelector.getByRole("option", { name: "OpenAI Responses" })).toHaveCount(1)
		await apiFormatSelector.selectOption(String(ApiFormat.OPENAI_RESPONSES))
		await E2ETestHelper.waitUntil(async () => {
			const profiles = await readJson<StoredProfile[]>(profilesPath)
			return profiles.find((profile) => profile.id === profileId)?.deepseek?.apiFormat === "OPENAI_RESPONSES"
		})
		await apiFormatSelector.selectOption(String(ApiFormat.OPENAI_CHAT))

		const providerPath = path.join(dlineHomeDir, "providers", "deepseek.json")
		const catalog = await readJson<ProviderCatalog>(providerPath)
		const templateModel = catalog.models[catalog.defaultModelId ?? ""] ?? Object.values(catalog.models)[0]
		if (!templateModel) throw new Error("DeepSeek provider catalog has no model template")

		const modelId = `deepseek-e2e-hot-reload-${Date.now()}`
		catalog.models[modelId] = { ...templateModel, id: modelId, name: modelId }
		await writeFile(providerPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8")

		// The model picker is searchable: typing filters the merged catalog and
		// remote list, and the reloaded entry must appear without a restart.
		const modelSearch = profileCard.locator('vscode-text-field[placeholder="Search, select, or enter a model ID..."] input')
		await modelSearch.click()
		await modelSearch.fill(modelId)
		// A row's accessible name is the model id plus an optional origin badge.
		await sidebar.getByRole("option", { name: new RegExp(`^${modelId}( (New|Custom))?$`) }).click({ timeout: 15_000 })
		await expect(modelSearch).toHaveValue(modelId)

		await E2ETestHelper.waitUntil(async () => {
			const profiles = await readJson<StoredProfile[]>(profilesPath)
			return profiles.find((profile) => profile.id === profileId)?.modelId === modelId
		})
		expect((await readJson<StoredProfile[]>(profilesPath)).find((profile) => profile.id === profileId)?.modelId).toBe(modelId)
	},
)

e2e(
	"Settings API Config - selects every registered provider and stores exposed API keys only in secrets",
	async ({ dlineDir, helper, page, sidebar }) => {
		e2e.setTimeout(600_000)
		await helper.signin(sidebar)
		await page.getByRole("button", { name: "Settings", exact: true }).click()
		await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible()

		const profilesPath = path.join(dlineDir, "data", "settings", "api_profiles.json")
		const apiKeysPath = path.join(dlineDir, "data", "secrets", "api_keys.json")
		const existingProfileIds = new Set((await readJson<StoredProfile[]>(profilesPath)).map((profile) => profile.id))
		await sidebar.getByRole("button", { name: "Add profile" }).click()
		const profileCard = sidebar.getByTestId("api-profile-card").last()
		const profileId = await E2ETestHelper.waitForValue(async () => {
			const profiles = await readJson<StoredProfile[]>(profilesPath)
			return profiles.find((profile) => !existingProfileIds.has(profile.id))?.id
		})
		const providerSelector = profileCard.getByRole("combobox", { name: "Provider", exact: true })

		for (const { value: provider } of PROVIDER_OPTIONS) {
			await providerSelector.selectOption(provider)
			const storedProfile = await E2ETestHelper.waitForValue(async () => {
				const profile = (await readJson<StoredProfile[]>(profilesPath)).find((candidate) => candidate.id === profileId)
				return profile?.provider === provider ? profile : undefined
			})
			const defaultName = `${provider}:${storedProfile.modelId ?? ""}`
			const escapedDefaultName = defaultName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
			expect(storedProfile.name).toMatch(new RegExp(`^${escapedDefaultName}(?::\\d+)?$`))
			await expect(profileCard.locator("input").first()).toHaveValue(storedProfile.name)

			const apiKeyLabel = API_KEY_LABELS[provider]
			if (!apiKeyLabel) continue

			if (provider === "ollama") {
				const customBaseUrl = profileCard.locator("vscode-checkbox").filter({ hasText: "Use custom base URL" })
				await customBaseUrl.click()
				await profileCard.locator('input[placeholder="Default: http://localhost:11434"]').fill("http://127.0.0.1:11434")
				await E2ETestHelper.waitUntil(async () => {
					const profile = (await readJson<StoredProfile[]>(profilesPath)).find(
						(candidate) => candidate.id === profileId,
					)
					return profile?.baseUrl === "http://127.0.0.1:11434"
				})
			}

			const apiKey = `e2e-secret-${provider}`
			const apiKeyInput = profileCard.getByRole("textbox", { name: apiKeyLabel, exact: true })
			await expect(apiKeyInput).toBeVisible()
			await apiKeyInput.fill(apiKey)
			await apiKeyInput.press("Tab")
			await E2ETestHelper.waitUntil(async () => {
				const apiKeys = await readJson<Record<string, { apiKey?: string }>>(apiKeysPath)
				return apiKeys[profileId]?.apiKey === apiKey
			})
			expect(await readFile(profilesPath, "utf8")).not.toContain(apiKey)
		}
	},
)

e2e(
	"Settings API Config - exposes and persists OpenAI Codex model controls",
	async ({ dlineDir, helper, page, sidebar }, testInfo) => {
		await helper.signin(sidebar)
		await page.getByRole("button", { name: "Settings", exact: true }).click()
		await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible()
		const profilesPath = path.join(dlineDir, "data", "settings", "api_profiles.json")
		const existingProfileIds = new Set((await readJson<StoredProfile[]>(profilesPath)).map((profile) => profile.id))
		await sidebar.getByRole("button", { name: "Add profile" }).click()
		const profileId = await E2ETestHelper.waitForValue(async () => {
			const profiles = await readJson<StoredProfile[]>(profilesPath)
			return profiles.find((profile) => !existingProfileIds.has(profile.id))?.id
		})

		const profileCard = sidebar.getByTestId("api-profile-card").last()
		await profileCard.getByRole("combobox", { name: "Provider", exact: true }).selectOption("openai-codex")
		await E2ETestHelper.waitUntil(async () => {
			const profiles = await readJson<StoredProfile[]>(profilesPath)
			return profiles.find((profile) => profile.id === profileId)?.provider === "openai-codex"
		})

		const apiFormat = profileCard.getByRole("combobox", { name: "API Format" })
		await expect(apiFormat).toBeVisible()
		await expect(apiFormat).toHaveValue(String(ApiFormat.OPENAI_RESPONSES))
		await expect(apiFormat).toBeDisabled()
		const websocket = profileCard.locator("vscode-checkbox").filter({ hasText: "Use WebSocket transport" })
		await expect(websocket).toHaveCount(1)
		await expect.poll(() => websocket.evaluate((element) => Boolean((element as HTMLInputElement).checked))).toBe(false)
		await websocket.click()
		await expect.poll(() => websocket.evaluate((element) => Boolean((element as HTMLInputElement).checked))).toBe(true)
		await E2ETestHelper.waitUntil(async () => {
			const profiles = await readJson<StoredProfile[]>(profilesPath)
			const config = profiles.find((profile) => profile.id === profileId)?.openaiCodex
			return config?.apiFormat === "OPENAI_RESPONSES" && config.websocketEnabled === true
		})

		const contextWindow = profileCard.getByRole("textbox", { name: "Context Window Size" })
		if (!(await contextWindow.isVisible())) {
			await profileCard.getByRole("button", { name: "Model Configuration" }).click()
		}
		const maxTokens = profileCard.getByRole("textbox", { name: "Max Output Tokens" })
		await expect(contextWindow).toHaveValue("372000")
		await expect(maxTokens).toHaveValue("128000")
		await contextWindow.fill("400000")
		await contextWindow.press("Tab")
		await maxTokens.fill("64000")
		await maxTokens.press("Tab")
		await E2ETestHelper.waitUntil(async () => {
			const profiles = await readJson<StoredProfile[]>(profilesPath)
			const capabilities = profiles.find((profile) => profile.id === profileId)?.openaiCodex?.capabilities
			return capabilities?.contextWindow === 400_000 && capabilities.maxTokens === 64_000
		})

		// The OAuth control is presented in the product UI language.
		await expect(profileCard.getByRole("button", { name: "Sign in", exact: true })).toBeVisible()
		await expect(profileCard.getByText("ChatGPT: Not signed in")).toBeVisible({ timeout: 15_000 })
		await expect(profileCard.getByText("Invalid credential", { exact: true })).toHaveCount(0)
		await expect(profileCard.getByRole("textbox", { name: /API Key|Access Token|Refresh Token|OAuth JSON/i })).toHaveCount(0)

		for (const sidebarWidth of [320, 480, 700]) {
			const actualSidebarWidth = await resizePrimarySidebar(page, sidebarWidth)
			const cardBox = await profileCard.boundingBox()
			expect(cardBox, "Codex Profile card should have a bounding box").not.toBeNull()
			expect(
				cardBox?.width ?? 0,
				`Codex Profile card should grow with the ${sidebarWidth}px sidebar`,
			).toBeGreaterThanOrEqual(actualSidebarWidth - 195)
			const layout = await sidebar.evaluate(() => ({
				clientWidth: document.documentElement.clientWidth,
				scrollWidth: document.documentElement.scrollWidth,
			}))
			expect(layout.scrollWidth, `Codex Provider should not overflow at ${sidebarWidth}px`).toBeLessThanOrEqual(
				layout.clientWidth + 1,
			)
			await profileCard.screenshot({
				path: testInfo.outputPath(`codex-provider-not-signed-in-${sidebarWidth}px.png`),
			})
		}
	},
)

import { readFile } from "node:fs/promises"
import path from "node:path"
import { expect, type Locator } from "@playwright/test"
import { ApiFormat } from "../../../../shared/proto/dline/models/metadata"

export const MOCK_PROFILE_NAME = "openai:dline-e2e-model"
export const MOCK_MODEL_ID = "dline-e2e-model"
export const MOCK_API_KEY = "demo-api-key-not-real"

export interface StoredProfile {
	id: string
	name: string
	provider: string
	modelId?: string
	baseUrl?: string
	openai?: { apiFormat?: string }
}

/** Called before each visible step so a recording can move its camera to the control being edited. */
export type StepFocus = (target: Locator | Locator[]) => Promise<void>

const skipFocus: StepFocus = async () => {}

export function profilesPath(dlineDir: string): string {
	return path.join(dlineDir, "data", "settings", "api_profiles.json")
}

export async function readStoredProfiles(dlineDir: string): Promise<StoredProfile[]> {
	return JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
}

/** Fill a profile card with an OpenAI-compatible provider that points at the E2E mock server. */
export async function fillMockOpenAiProfile(profileCard: Locator, baseUrl: string, focus: StepFocus = skipFocus): Promise<void> {
	const provider = profileCard.getByRole("combobox", { name: "Provider", exact: true })
	await focus(provider)
	await provider.selectOption("openai")
	const apiFormat = profileCard.getByRole("combobox", { name: "API Format", exact: true })
	await focus(apiFormat)
	await apiFormat.selectOption(String(ApiFormat.OPENAI_CHAT))

	const customBaseUrl = profileCard.locator("vscode-checkbox").filter({ hasText: "Use custom base URL" })
	await focus(customBaseUrl)
	await customBaseUrl.click()
	const baseUrlInput = profileCard.locator('vscode-text-field[placeholder="Enter base URL..."] input')
	await focus(baseUrlInput)
	await baseUrlInput.fill(baseUrl)

	const apiKeyInput = profileCard.getByRole("textbox", { name: "OpenAI API Key", exact: true })
	await focus(apiKeyInput)
	await apiKeyInput.fill(MOCK_API_KEY)
	const customModelId = profileCard.locator("vscode-checkbox").filter({ hasText: "Use custom model ID" })
	await focus(customModelId)
	await customModelId.click()
	const modelInput = profileCard.locator('vscode-text-field[placeholder="Enter Model ID..."] input')
	await focus(modelInput)
	await modelInput.fill(MOCK_MODEL_ID)
}

/** Wait until the autosaved profile has taken its derived display name, so the model picker lists it. */
export async function waitForStoredProfileName(dlineDir: string, name: string): Promise<void> {
	await expect
		.poll(async () => (await readStoredProfiles(dlineDir)).some((profile) => profile.name === name), { timeout: 20_000 })
		.toBe(true)
}

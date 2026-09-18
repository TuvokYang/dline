import { readdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Locator, type Page } from "@playwright/test"

interface StoredProfile {
	id: string
	name: string
	openai?: {
		azureApiVersion?: string
		azureIdentity?: boolean
	}
}

interface StoredTaskSettings {
	actModeProfileId?: string
	actModeProfile?: string
}

interface StoredSnapshot extends Record<string, unknown> {
	phase?: string
	profileInvalid?: {
		profileId?: string
		displayName?: string
		reason: string
		message: string
	}
}

const profilesPath = (dlineDir: string): string => path.join(dlineDir, "data", "settings", "api_profiles.json")

async function readProfiles(dlineDir: string): Promise<StoredProfile[]> {
	return JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
}

async function waitForProfile(
	dlineDir: string,
	profileName: string,
	predicate: (profile: StoredProfile) => boolean,
): Promise<StoredProfile> {
	return E2ETestHelper.waitForValue(async () => {
		const profile = (await readProfiles(dlineDir)).find((candidate) => candidate.name === profileName)
		return profile && predicate(profile) ? profile : undefined
	}, 30_000)
}

async function openApiSettings(page: Page, sidebar: Frame): Promise<void> {
	await page.getByRole("button", { name: "Settings", exact: true }).click()
	await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible({ timeout: 30_000 })
}

function escapeForRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function getProfileCard(sidebar: Frame, profileName: string): Locator {
	return sidebar.getByTestId("api-profile-card").filter({
		has: sidebar.getByRole("button", { name: new RegExp(`^(Expand|Collapse) ${escapeForRegExp(profileName)}$`) }),
	})
}

async function openProfileEditor(sidebar: Frame, profileName: string): Promise<Locator> {
	const card = getProfileCard(sidebar, profileName)
	await expect(card).toHaveCount(1)
	const expandToggle = card.getByRole("button", { name: /^Expand / })
	if (await expandToggle.isVisible()) await expandToggle.click()
	const providerSelector = card.getByRole("combobox", { name: "Provider" })
	await expect(providerSelector).toBeVisible()
	return card
}

async function setAzureIdentity(
	page: Page,
	sidebar: Frame,
	dlineDir: string,
	profileName: string,
	enabled: boolean,
	azureApiVersion?: string | null,
): Promise<void> {
	await openApiSettings(page, sidebar)
	const card = await openProfileEditor(sidebar, profileName)
	if (azureApiVersion !== undefined) {
		const versionToggle = card.locator("vscode-checkbox").filter({ hasText: "Set Azure API version" })
		await expect(versionToggle).toHaveCount(1)
		const versionEnabled = await versionToggle.evaluate((element) => Boolean((element as HTMLInputElement).checked))
		if (azureApiVersion === null) {
			if (versionEnabled) await versionToggle.click()
			await waitForProfile(dlineDir, profileName, (profile) => !profile.openai?.azureApiVersion)
		} else {
			if (!versionEnabled) await versionToggle.click()
			const versionField = card.locator('vscode-text-field[placeholder="Default: 2024-10-01-preview"] input')
			await expect(versionField).toHaveCount(1)
			await versionField.fill(azureApiVersion)
			await versionField.press("Tab")
			await waitForProfile(dlineDir, profileName, (profile) => profile.openai?.azureApiVersion === azureApiVersion)
		}
	}
	const checkbox = card.locator("vscode-checkbox").filter({ hasText: "Use Azure Identity Authentication" })
	await expect(checkbox).toHaveCount(1)
	await expect(checkbox).toBeVisible()
	const current = await checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
	if (current !== enabled) await checkbox.click()
	await expect.poll(() => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))).toBe(enabled)
	await waitForProfile(dlineDir, profileName, (profile) =>
		enabled ? profile.openai?.azureIdentity === true : profile.openai?.azureIdentity !== true,
	)
	await sidebar.getByRole("button", { name: "Done", exact: true }).click()
	await expect(sidebar.getByTestId("chat-input")).toBeVisible()
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled()
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

async function selectProfile(sidebar: Frame, profileName: string): Promise<void> {
	const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
	await modelSwitcher.click()
	await expect(sidebar.getByText("Available Models", { exact: true })).toBeVisible()
	const option = sidebar.getByRole("option").filter({ has: sidebar.getByText(profileName, { exact: true }) })
	await expect(option).toHaveCount(1)
	await option.click()
	await expect(modelSwitcher).toHaveText(profileName, { timeout: 30_000 })
	await expect(sidebar.getByText("Available Models", { exact: true })).not.toBeVisible()
}

async function onlyTaskId(dlineDocsDir: string): Promise<string> {
	return E2ETestHelper.waitForValue(async () => {
		const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true }).catch(() => [])
		const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
		return ids.length === 1 ? ids[0] : undefined
	}, 30_000)
}

async function readTaskSettings(dlineDocsDir: string, taskId: string): Promise<StoredTaskSettings> {
	return JSON.parse(await readFile(path.join(dlineDocsDir, "tasks", taskId, "settings.json"), "utf8")) as StoredTaskSettings
}

async function injectLegacyProfileInvalid(
	dlineDocsDir: string,
	taskId: string,
	profile: StoredProfile,
	message: string,
): Promise<void> {
	const snapshotPath = path.join(dlineDocsDir, "tasks", taskId, "snapshot.json")
	const snapshot = await E2ETestHelper.waitForValue(async () => {
		const parsed = JSON.parse(await readFile(snapshotPath, "utf8")) as StoredSnapshot
		return parsed.phase === "cancelling" ? parsed : undefined
	}, 30_000)
	snapshot.profileInvalid = {
		profileId: profile.id,
		displayName: profile.name,
		reason: "configuration_invalid",
		message,
	}
	await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8")
}

async function reopenTask(page: Page, sidebar: Frame, taskText: string): Promise<void> {
	await page.getByRole("button", { name: "History", exact: true }).click()
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	const historyItem = sidebar.locator(".history-item").filter({ hasText: taskText })
	await expect(historyItem).toHaveCount(1)
	await historyItem.click()
	await expect(sidebar.getByText(taskText, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
}

function profileError(profileName: string): string {
	return `Profile not valid: "${profileName}" requires an Azure endpoint for Azure Identity authentication.`
}

e2e(
	"Current Profile admission - fixing Azure Identity on the same Profile lets Retry continue",
	async ({ dlineDir, helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		const profileName = E2E_PROFILE_NAMES.mockOpenAi
		const taskText = "E2E_CURRENT_PROFILE_AZURE_RETRY_TASK"
		const completion = "E2E_CURRENT_PROFILE_AZURE_RETRY_OK"
		const error = profileError(profileName)

		await helper.signin(sidebar)
		await setAzureIdentity(page, sidebar, dlineDir, profileName, true, "2025-04-01-preview")
		await sendTask(sidebar, taskText)

		const retry = sidebar.locator('vscode-button[aria-label="Retry"]')
		await expect(sidebar.getByText(error, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		await expect(retry).toBeVisible()
		expect(server.getRequestCount("openai-compatible-chat")).toBe(0)

		await setAzureIdentity(page, sidebar, dlineDir, profileName, false, null)
		server.enqueueResponses("openai-compatible-chat", {
			type: "tool",
			name: "attempt_completion",
			arguments: { result: completion },
			expectedRequestIncludes: [taskText],
		})
		await retry.click()

		await expect(sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		await expect(sidebar.getByTestId("error-retry-box")).toHaveCount(0)
		await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(1)
		const consumption = server.getMockConsumptions("openai-compatible-chat")[0]
		if (!consumption) throw new Error("Missing OpenAI Chat mock consumption")
		expect(consumption.contractError).toBeUndefined()
		expect(JSON.stringify(consumption.requestBody).split(taskText)).toHaveLength(2)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/Profile not valid:/])
	},
)

e2e(
	"Current Profile admission - switching away from an invalid Profile clears the old error and the next Send uses the target",
	async ({ dlineDir, dlineDocsDir, helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		const sourceName = E2E_PROFILE_NAMES.mockOpenAi
		const targetName = E2E_PROFILE_NAMES.mockOpenAiResponses
		const taskText = "E2E_CURRENT_PROFILE_SWITCH_TASK"
		const followUp = "E2E_CURRENT_PROFILE_SWITCH_FOLLOWUP"
		const completion = "E2E_CURRENT_PROFILE_SWITCH_OK"
		const error = profileError(sourceName)

		await helper.signin(sidebar)
		await setAzureIdentity(page, sidebar, dlineDir, sourceName, true)
		await sendTask(sidebar, taskText)
		await expect(sidebar.getByText(error, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		await expect(sidebar.locator('vscode-button[aria-label="Retry"]')).toBeVisible()
		expect(server.getRequestCount("openai-compatible-chat")).toBe(0)

		const targetProfile = (await readProfiles(dlineDir)).find((profile) => profile.name === targetName)
		if (!targetProfile) throw new Error("Missing target OpenAI Responses E2E Profile")
		const taskId = await onlyTaskId(dlineDocsDir)
		await selectProfile(sidebar, targetName)

		await expect(sidebar.getByTestId("error-retry-box")).toHaveCount(0)
		await expect(sidebar.locator('vscode-button[aria-label="Retry"]')).toHaveCount(0)
		await expect(sidebar.getByTestId("chat-input")).toBeEnabled()
		await expect
			.poll(async () => readTaskSettings(dlineDocsDir, taskId), { timeout: 30_000 })
			.toMatchObject({ actModeProfileId: targetProfile.id, actModeProfile: targetName })

		server.enqueueResponses("openai-compatible-responses", {
			type: "tool",
			name: "attempt_completion",
			arguments: { result: completion },
			expectedRequestIncludes: [taskText, followUp],
		})
		await sendTask(sidebar, followUp)
		await expect(sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		expect(server.getRequestCount("openai-compatible-chat")).toBe(0)
		await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(1)
		expect(server.getMockConsumptions("openai-compatible-responses")[0]?.contractError).toBeUndefined()
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/Profile not valid:/])
	},
)

e2e(
	"Current Profile admission - Close and History Resume ignore legacy invalid state and revalidate the current Profile",
	async ({ dlineDir, dlineDocsDir, helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(240_000)
		const profileName = E2E_PROFILE_NAMES.mockOpenAi
		const taskText = "E2E_CURRENT_PROFILE_CANCEL_RESUME_TASK"
		const completion = "E2E_CURRENT_PROFILE_CANCEL_RESUME_OK"
		const error = profileError(profileName)

		await helper.signin(sidebar)
		await setAzureIdentity(page, sidebar, dlineDir, profileName, true)
		await sendTask(sidebar, taskText)
		await expect(sidebar.getByText(error, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		await expect(sidebar.locator('vscode-button[aria-label="Retry"]')).toBeVisible()
		expect(server.getRequestCount("openai-compatible-chat")).toBe(0)

		const sourceProfile = (await readProfiles(dlineDir)).find((profile) => profile.name === profileName)
		if (!sourceProfile) throw new Error("Missing source OpenAI E2E Profile")
		const taskId = await onlyTaskId(dlineDocsDir)
		await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
		await expect(sidebar.getByTestId("chat-input")).toHaveAttribute("placeholder", "Type your task here...")
		await injectLegacyProfileInvalid(dlineDocsDir, taskId, sourceProfile, error)

		await setAzureIdentity(page, sidebar, dlineDir, profileName, false)
		await reopenTask(page, sidebar, taskText)
		const retry = sidebar.locator('vscode-button[aria-label="Retry"]')
		await expect(retry).toBeVisible({ timeout: 30_000 })
		await expect(sidebar.getByTestId("chat-input")).toBeEnabled()
		await expect(sidebar.getByRole("button", { name: "Select model" })).toHaveText(profileName)

		server.enqueueResponses("openai-compatible-chat", {
			type: "tool",
			name: "attempt_completion",
			arguments: { result: completion },
			expectedRequestIncludes: [taskText],
		})
		await retry.click()
		await expect(sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(1)
		expect(server.getMockConsumptions("openai-compatible-chat")[0]?.contractError).toBeUndefined()
		await expect(sidebar.getByTestId("error-retry-box")).toHaveCount(0)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/Profile not valid:/])
	},
)

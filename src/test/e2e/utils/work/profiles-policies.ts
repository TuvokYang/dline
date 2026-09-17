import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { E2ETestHelper } from "@e2e/utils/helpers"
import { expect, type Frame, type Locator, type Page } from "@playwright/test"

export interface WorkStoredProfile {
	id: string
	name: string
	provider: string
	baseUrl?: string
	modelId?: string
	webToolsMode?: string
	openai?: { customModelEnabled?: boolean; apiFormat?: string; [key: string]: unknown }
	anthropic?: { customModelEnabled?: boolean; [key: string]: unknown }
	[key: string]: unknown
}

export interface WorkTaskProfileBinding {
	actModeProfileId?: string
	actModeProfile?: string
	planModeProfileId?: string
	planModeProfile?: string
	[key: string]: unknown
}

const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export async function readWorkProfiles(dlineDir: string): Promise<WorkStoredProfile[]> {
	return JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as WorkStoredProfile[]
}

export async function readWorkProfileCatalogText(dlineDir: string): Promise<string> {
	return readFile(profilesPath(dlineDir), "utf8")
}

export async function waitForWorkProfile(
	dlineDir: string,
	profileId: string,
	predicate: (profile: WorkStoredProfile) => boolean,
	timeoutMs = 30_000,
): Promise<WorkStoredProfile> {
	return E2ETestHelper.waitForValue(async () => {
		const profile = (await readWorkProfiles(dlineDir)).find((candidate) => candidate.id === profileId)
		return profile && predicate(profile) ? profile : undefined
	}, timeoutMs)
}

export async function readWorkSettings(dlineDir: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
}

export function workSettingValue<T>(settings: Record<string, unknown>, key: string): T | undefined {
	const values =
		typeof settings.values === "object" && settings.values !== null ? (settings.values as Record<string, unknown>) : undefined
	return (values?.[key] ?? settings[key]) as T | undefined
}

export async function waitForWorkSetting<T>(dlineDir: string, key: string, expected: T): Promise<void> {
	await E2ETestHelper.waitForValue(
		async () => (workSettingValue<T>(await readWorkSettings(dlineDir), key) === expected ? true : undefined),
		30_000,
	)
}

export async function openWorkSettings(page: Page, sidebar: Frame): Promise<void> {
	await page.getByRole("button", { name: "Settings", exact: true }).click()
	await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible({ timeout: 30_000 })
}

export async function finishWorkSettings(sidebar: Frame): Promise<void> {
	await sidebar.getByRole("button", { name: "Done", exact: true }).click()
	await expect(sidebar.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 })
}

export function getWorkProfileCard(sidebar: Frame, profileName: string): Locator {
	return sidebar.getByTestId("api-profile-card").filter({
		has: sidebar.getByRole("button", { name: new RegExp(`^(Expand|Collapse) ${escapeRegExp(profileName)}$`) }),
	})
}

export async function expandWorkProfileCard(sidebar: Frame, profileName: string): Promise<Locator> {
	const card = getWorkProfileCard(sidebar, profileName)
	await expect(card).toHaveCount(1)
	const expand = card.getByRole("button", { name: /^Expand / })
	if (await expand.isVisible()) await expand.click()
	await expect(card.getByRole("button", { name: /^Collapse / })).toBeVisible()
	return card
}

export async function setWorkCheckbox(card: Locator, label: string, enabled: boolean): Promise<void> {
	const checkbox = card.locator("vscode-checkbox").filter({ hasText: label })
	await expect(checkbox).toHaveCount(1)
	const checked = () => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
	if ((await checked()) !== enabled) await checkbox.click()
	await expect.poll(checked).toBe(enabled)
}

export async function setWorkCustomBaseUrl(card: Locator, value: string, placeholder = "Enter base URL..."): Promise<void> {
	await setWorkCheckbox(card, "Use custom base URL", true)
	const field = card.locator(`vscode-text-field[placeholder=${JSON.stringify(placeholder)}] input`)
	await expect(field).toBeVisible()
	await field.fill(value)
	await field.blur()
}

export async function setWorkCustomModelId(card: Locator, value: string): Promise<void> {
	await setWorkCheckbox(card, "Use custom model ID", true)
	const field = card.locator('vscode-text-field[placeholder="Enter Model ID..."] input')
	await expect(field).toHaveCount(1)
	await field.fill(value)
	await field.blur()
}

export function workModelPickerInput(card: Locator): Locator {
	return card.locator('vscode-text-field[role="combobox"] input')
}

export async function setWorkWebToolsMode(card: Locator, label: "Auto" | "Local only" | "Off" | "Hosted only"): Promise<void> {
	const values = { Auto: "0", "Local only": "1", Off: "2", "Hosted only": "3" } as const
	const mode = card.getByRole("combobox", { name: "Web Tools mode" })
	await expect(mode).toBeVisible()
	await mode.selectOption({ label })
	await expect(mode).toHaveValue(values[label])
}

export async function selectWorkModel(card: Locator, sidebar: Frame, modelId: string): Promise<void> {
	const customModelToggle = card.locator("vscode-checkbox").filter({ hasText: "Use custom model ID" })
	if ((await customModelToggle.count()) === 1) {
		const checked = () => customModelToggle.evaluate((element) => Boolean((element as HTMLInputElement).checked))
		if (await checked()) await customModelToggle.click()
		await expect.poll(checked).toBe(false)
	}
	const input = workModelPickerInput(card)
	await expect(input).toHaveCount(1)
	await input.click()
	await input.fill(modelId)
	await sidebar.getByRole("option", { name: new RegExp(`^${escapeRegExp(modelId)}( (New|Custom))?$`) }).click()
	await expect(input).toHaveValue(modelId)
}

async function setDropdownValue(sidebar: Frame, dropdown: Locator, value: string, label: string): Promise<void> {
	await dropdown.evaluate((element) => {
		const target = element as HTMLElement & { __workChangeValues?: string[] }
		target.__workChangeValues = []
		target.addEventListener("change", () => {
			target.__workChangeValues?.push((target as unknown as HTMLSelectElement).value)
		})
	})
	await dropdown.click()
	await sidebar.getByRole("option", { name: label, exact: true }).click()
	await expect.poll(() => dropdown.evaluate((element) => (element as HTMLSelectElement).value)).toBe(value)
}

export async function setWorkSendShortcut(sidebar: Frame, value: "enter" | "ctrlEnter" | "shiftEnter"): Promise<void> {
	await sidebar.getByTestId("tab-general").click()
	const labels = { enter: "Enter", ctrlEnter: "Ctrl + Enter", shiftEnter: "Shift + Enter" } as const
	await setDropdownValue(sidebar, sidebar.locator("#chat-input-send-shortcut"), value, labels[value])
}

export async function setWorkFeature(sidebar: Frame, label: string, enabled: boolean): Promise<void> {
	await sidebar.getByTestId("tab-features").click()
	const toggle = sidebar.getByRole("switch", { name: label, exact: true })
	await expect(toggle).toBeVisible()
	const checked = async () => (await toggle.getAttribute("aria-checked")) === "true"
	if ((await checked()) !== enabled) await toggle.click()
	await expect.poll(checked).toBe(enabled)
}

export async function selectWorkProfile(sidebar: Frame, profileName: string): Promise<void> {
	const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
	await modelSwitcher.click()
	await expect(sidebar.getByText("Available Models", { exact: true })).toBeVisible()
	const option = sidebar.getByRole("option").filter({ has: sidebar.getByText(profileName, { exact: true }) })
	await expect(option).toHaveCount(1)
	await option.click()
	await expect(modelSwitcher).toHaveText(profileName, { timeout: 30_000 })
	await expect(sidebar.getByText("Available Models", { exact: true })).not.toBeVisible()
}

export async function sendWorkMessageWithCtrlEnter(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled({ timeout: 30_000 })
	await input.fill(text)
	await input.press("Control+Enter")
	await expect(sidebar.getByText(text, { exact: true }).last()).toBeVisible({ timeout: 30_000 })
}

export async function workTaskIdByMarker(dlineDocsDir: string, marker: string): Promise<string> {
	return E2ETestHelper.waitForValue(async () => {
		const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true }).catch(() => [])
		for (const entry of entries) {
			if (!entry.isDirectory()) continue
			const messages = await readFile(path.join(dlineDocsDir, "tasks", entry.name, "ui_messages.jsonl"), "utf8").catch(
				() => "",
			)
			if (messages.includes(marker)) return entry.name
		}
		return undefined
	}, 30_000)
}

export async function readWorkTaskBinding(dlineDocsDir: string, taskId: string): Promise<WorkTaskProfileBinding | undefined> {
	try {
		return JSON.parse(
			await readFile(path.join(dlineDocsDir, "tasks", taskId, "settings.json"), "utf8"),
		) as WorkTaskProfileBinding
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === "ENOENT" || code === "EBUSY") return undefined
		throw error
	}
}

export async function waitForWorkTaskBinding(
	dlineDocsDir: string,
	taskId: string,
	profileId: string,
	profileName: string,
): Promise<void> {
	await expect
		.poll(async () => readWorkTaskBinding(dlineDocsDir, taskId), { timeout: 30_000 })
		.toMatchObject({ actModeProfileId: profileId, actModeProfile: profileName })
}

export async function renameWorkProfile(
	sidebar: Frame,
	dlineDir: string,
	profileId: string,
	currentName: string,
	nextName: string,
): Promise<void> {
	await sidebar.getByRole("button", { name: "Manage profiles" }).click()
	await expect(sidebar.getByRole("button", { name: "Done managing profiles" })).toBeVisible()
	const input = sidebar.locator(`input[value=${JSON.stringify(currentName)}]`)
	await expect(input).toHaveCount(1)
	await input.fill(nextName)
	await input.blur()
	await waitForWorkProfile(dlineDir, profileId, (profile) => profile.name === nextName)
	await sidebar.getByRole("button", { name: "Done managing profiles" }).click()
}

export async function closeWorkTask(sidebar: Frame): Promise<void> {
	const closeTask = sidebar.getByRole("button", { name: "Close Task", exact: true })
	await expect(closeTask).toBeVisible({ timeout: 30_000 })
	await closeTask.click()
	await expect(sidebar.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 })
}

export async function openWorkHistoryTask(page: Page, sidebar: Frame, taskMarker: string): Promise<void> {
	await page.getByRole("button", { name: "History", exact: true }).click()
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	const item = sidebar.locator(".history-item").filter({ hasText: taskMarker })
	await expect(item).toHaveCount(1)
	await item.click()
	await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
	await expect(sidebar.getByText(taskMarker, { exact: false }).first()).toBeVisible({ timeout: 30_000 })
}

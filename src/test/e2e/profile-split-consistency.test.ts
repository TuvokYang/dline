import { readdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { expect, type Frame, type Page } from "@playwright/test"
import type { ElectronApplication } from "playwright"
import { E2E_PROFILE_NAMES } from "./utils/api-profile"
import { E2ETestHelper, e2e } from "./utils/helpers"

interface StoredProfile {
	id: string
	name: string
	modelId?: string
	webToolsMode?: "WEB_TOOLS_MODE_FORCE_OFF"
	openai?: {
		capabilities?: {
			contextWindow?: number
		}
	}
}

interface StoredTaskSettings {
	mode?: string
	planModeProfileId?: string
	planModeProfile?: string
	actModeProfileId?: string
	actModeProfile?: string
}

const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")
const globalStatePath = (dlineDir: string) => path.join(dlineDir, "data", "globalState.json")

async function readProfiles(dlineDir: string): Promise<StoredProfile[]> {
	return JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
}

function requireProfile(profiles: StoredProfile[], profileName: string): StoredProfile {
	const profile = profiles.find((candidate) => candidate.name === profileName)
	if (!profile) throw new Error(`Missing E2E Profile: ${profileName}`)
	return profile
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function configureGlobalProfiles(
	dlineDir: string,
	options: {
		separate: boolean
		planProfile: StoredProfile
		actProfile: StoredProfile
		useAutoCondense?: boolean
	},
): Promise<void> {
	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
	await writeJson(settingsPath(dlineDir), {
		...settings,
		planActSeparateModelsSetting: options.separate,
		planModeProfileId: options.planProfile.id,
		planModeProfile: options.planProfile.name,
		actModeProfileId: options.actProfile.id,
		actModeProfile: options.actProfile.name,
		useAutoCondense: options.useAutoCondense ?? false,
	})

	const globalState = JSON.parse(await readFile(globalStatePath(dlineDir), "utf8")) as Record<string, unknown>
	await writeJson(globalStatePath(dlineDir), { ...globalState, mode: "act" })
}

async function configureProfileCatalog(
	dlineDir: string,
	contextWindows: Partial<Record<string, number>> = {},
): Promise<Record<string, StoredProfile>> {
	const profiles = await readProfiles(dlineDir)
	for (const profile of profiles) {
		if (
			profile.name === E2E_PROFILE_NAMES.mockOpenAi ||
			profile.name === E2E_PROFILE_NAMES.mockOpenAiResponses ||
			profile.name === E2E_PROFILE_NAMES.mockDeepSeek
		) {
			profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
		}
		const contextWindow = contextWindows[profile.name]
		if (contextWindow !== undefined) {
			if (!profile.openai?.capabilities) throw new Error(`Profile does not expose configurable context: ${profile.name}`)
			profile.openai.capabilities.contextWindow = contextWindow
		}
	}
	await writeJson(profilesPath(dlineDir), profiles)
	return Object.fromEntries(profiles.map((profile) => [profile.name, profile]))
}

async function onlyTaskId(dlineDocsDir: string): Promise<string> {
	return E2ETestHelper.waitForValue(async () => {
		const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true }).catch(() => [])
		const taskIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
		return taskIds.length === 1 ? taskIds[0] : undefined
	}, 30_000)
}

async function readTaskSettings(dlineDocsDir: string, taskId: string): Promise<StoredTaskSettings> {
	return JSON.parse(await readFile(path.join(dlineDocsDir, "tasks", taskId, "settings.json"), "utf8")) as StoredTaskSettings
}

async function writeTaskSettings(dlineDocsDir: string, taskId: string, settings: StoredTaskSettings): Promise<void> {
	await writeJson(path.join(dlineDocsDir, "tasks", taskId, "settings.json"), settings)
}

async function openSidebar(app: ElectronApplication, helper: E2ETestHelper): Promise<{ page: Page; sidebar: Frame }> {
	const page = await app.firstWindow()
	await E2ETestHelper.openClineSidebar(page)
	const sidebar = await helper.getSidebar(page)
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	await helper.signin(sidebar)
	return { page, sidebar }
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled({ timeout: 60_000 })
	await input.fill(text)
	await input.press("Enter")
}

async function reopenTaskFromHistory(page: Page, sidebar: Frame, taskText: string): Promise<void> {
	await page.getByRole("button", { name: "History", exact: true }).click()
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	const historyItem = sidebar.locator(".history-item").filter({ hasText: taskText })
	await expect(historyItem).toHaveCount(1)
	await historyItem.click()
	await expect(sidebar.getByText(taskText, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
}

async function openProfileMenu(sidebar: Frame): Promise<void> {
	await sidebar.getByRole("button", { name: "Select model" }).click()
	await expect(sidebar.getByText("Available Models", { exact: true })).toBeVisible()
}

function profileOption(sidebar: Frame, profileName: string) {
	return sidebar.getByRole("option").filter({ has: sidebar.getByText(profileName, { exact: true }) })
}

function uniqueDefined(values: Array<string | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => value !== undefined))].sort()
}

e2e(
	"Unified task Profile reuses its existing binding instead of importing a missing mode from global settings",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		const catalog = await configureProfileCatalog(dlineDir)
		const taskProfile = requireProfile(Object.values(catalog), E2E_PROFILE_NAMES.mockOpenAiResponses)
		const globalProfile = requireProfile(Object.values(catalog), E2E_PROFILE_NAMES.mockDeepSeek)
		await configureGlobalProfiles(dlineDir, {
			separate: false,
			planProfile: taskProfile,
			actProfile: taskProfile,
		})
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_unified_profile_initial",
				name: "attempt_completion",
				arguments: { result: "E2E_UNIFIED_PROFILE_INITIAL_OK" },
				expectedRequestIncludes: ["E2E_UNIFIED_PROFILE_TASK"],
			},
			{
				type: "tool",
				id: "call_unified_profile_resume",
				name: "attempt_completion",
				arguments: { result: "E2E_UNIFIED_PROFILE_RESUME_OK" },
				expectedRequestIncludes: ["E2E_UNIFIED_PROFILE_RESUME"],
			},
		)

		let app: ElectronApplication | undefined
		try {
			app = await openVSCode(workspaceDir)
			let { page, sidebar } = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_UNIFIED_PROFILE_TASK")
			await expect(sidebar.getByText("E2E_UNIFIED_PROFILE_INITIAL_OK", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			const taskId = await onlyTaskId(dlineDocsDir)

			await app.close()
			app = undefined
			helper.clearCachedFrame()

			const taskSettings = await readTaskSettings(dlineDocsDir, taskId)
			const partialTaskSettings = { ...taskSettings }
			partialTaskSettings.mode = "act"
			partialTaskSettings.planModeProfileId = taskProfile.id
			partialTaskSettings.planModeProfile = taskProfile.name
			delete partialTaskSettings.actModeProfileId
			delete partialTaskSettings.actModeProfile
			await writeTaskSettings(dlineDocsDir, taskId, partialTaskSettings)
			await configureGlobalProfiles(dlineDir, {
				separate: false,
				planProfile: globalProfile,
				actProfile: globalProfile,
			})

			app = await openVSCode(workspaceDir)
			;({ page, sidebar } = await openSidebar(app, helper))
			await reopenTaskFromHistory(page, sidebar, "E2E_UNIFIED_PROFILE_TASK")

			const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
			await expect(modelSwitcher).toHaveText(taskProfile.name, { timeout: 30_000 })
			const persisted = await readTaskSettings(dlineDocsDir, taskId)
			expect(JSON.stringify(persisted)).not.toContain(globalProfile.id)
			expect(JSON.stringify(persisted)).not.toContain(globalProfile.name)

			await sendTask(sidebar, "E2E_UNIFIED_PROFILE_RESUME")
			await expect(sidebar.getByText("E2E_UNIFIED_PROFILE_RESUME_OK", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(2)
			expect(server.getRequestCount("deepseek-chat")).toBe(0)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)

e2e(
	"Disabling split Profile mode collapses an active task to one task-local binding",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(120_000)
		const catalog = await configureProfileCatalog(dlineDir)
		const planProfile = requireProfile(Object.values(catalog), E2E_PROFILE_NAMES.mockOpenAiResponses)
		const actProfile = requireProfile(Object.values(catalog), E2E_PROFILE_NAMES.mockDeepSeek)
		await configureGlobalProfiles(dlineDir, {
			separate: true,
			planProfile,
			actProfile,
		})
		server.enqueueResponses("deepseek-chat", {
			type: "tool",
			id: "call_disable_split_ready",
			name: "attempt_completion",
			arguments: { result: "E2E_DISABLE_SPLIT_READY" },
			expectedRequestIncludes: ["E2E_DISABLE_SPLIT_TASK"],
		})
		const app = await openVSCode(workspaceDir)
		try {
			const { sidebar } = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_DISABLE_SPLIT_TASK")
			await expect(sidebar.getByText("E2E_DISABLE_SPLIT_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			const taskId = await onlyTaskId(dlineDocsDir)

			await openProfileMenu(sidebar)
			const disableSplit = sidebar.getByTitle("Disable per-mode models")
			await expect(disableSplit).toBeVisible()
			await disableSplit.press("Enter")
			await E2ETestHelper.waitForValue(async () => {
				const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
				return settings.planActSeparateModelsSetting === false ? true : undefined
			})

			await expect
				.poll(
					async () => {
						const settings = await readTaskSettings(dlineDocsDir, taskId)
						return {
							profileIds: uniqueDefined([settings.planModeProfileId, settings.actModeProfileId]),
							profileNames: uniqueDefined([settings.planModeProfile, settings.actModeProfile]),
						}
					},
					{ timeout: 30_000 },
				)
				.toEqual({ profileIds: [actProfile.id], profileNames: [actProfile.name] })

			await expect(profileOption(sidebar, actProfile.name)).toHaveAttribute("aria-selected", "true")
			await expect(profileOption(sidebar, planProfile.name)).toHaveAttribute("aria-selected", "false")
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Split Profile selection unlocks after a confirmed active-mode switch and remains selected",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		const catalog = await configureProfileCatalog(dlineDir, {
			[E2E_PROFILE_NAMES.mockOpenAiResponses]: 272_000,
			[E2E_PROFILE_NAMES.mockOpenAi]: 131_072,
		})
		const sourceProfile = requireProfile(Object.values(catalog), E2E_PROFILE_NAMES.mockOpenAiResponses)
		const targetProfile = requireProfile(Object.values(catalog), E2E_PROFILE_NAMES.mockOpenAi)
		await configureGlobalProfiles(dlineDir, {
			separate: true,
			planProfile: sourceProfile,
			actProfile: sourceProfile,
			useAutoCondense: false,
		})
		const latestMessage = ["E2E_SPLIT_PROFILE_LATEST", "a ".repeat(40_000)].join("\n")
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_split_profile_history_ready",
				name: "qna_respond",
				arguments: { response: "E2E_SPLIT_PROFILE_HISTORY_READY" },
				expectedRequestIncludes: ["E2E_SPLIT_PROFILE_TASK"],
			},
			{
				type: "tool",
				id: "call_split_profile_source_ready",
				name: "qna_respond",
				arguments: { response: "E2E_SPLIT_PROFILE_SOURCE_READY" },
				usage: { inputTokens: 140_000, outputTokens: 100 },
				expectedRequestIncludes: ["E2E_SPLIT_PROFILE_LATEST"],
			},
			{
				type: "tool",
				id: "call_split_profile_durable_ready",
				name: "qna_respond",
				arguments: { response: "E2E_SPLIT_PROFILE_DURABLE_READY" },
				usage: { inputTokens: 140_000, outputTokens: 100 },
				expectedRequestIncludes: ["E2E_SPLIT_PROFILE_DURABLE"],
			},
		)
		const app = await openVSCode(workspaceDir)
		try {
			const { sidebar } = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_SPLIT_PROFILE_TASK")
			await expect(sidebar.getByText("E2E_SPLIT_PROFILE_HISTORY_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await sendTask(sidebar, latestMessage)
			await expect(sidebar.getByText("E2E_SPLIT_PROFILE_SOURCE_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await sendTask(sidebar, "E2E_SPLIT_PROFILE_DURABLE")
			await expect(sidebar.getByText("E2E_SPLIT_PROFILE_DURABLE_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			const taskId = await onlyTaskId(dlineDocsDir)

			const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
			await openProfileMenu(sidebar)
			await expect(sidebar.getByTitle("Disable per-mode models")).toBeVisible()
			await sidebar.getByRole("button", { name: "Act", exact: true }).press("Enter")
			await profileOption(sidebar, targetProfile.name).press("Enter")

			const dialog = sidebar.getByRole("dialog")
			await expect(dialog.getByRole("heading", { name: "Switch to a smaller context window?" })).toBeVisible()
			await expect(dialog).toContainText("nothing is compacted now")
			await expect(dialog.getByRole("button", { name: "Compact & Switch" })).toHaveCount(0)
			await dialog.getByRole("button", { name: "Switch", exact: true }).click()
			await expect(modelSwitcher).toHaveText(targetProfile.name, { timeout: 60_000 })
			expect(server.getRequestCount("openai-compatible-chat")).toBe(0)

			await expect(modelSwitcher).toBeEnabled()
			await openProfileMenu(sidebar)
			await sidebar.getByRole("button", { name: "Act", exact: true }).press("Enter")
			await expect(profileOption(sidebar, targetProfile.name)).toHaveAttribute("aria-selected", "true")
			await expect(profileOption(sidebar, sourceProfile.name)).toHaveAttribute("aria-selected", "false")
			await expect
				.poll(async () => readTaskSettings(dlineDocsDir, taskId), { timeout: 30_000 })
				.toMatchObject({
					planModeProfileId: sourceProfile.id,
					planModeProfile: sourceProfile.name,
					actModeProfileId: targetProfile.id,
					actModeProfile: targetProfile.name,
				})
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

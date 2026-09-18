import { readdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Page } from "@playwright/test"
import type { ElectronApplication } from "playwright"

interface StoredProfile {
	id: string
	name: string
}

interface StoredTaskSettings {
	[key: string]: unknown
	actModeProfileId?: string
	actModeProfile?: string
	planModeProfileId?: string
	planModeProfile?: string
}

const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")
const globalStatePath = (dlineDir: string) => path.join(dlineDir, "data", "globalState.json")

async function readProfiles(dlineDir: string): Promise<StoredProfile[]> {
	return JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
}

async function waitForProfileName(dlineDir: string, profileId: string, expectedName: string): Promise<void> {
	await E2ETestHelper.waitForValue(async () => {
		const profile = (await readProfiles(dlineDir)).find((candidate) => candidate.id === profileId)
		return profile?.name === expectedName ? profile : undefined
	}, 30_000)
}

async function onlyTaskId(dlineDocsDir: string): Promise<string> {
	return E2ETestHelper.waitForValue(async () => {
		const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true }).catch(() => [])
		const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
		return ids.length === 1 ? ids[0] : undefined
	}, 30_000)
}

async function readTaskSettings(dlineDocsDir: string, taskId: string): Promise<StoredTaskSettings | undefined> {
	try {
		return JSON.parse(await readFile(path.join(dlineDocsDir, "tasks", taskId, "settings.json"), "utf8")) as StoredTaskSettings
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === "ENOENT" || code === "EBUSY") return undefined
		throw error
	}
}

async function openApiSettings(page: Page, sidebar: Frame): Promise<void> {
	await page.getByRole("button", { name: "Settings", exact: true }).click()
	await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible()
}

e2e(
	"Profile rename - history opens a legacy name-only task and recovers through the renamed Profile",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		const taskText = "E2E_PROFILE_RENAME_HISTORY_TASK"
		const followUpText = "E2E_PROFILE_RENAME_HISTORY_FOLLOW_UP"
		const renamedProfileName = `${E2E_PROFILE_NAMES.mockOpenAi} Renamed For History`
		let app: ElectronApplication | undefined

		server.enqueueResponses("openai-compatible-chat", {
			type: "tool",
			id: "call_profile_rename_history_initial",
			name: "attempt_completion",
			arguments: { result: "E2E_PROFILE_RENAME_HISTORY_INITIAL_DONE" },
			expectedRequestIncludes: [taskText],
		})

		try {
			const initialProfile = (await readProfiles(dlineDir)).find((profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAi)
			if (!initialProfile) throw new Error("The initial OpenAI E2E Profile is missing")

			app = await openVSCode(workspaceDir)
			let page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			let sidebar = await helper.getSidebar(page)
			await helper.signin(sidebar)

			const input = sidebar.getByTestId("chat-input")
			await input.fill(taskText)
			await sidebar.getByTestId("send-button").click()
			await expect(sidebar.getByText("E2E_PROFILE_RENAME_HISTORY_INITIAL_DONE", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(1)

			const taskId = await onlyTaskId(dlineDocsDir)
			await expect
				.poll(async () => readTaskSettings(dlineDocsDir, taskId), { timeout: 30_000 })
				.toMatchObject({
					actModeProfileId: initialProfile.id,
					actModeProfile: initialProfile.name,
				})

			await openApiSettings(page, sidebar)
			await sidebar.getByRole("button", { name: "Manage profiles" }).click()
			await expect(sidebar.getByRole("button", { name: "Done managing profiles" })).toBeVisible()
			const profileNameInput = sidebar.locator(`input[value=${JSON.stringify(initialProfile.name)}]`)
			await expect(profileNameInput).toHaveCount(1)
			await profileNameInput.fill(renamedProfileName)
			await profileNameInput.blur()
			await waitForProfileName(dlineDir, initialProfile.id, renamedProfileName)
			await expect(sidebar.locator(`input[value=${JSON.stringify(initialProfile.name)}]`)).toHaveCount(0)
			await expect(sidebar.locator(`input[value=${JSON.stringify(renamedProfileName)}]`)).toHaveCount(1)
			await sidebar.getByRole("button", { name: "Done managing profiles" }).click()
			await sidebar.getByRole("button", { name: "Done", exact: true }).click()

			const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
			await expect(modelSwitcher).toHaveText(renamedProfileName, { timeout: 30_000 })
			await expect
				.poll(async () => readTaskSettings(dlineDocsDir, taskId), { timeout: 30_000 })
				.toMatchObject({
					actModeProfileId: initialProfile.id,
					actModeProfile: renamedProfileName,
				})

			await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
			await app.close()
			app = undefined
			helper.clearCachedFrame()

			// Simulate a task created by an older version: it retains only the
			// pre-rename Profile name and has no stable Profile ID.
			const persistedTaskSettings = await E2ETestHelper.waitForValue(
				async () => readTaskSettings(dlineDocsDir, taskId),
				30_000,
			)
			if (!persistedTaskSettings) throw new Error("Task settings were not persisted before legacy migration")
			const legacyTaskSettings = { ...persistedTaskSettings }
			delete legacyTaskSettings.actModeProfileId
			delete legacyTaskSettings.planModeProfileId
			legacyTaskSettings.actModeProfile = initialProfile.name
			legacyTaskSettings.planModeProfile = initialProfile.name
			await writeFile(
				path.join(dlineDocsDir, "tasks", taskId, "settings.json"),
				`${JSON.stringify(legacyTaskSettings, null, 2)}\n`,
				"utf8",
			)
			await expect
				.poll(async () => readTaskSettings(dlineDocsDir, taskId), { timeout: 30_000 })
				.toMatchObject({
					actModeProfile: initialProfile.name,
					planModeProfile: initialProfile.name,
				})
			expect((await readTaskSettings(dlineDocsDir, taskId))?.actModeProfileId).toBeUndefined()
			expect((await readProfiles(dlineDir)).some((profile) => profile.name === initialProfile.name)).toBe(false)
			expect((await readProfiles(dlineDir)).some((profile) => profile.name === renamedProfileName)).toBe(true)

			// Remove the global stable-ID fallback as well. This keeps the fixture
			// faithful to a legacy installation that stored Profile names only.
			const globalSettings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
			delete globalSettings.actModeProfileId
			delete globalSettings.planModeProfileId
			globalSettings.actModeProfile = initialProfile.name
			globalSettings.planModeProfile = initialProfile.name
			await writeFile(settingsPath(dlineDir), `${JSON.stringify(globalSettings, null, 2)}\n`, "utf8")
			const globalState = JSON.parse(await readFile(globalStatePath(dlineDir), "utf8")) as Record<string, unknown>
			delete globalState.actModeProfileId
			delete globalState.planModeProfileId
			globalState.actModeProfile = initialProfile.name
			globalState.planModeProfile = initialProfile.name
			await writeFile(globalStatePath(dlineDir), `${JSON.stringify(globalState, null, 2)}\n`, "utf8")

			server.enqueueResponses("openai-compatible-chat", {
				type: "tool",
				id: "call_profile_rename_history_resumed",
				name: "attempt_completion",
				arguments: { result: "E2E_PROFILE_RENAME_HISTORY_RESUMED_DONE" },
				expectedRequestIncludes: [followUpText],
			})

			app = await openVSCode(workspaceDir)
			page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			sidebar = await helper.getSidebar(page)
			await helper.signin(sidebar)
			await page.getByRole("button", { name: "History", exact: true }).click()
			await E2ETestHelper.dismissWhatsNewModal(sidebar)

			const historyItem = sidebar.locator(".history-item").filter({ hasText: taskText })
			await expect(historyItem).toHaveCount(1)
			await historyItem.click()
			await expect(sidebar.getByText(taskText, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
			await expect(sidebar.getByRole("button", { name: "Select model" })).toHaveText(renamedProfileName, {
				timeout: 30_000,
			})
			await expect(sidebar.getByTestId("chat-input")).toBeEnabled()
			await expect
				.poll(async () => readTaskSettings(dlineDocsDir, taskId), { timeout: 30_000 })
				.toMatchObject({
					actModeProfileId: initialProfile.id,
					actModeProfile: renamedProfileName,
				})

			const reopenedInput = sidebar.getByTestId("chat-input")
			await reopenedInput.fill(followUpText)
			await reopenedInput.press("Enter")
			await expect(sidebar.getByText("E2E_PROFILE_RENAME_HISTORY_RESUMED_DONE", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(2)

			const resumedRequest = server.getMockConsumptions("openai-compatible-chat")[1]
			expect(resumedRequest.requestBody).toMatchObject({ model: "dline-e2e-model" })
			expect(JSON.stringify(resumedRequest.requestBody)).toContain(followUpText)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)

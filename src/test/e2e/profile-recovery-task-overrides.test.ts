import { readdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { expect, type Frame } from "@playwright/test"
import type { ElectronApplication } from "playwright"
import { E2E_PROFILE_NAMES } from "./utils/api-profile"
import { E2ETestHelper, e2e } from "./utils/helpers"

interface StoredProfile {
	id: string
	name: string
	webToolsMode?: "WEB_TOOLS_MODE_FORCE_OFF"
	modelInfo?: {
		capabilities?: {
			supportsReasoning?: boolean
			thinking?: {
				supported?: boolean
				mode?: string
				effortLevels?: string[]
				maxBudget?: number
			}
		}
	}
	openai?: {
		serviceTier?: string
		serviceTierEnabled?: boolean
		reasoning?: {
			enableThinking?: boolean
			effort?: string
			thinkingBudget?: number
		}
		capabilities?: {
			supportsReasoning?: boolean
		}
	}
}

interface StoredTaskSettings {
	planModeProfileId?: string
	planModeProfile?: string
	planModeReasoningOverrideKind?: string
	planModeReasoningOverrideEffort?: string
	planModeThinkingBudgetTokens?: number
	planModeReasoningEffort?: string
	planModeServiceTierOverrideKind?: string
	planModeServiceTierOverrideTier?: string
	actModeProfileId?: string
	actModeProfile?: string
	actModeReasoningOverrideKind?: string
	actModeReasoningOverrideEffort?: string
	actModeThinkingBudgetTokens?: number
	actModeReasoningEffort?: string
	actModeServiceTierOverrideKind?: string
	actModeServiceTierOverrideTier?: string
}

const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

async function configureRecoveryProfileCapabilities(dlineDir: string): Promise<void> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const recoveryProfiles = [E2E_PROFILE_NAMES.mockOpenAiResponses, E2E_PROFILE_NAMES.mockOpenAiOfficialResponses].map(
		(profileName) => profiles.find((profile) => profile.name === profileName),
	)
	if (recoveryProfiles.some((profile) => !profile?.openai)) {
		throw new Error("Missing configurable OpenAI recovery Profiles")
	}
	const thinking = {
		supported: true,
		mode: "effort",
		effortLevels: ["none", "low", "medium", "high"],
	}
	for (const profile of recoveryProfiles) {
		if (!profile?.openai) continue
		profile.openai.capabilities = {
			...(profile.openai.capabilities ?? {}),
			supportsReasoning: true,
		}
		profile.openai.serviceTierEnabled = true
		profile.modelInfo = {
			...(profile.modelInfo ?? {}),
			capabilities: {
				...(profile.modelInfo?.capabilities ?? {}),
				supportsReasoning: true,
				thinking,
			},
		}
	}
	await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")
}

async function configureProfileSwitchDefaults(dlineDir: string): Promise<StoredProfile> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const sourceProfile = profiles.find((profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAi)
	const targetProfile = profiles.find((profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	if (!sourceProfile?.openai?.capabilities || !targetProfile?.openai?.capabilities) {
		throw new Error("Missing configurable OpenAI E2E profiles")
	}
	const thinking = {
		supported: true,
		mode: "effort",
		effortLevels: ["none", "low", "medium", "high"],
	}
	for (const profile of [sourceProfile, targetProfile]) {
		profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
		profile.openai.capabilities.supportsReasoning = true
		profile.openai.serviceTierEnabled = true
		profile.modelInfo = {
			...(profile.modelInfo ?? {}),
			capabilities: {
				...(profile.modelInfo?.capabilities ?? {}),
				supportsReasoning: true,
				thinking,
			},
		}
	}
	targetProfile.openai.reasoning = { enableThinking: true, effort: "high", thinkingBudget: 0 }
	targetProfile.openai.serviceTier = "flex"

	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
	await Promise.all([
		writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8"),
		writeFile(
			settingsPath(dlineDir),
			`${JSON.stringify(
				{
					...settings,
					planActSeparateModelsSetting: true,
					planModeProfileId: sourceProfile.id,
					planModeProfile: sourceProfile.name,
					actModeProfileId: sourceProfile.id,
					actModeProfile: sourceProfile.name,
				},
				null,
				2,
			)}\n`,
			"utf8",
		),
	])
	return JSON.parse(JSON.stringify(targetProfile)) as StoredProfile
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

async function selectThinkingOverride(sidebar: Frame, optionName: string): Promise<void> {
	const control = sidebar.getByRole("combobox", { name: "Task thinking override" })
	await expect(control).toBeVisible()
	await expect(control).toBeEnabled()
	await control.click()
	await expect(sidebar.getByRole("option", { name: "Profile", exact: true })).toHaveCount(0)
	await sidebar.getByRole("option", { name: optionName, exact: true }).click()
}

async function selectServiceTier(sidebar: Frame, optionName: string): Promise<void> {
	const control = sidebar.getByRole("button", { name: "Task service tier" })
	await expect(control).toBeVisible()
	await expect(control).toBeEnabled()
	await control.click()
	await expect(sidebar.getByRole("listbox", { name: "Task service tier options" })).toBeVisible()
	await expect(sidebar.getByRole("option", { name: "Profile", exact: true })).toHaveCount(0)
	await sidebar.getByRole("option", { name: optionName, exact: true }).click()
}

function activeRuntimeOverrideState(settings: StoredTaskSettings) {
	return {
		reasoningKind: settings.actModeReasoningOverrideKind,
		reasoningEffort: settings.actModeReasoningOverrideEffort,
		thinkingBudget: settings.actModeThinkingBudgetTokens,
		legacyReasoningEffort: settings.actModeReasoningEffort,
		serviceTierKind: settings.actModeServiceTierOverrideKind,
		serviceTier: settings.actModeServiceTierOverrideTier,
	}
}

e2e(
	"Profile switch clears Task runtime overrides and reopened history uses the target Profile defaults",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }, testInfo) => {
		e2e.setTimeout(240_000)
		const targetProfileBefore = await configureProfileSwitchDefaults(dlineDir)
		server.enqueueResponses("openai-compatible-chat", {
			type: "tool",
			name: "qna_respond",
			arguments: { response: "E2E_PROFILE_OVERRIDE_SWITCH_READY" },
			expectedRequestIncludes: ["E2E_PROFILE_OVERRIDE_SWITCH_TASK"],
		})
		server.enqueueResponses("openai-compatible-responses", {
			type: "tool",
			name: "attempt_completion",
			arguments: { result: "E2E_PROFILE_OVERRIDE_SWITCH_DONE" },
			expectedRequestIncludes: ["E2E_PROFILE_OVERRIDE_SWITCH_FEEDBACK"],
		})
		let app: ElectronApplication | undefined
		const taskText = "E2E_PROFILE_OVERRIDE_SWITCH_TASK"

		try {
			app = await openVSCode(workspaceDir)
			let page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			let sidebar = await helper.getSidebar(page)
			await helper.signin(sidebar)

			const input = sidebar.getByTestId("chat-input")
			await input.fill(taskText)
			await sidebar.getByTestId("send-button").click()
			await expect(sidebar.getByText("E2E_PROFILE_OVERRIDE_SWITCH_READY", { exact: true })).toBeVisible({ timeout: 60_000 })
			await selectThinkingOverride(sidebar, "Low")
			await selectServiceTier(sidebar, "Priority")

			const taskId = await onlyTaskId(dlineDocsDir)
			await expect
				.poll(async () => activeRuntimeOverrideState(await readTaskSettings(dlineDocsDir, taskId)), { timeout: 30_000 })
				.toEqual({
					reasoningKind: "effort",
					reasoningEffort: "low",
					thinkingBudget: undefined,
					legacyReasoningEffort: undefined,
					serviceTierKind: "tier",
					serviceTier: "priority",
				})

			await selectProfile(sidebar, E2E_PROFILE_NAMES.mockOpenAiResponses)
			await expect(sidebar.getByRole("combobox", { name: "Task thinking override" })).toContainText("High")
			await expect(sidebar.getByRole("button", { name: "Task service tier" })).toHaveAttribute(
				"data-service-tier-label",
				"Flex",
			)
			await expect
				.poll(
					async () => {
						const settings = await readTaskSettings(dlineDocsDir, taskId)
						return {
							profileId: settings.actModeProfileId,
							profileName: settings.actModeProfile,
							...activeRuntimeOverrideState(settings),
						}
					},
					{ timeout: 30_000 },
				)
				.toEqual({
					profileId: targetProfileBefore.id,
					profileName: targetProfileBefore.name,
					reasoningKind: undefined,
					reasoningEffort: undefined,
					thinkingBudget: undefined,
					legacyReasoningEffort: undefined,
					serviceTierKind: undefined,
					serviceTier: undefined,
				})

			const currentScreenshot = testInfo.outputPath("profile-switch-cleared-current-task.png")
			await page.screenshot({ path: currentScreenshot })
			await testInfo.attach("profile-switch-cleared-current-task", { path: currentScreenshot, contentType: "image/png" })
			await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
			await app.close()
			app = undefined
			helper.clearCachedFrame()

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
			await expect(sidebar.getByRole("button", { name: "Select model" })).toHaveText(targetProfileBefore.name)
			await expect(sidebar.getByRole("combobox", { name: "Task thinking override" })).toContainText("High")
			await expect(sidebar.getByRole("button", { name: "Task service tier" })).toHaveAttribute(
				"data-service-tier-label",
				"Flex",
			)
			const reopenedScreenshot = testInfo.outputPath("profile-switch-cleared-reopened-task.png")
			await page.screenshot({ path: reopenedScreenshot })
			await testInfo.attach("profile-switch-cleared-reopened-task", { path: reopenedScreenshot, contentType: "image/png" })

			const reopenedInput = sidebar.getByTestId("chat-input")
			await expect(reopenedInput).toBeEnabled()
			await reopenedInput.fill("E2E_PROFILE_OVERRIDE_SWITCH_FEEDBACK")
			await reopenedInput.press("Enter")
			await expect(sidebar.getByText("E2E_PROFILE_OVERRIDE_SWITCH_DONE", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(1)
			const targetRequest = server.getMockConsumptions("openai-compatible-responses")[0]
			expect(targetRequest.thinking).toEqual({ mode: "effort", effort: "high" })
			expect(targetRequest.requestBody).toMatchObject({ service_tier: "flex" })

			const persistedProfiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
			const targetProfileAfter = persistedProfiles.find((profile) => profile.id === targetProfileBefore.id)
			expect(targetProfileAfter).toMatchObject(targetProfileBefore)
			const evidence = [
				{
					fileName: "profile-switch-task-settings.json",
					content: JSON.stringify(await readTaskSettings(dlineDocsDir, taskId), null, 2),
					contentType: "application/json",
				},
				{
					fileName: "profile-switch-profile-catalog.json",
					content: JSON.stringify({ before: targetProfileBefore, after: targetProfileAfter }, null, 2),
					contentType: "application/json",
				},
				{
					fileName: "profile-switch-target-request.json",
					content: JSON.stringify(targetRequest, null, 2),
					contentType: "application/json",
				},
				{
					fileName: "profile-switch-dline-output.log",
					content: await E2ETestHelper.readDlineOutput(userDataDir),
					contentType: "text/plain",
				},
			] as const
			for (const item of evidence) {
				const evidencePath = testInfo.outputPath(item.fileName)
				await writeFile(evidencePath, item.content, "utf8")
				await testInfo.attach(item.fileName, { path: evidencePath, contentType: item.contentType })
			}
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)

e2e(
	"Profile recovery clears the stale error and restores Task-local Thinking and Service Tier",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		await configureRecoveryProfileCapabilities(dlineDir)
		const profileError = `Profile not valid: "${E2E_PROFILE_NAMES.mockOpenAi}" is unavailable.`
		server.enqueueResponses("openai-compatible-chat", {
			type: "error",
			status: 403,
			code: "e2e_profile_not_valid",
			message: profileError,
		})
		let app: ElectronApplication | undefined
		const taskText = "E2E_PROFILE_RECOVERY_TASK"

		try {
			app = await openVSCode(workspaceDir)
			let page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			let sidebar = await helper.getSidebar(page)
			await helper.signin(sidebar)

			const input = sidebar.getByTestId("chat-input")
			await input.fill(taskText)
			await sidebar.getByTestId("send-button").click()
			await expect(sidebar.getByText(taskText, { exact: true }).first()).toBeVisible()
			await expect(sidebar.getByText(profileError, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(1)
			await expect(sidebar.locator('vscode-button[aria-label="Retry"]')).toBeVisible()

			await selectProfile(sidebar, E2E_PROFILE_NAMES.mockOpenAiResponses)
			await expect(sidebar.getByText(/Profile not valid:/)).toHaveCount(0)
			await expect(input).toBeEnabled()

			const profileSlot = sidebar.locator('[data-chat-input-slot="profile"]')
			const thinkingControl = sidebar.getByRole("combobox", { name: "Task thinking override" })
			const serviceTierControl = sidebar.getByRole("button", { name: "Task service tier" })
			await expect(profileSlot).toBeVisible()
			await expect(thinkingControl).toBeVisible()
			await expect(serviceTierControl).toBeVisible()
			const profileLayout = await profileSlot.evaluate((element) => {
				const style = getComputedStyle(element)
				return {
					flexShrink: style.flexShrink,
					maxWidth: Number.parseFloat(style.maxWidth),
					overflowX: style.overflowX,
					width: element.getBoundingClientRect().width,
				}
			})
			expect(profileLayout.flexShrink).toBe("1")
			expect(profileLayout.overflowX).toBe("hidden")
			expect(profileLayout.maxWidth).toBeGreaterThan(0)
			expect(profileLayout.width).toBeLessThanOrEqual(profileLayout.maxWidth + 1)
			const thinkingAppearance = await thinkingControl.evaluate((element) => ({
				borderTopWidth: getComputedStyle(element).borderTopWidth,
				svgCount: element.querySelectorAll("svg").length,
			}))
			expect(thinkingAppearance).toEqual({ borderTopWidth: "0px", svgCount: 0 })
			await expect(thinkingControl).toContainText("High")
			await expect(thinkingControl).not.toContainText("Default")
			await expect(serviceTierControl).toHaveAttribute("data-icon-only", "true")
			await expect(serviceTierControl).toHaveAttribute("data-service-tier-label", "No Task override")
			await expect(serviceTierControl).toHaveText("")
			await expect(serviceTierControl.locator("svg")).toHaveCount(1)
			await expect(sidebar.getByTestId("task-service-tier-icon")).toBeVisible()
			await selectThinkingOverride(sidebar, "Low")
			await selectServiceTier(sidebar, "Priority")

			const taskId = await onlyTaskId(dlineDocsDir)
			await expect
				.poll(async () => readTaskSettings(dlineDocsDir, taskId), { timeout: 30_000 })
				.toMatchObject({
					actModeReasoningOverrideKind: "effort",
					actModeReasoningOverrideEffort: "low",
					actModeServiceTierOverrideKind: "tier",
					actModeServiceTierOverrideTier: "priority",
				})

			const persistedProfiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
			const persistedRecoveryProfile = persistedProfiles.find(
				(profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAiResponses,
			)
			expect(persistedRecoveryProfile?.openai?.reasoning?.effort).toBe("high")
			expect(persistedRecoveryProfile?.openai?.serviceTier).toBeUndefined()

			await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
			await expect(input).toHaveAttribute("placeholder", "Type your task here...")
			await expect(sidebar.getByRole("combobox", { name: "Task thinking override" })).toHaveCount(0)
			await expect(sidebar.getByRole("button", { name: "Task service tier" })).toHaveCount(0)

			await app.close()
			app = undefined
			helper.clearCachedFrame()
			const taskSettingsPath = path.join(dlineDocsDir, "tasks", taskId, "settings.json")
			const staleNameSettings = await readTaskSettings(dlineDocsDir, taskId)
			await writeFile(
				taskSettingsPath,
				`${JSON.stringify({ ...staleNameSettings, actModeProfile: "stale-profile-name" }, null, 2)}\n`,
				"utf8",
			)

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
			await expect(sidebar.locator('[data-chat-input-slot="profile"]')).toBeVisible()
			await expect(sidebar.getByRole("button", { name: "Select model" })).toHaveText(E2E_PROFILE_NAMES.mockOpenAiResponses)
			await expect(sidebar.getByRole("combobox", { name: "Task thinking override" })).toContainText("Low")
			await expect(sidebar.getByRole("button", { name: "Task service tier" })).toHaveAttribute(
				"data-service-tier-label",
				"Priority",
			)
			await expect(sidebar.getByTestId("task-service-tier-icon")).toBeVisible()
			await expect(sidebar.getByText(/Profile not valid:/)).toHaveCount(0)
			await expect(sidebar.getByRole("combobox", { name: "Task thinking override" })).toBeEnabled()
			await expect(sidebar.getByRole("button", { name: "Task service tier" })).toBeEnabled()

			const persistedProfilesBeforeResumeSwitch = JSON.parse(
				await readFile(profilesPath(dlineDir), "utf8"),
			) as StoredProfile[]
			const recoveryTargetProfile = persistedProfilesBeforeResumeSwitch.find(
				(profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAiOfficialResponses,
			)
			expect(recoveryTargetProfile).toBeDefined()
			await selectProfile(sidebar, E2E_PROFILE_NAMES.mockOpenAiOfficialResponses)
			await expect(sidebar.getByRole("button", { name: "Select model" })).toHaveText(
				E2E_PROFILE_NAMES.mockOpenAiOfficialResponses,
			)
			await expect
				.poll(async () => readTaskSettings(dlineDocsDir, taskId), { timeout: 30_000 })
				.toMatchObject({
					actModeProfileId: recoveryTargetProfile?.id,
					actModeProfile: E2E_PROFILE_NAMES.mockOpenAiOfficialResponses,
				})

			await selectThinkingOverride(sidebar, "Medium")
			await selectServiceTier(sidebar, "Flex")
			await expect
				.poll(async () => readTaskSettings(dlineDocsDir, taskId), { timeout: 30_000 })
				.toMatchObject({
					actModeProfileId: recoveryTargetProfile?.id,
					actModeProfile: E2E_PROFILE_NAMES.mockOpenAiOfficialResponses,
					actModeReasoningOverrideKind: "effort",
					actModeReasoningOverrideEffort: "medium",
					actModeServiceTierOverrideKind: "tier",
					actModeServiceTierOverrideTier: "flex",
				})

			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/Profile not valid:/, /e2e_profile_not_valid/])
		} finally {
			await app?.close()
		}
	},
)

import { readdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { expect, type Frame } from "@playwright/test"
import type { ElectronApplication } from "playwright"
import { E2E_PROFILE_NAMES } from "./utils/api-profile"
import { E2ETestHelper, e2e } from "./utils/helpers"

interface StoredProfile {
	id: string
	name: string
}

interface StoredTaskSettings {
	planModeProfileId?: string
	planModeProfile?: string
	actModeProfileId?: string
	actModeProfile?: string
}

interface StoredSnapshot {
	phase?: string
	apiIndex?: number
	interaction?: {
		interactionId?: string
		kind?: string
		status?: string
	}
	cancellation?: unknown
}

const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

async function configureUnifiedSourceProfile(
	dlineDir: string,
): Promise<{ sourceProfile: StoredProfile; targetProfile: StoredProfile }> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const sourceProfile = profiles.find((profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAi)
	const targetProfile = profiles.find((profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	if (!sourceProfile || !targetProfile) throw new Error("Missing OpenAI E2E Profiles for error recovery switch")

	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
	await writeFile(
		settingsPath(dlineDir),
		`${JSON.stringify(
			{
				...settings,
				planActSeparateModelsSetting: false,
				planModeProfileId: sourceProfile.id,
				planModeProfile: sourceProfile.name,
				actModeProfileId: sourceProfile.id,
				actModeProfile: sourceProfile.name,
			},
			null,
			2,
		)}\n`,
		"utf8",
	)
	return { sourceProfile, targetProfile }
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

async function readSnapshot(dlineDocsDir: string, taskId: string): Promise<StoredSnapshot> {
	return JSON.parse(await readFile(path.join(dlineDocsDir, "tasks", taskId, "snapshot.json"), "utf8")) as StoredSnapshot
}

async function selectProfile(sidebar: Frame, profileName: string): Promise<void> {
	const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
	await modelSwitcher.click()
	await expect(sidebar.getByText("Available Models", { exact: true })).toBeVisible()
	const option = sidebar.getByRole("option").filter({ has: sidebar.getByText(profileName, { exact: true }) })
	await expect(option).toHaveCount(1)
	await option.click()
	await expect(modelSwitcher).toHaveText(profileName, { timeout: 30_000 })
}

async function reopenTask(page: Awaited<ReturnType<ElectronApplication["firstWindow"]>>, sidebar: Frame, taskText: string) {
	await page.getByRole("button", { name: "History", exact: true }).click()
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	const historyItem = sidebar.locator(".history-item").filter({ hasText: taskText })
	await expect(historyItem).toHaveCount(1)
	await historyItem.click()
}

e2e(
	"Profile switch survives HTTP 429 retry interruption and History Resume routes through the target Profile",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }, testInfo) => {
		e2e.setTimeout(300_000)
		const { sourceProfile, targetProfile } = await configureUnifiedSourceProfile(dlineDir)
		const taskText = "E2E_PROFILE_SWITCH_429_TASK"
		const rateLimitMarker = "E2E_PROFILE_SWITCH_429_RATE_LIMIT"
		const retryDraft = "E2E_PROFILE_SWITCH_429_RETRY_DRAFT"
		const resumeDraft = "E2E_PROFILE_SWITCH_429_RESUME_DRAFT"
		const completion = "E2E_PROFILE_SWITCH_429_TARGET_OK"
		const expectedFailureRequestCount = 4
		server.enqueueResponses(
			"openai-compatible-chat",
			...Array.from({ length: 24 }, () => ({
				type: "error" as const,
				status: 429,
				code: "e2e_profile_switch_429",
				message: rateLimitMarker,
			})),
		)

		let app: ElectronApplication | undefined
		try {
			app = await openVSCode(workspaceDir)
			const page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await helper.signin(sidebar)

			const input = sidebar.getByTestId("chat-input")
			await input.fill(taskText)
			await sidebar.getByTestId("send-button").click()
			const retryButton = sidebar.locator('vscode-button[aria-label="Retry"]')
			await expect(retryButton).toBeVisible({ timeout: 120_000 })
			await expect
				.poll(() => server.getRequestCount("openai-compatible-chat"), { timeout: 120_000 })
				.toBe(expectedFailureRequestCount)
			expect(server.getMockConsumptions("openai-compatible-chat").every((entry) => entry.status === 429)).toBe(true)

			const taskId = await onlyTaskId(dlineDocsDir)
			await selectProfile(sidebar, targetProfile.name)
			await expect(retryButton).toBeVisible()
			await expect(input).toBeEnabled()
			await expect
				.poll(async () => readTaskSettings(dlineDocsDir, taskId), { timeout: 30_000 })
				.toMatchObject({
					planModeProfileId: targetProfile.id,
					planModeProfile: targetProfile.name,
					actModeProfileId: targetProfile.id,
					actModeProfile: targetProfile.name,
				})

			server.clearPendingResponses("openai-compatible-chat")
			server.enqueueResponses("openai-compatible-responses", {
				type: "tool",
				name: "attempt_completion",
				arguments: { result: "E2E_PROFILE_SWITCH_429_INTERRUPTED_RESPONSE_MUST_NOT_RENDER" },
				expectedRequestIncludes: [retryDraft],
				delayMs: 30_000,
			})
			await input.fill(retryDraft)
			await retryButton.click()
			await expect(input).toHaveValue("")
			await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 60_000 }).toBe(1)

			await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
			await expect
				.poll(() => server.getMockConsumptions("openai-compatible-responses")[0]?.abortedAtMs, { timeout: 30_000 })
				.not.toBeUndefined()

			await reopenTask(page, sidebar, taskText)
			await expect(sidebar.getByRole("button", { name: "Select model" })).toHaveText(targetProfile.name)
			await expect(
				sidebar.getByText("E2E_PROFILE_SWITCH_429_INTERRUPTED_RESPONSE_MUST_NOT_RENDER", { exact: false }),
			).toHaveCount(0)
			const resumeButton = sidebar.getByRole("contentinfo").getByText("Resume", { exact: true })
			await expect(resumeButton).toBeVisible({ timeout: 30_000 })
			await expect
				.poll(async () => readSnapshot(dlineDocsDir, taskId), { timeout: 30_000 })
				.toMatchObject({
					phase: "paused",
					interaction: { kind: "resume", status: "awaiting" },
				})

			server.enqueueResponses("openai-compatible-responses", {
				type: "tool",
				name: "attempt_completion",
				arguments: { result: completion },
				expectedRequestIncludes: [resumeDraft],
			})
			await input.fill(resumeDraft)
			await resumeButton.click()
			await expect(input).toHaveValue("")
			await expect(sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(2)
			expect(server.getRequestCount("openai-compatible-chat")).toBe(expectedFailureRequestCount)
			const targetConsumptions = server.getMockConsumptions("openai-compatible-responses")
			expect(targetConsumptions).toHaveLength(2)
			expect(targetConsumptions[0]).toMatchObject({ protocol: "openai-responses", abortedAtMs: expect.any(Number) })
			expect(targetConsumptions[1]).toMatchObject({
				protocol: "openai-responses",
				responseType: "tool",
				toolName: "attempt_completion",
			})
			await expect
				.poll(async () => readTaskSettings(dlineDocsDir, taskId), { timeout: 30_000 })
				.toMatchObject({
					planModeProfileId: targetProfile.id,
					planModeProfile: targetProfile.name,
					actModeProfileId: targetProfile.id,
					actModeProfile: targetProfile.name,
				})

			const evidence = [
				{
					name: "profile-switch-429-task-settings.json",
					content: JSON.stringify(await readTaskSettings(dlineDocsDir, taskId), null, 2),
					contentType: "application/json",
				},
				{
					name: "profile-switch-429-snapshot.json",
					content: JSON.stringify(await readSnapshot(dlineDocsDir, taskId), null, 2),
					contentType: "application/json",
				},
				{
					name: "profile-switch-429-consumptions.json",
					content: JSON.stringify(
						{
							sourceProfile,
							targetProfile,
							chat: server.getMockConsumptions("openai-compatible-chat"),
							responses: targetConsumptions,
						},
						null,
						2,
					),
					contentType: "application/json",
				},
				{
					name: "profile-switch-429-dline-output.log",
					content: await E2ETestHelper.readDlineOutput(userDataDir),
					contentType: "text/plain",
				},
			] as const
			for (const item of evidence) {
				const evidencePath = testInfo.outputPath(item.name)
				await writeFile(evidencePath, item.content, "utf8")
				await testInfo.attach(item.name, { path: evidencePath, contentType: item.contentType })
			}
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [
				new RegExp(rateLimitMarker),
				/Dline instance aborted/,
			])
		} finally {
			await app?.close()
		}
	},
)

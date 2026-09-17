import { readdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

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

interface SnapshotTurnBlock {
	dlineTid?: string
	toolName?: string
}

interface StoredSnapshot {
	phase?: string
	interaction?: {
		interactionId?: string
		kind?: string
		status?: string
	}
	turn?: {
		turnId?: string
		blocks?: SnapshotTurnBlock[]
	}
}

const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

/** Bind both modes to the Chat mock so one selection replaces the whole Task-local binding. */
async function configureUnifiedSourceProfile(
	dlineDir: string,
): Promise<{ sourceProfile: StoredProfile; targetProfile: StoredProfile }> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const sourceProfile = profiles.find((profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAi)
	const targetProfile = profiles.find((profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	if (!sourceProfile || !targetProfile) throw new Error("Missing OpenAI E2E Profiles for error-retry switch")

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

/**
 * A Task that already executed tool calls owns a turn whose blocks carry
 * `dline_tid_*` identities. The later `error_retry` interaction uses a synthesized
 * `retry:<taskId>:<revision>` identity that can never appear among those blocks,
 * so any Profile preflight that requires a matching lifecycle block always fails.
 */
e2e(
	"Profile switch - a failed request after tool calls still adopts the target Profile",
	async ({ dlineDir, dlineDocsDir, helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(240_000)
		const { targetProfile } = await configureUnifiedSourceProfile(dlineDir)
		const taskText = "E2E_PROFILE_SWITCH_ERROR_RETRY_TASK"
		const failureMarker = "E2E_PROFILE_SWITCH_ERROR_RETRY_FAILURE"

		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueResponses(
			"openai-compatible-chat",
			// The first response performs a real tool call so the persisted turn owns
			// blocks keyed by `dline_tid_*` identities.
			{
				type: "tool",
				name: "read_file",
				arguments: { path: "README.md" },
			},
			// Every later attempt fails, which drives the Task into an awaiting
			// `error_retry` interaction whose ID is not one of those block IDs.
			...Array.from({ length: 24 }, () => ({
				type: "error" as const,
				status: 429,
				code: "e2e_profile_switch_error_retry",
				message: failureMarker,
			})),
		)

		const input = sidebar.getByTestId("chat-input")
		await expect(input).toBeEnabled()
		await input.fill(taskText)
		await sidebar.getByTestId("send-button").click()

		const retryButton = sidebar.locator('vscode-button[aria-label="Retry"]')
		await expect(retryButton).toBeVisible({ timeout: 120_000 })

		const taskId = await onlyTaskId(dlineDocsDir)
		// Confirm the exact state that breaks the Profile preflight: an awaiting
		// error_retry interaction whose ID is absent from the recorded turn blocks.
		const snapshot = await E2ETestHelper.waitForValue(async () => {
			const parsed = await readSnapshot(dlineDocsDir, taskId)
			return parsed.interaction?.kind === "error_retry" && parsed.interaction.status === "awaiting" ? parsed : undefined
		}, 30_000)
		const interactionId = snapshot.interaction?.interactionId
		expect(interactionId).toBeTruthy()
		expect(snapshot.turn?.blocks?.length ?? 0).toBeGreaterThan(0)
		expect(snapshot.turn?.blocks?.some((block) => block.dlineTid === interactionId)).toBe(false)

		// The Profile selector must adopt the target binding without any interception.
		await selectProfile(sidebar, targetProfile.name)
		await expect
			.poll(async () => readTaskSettings(dlineDocsDir, taskId), { timeout: 30_000 })
			.toMatchObject({
				planModeProfileId: targetProfile.id,
				planModeProfile: targetProfile.name,
				actModeProfileId: targetProfile.id,
				actModeProfile: targetProfile.name,
			})
		await expect(input).toBeEnabled()
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [
			new RegExp(failureMarker),
			/e2e_profile_switch_error_retry/,
		])
	},
)

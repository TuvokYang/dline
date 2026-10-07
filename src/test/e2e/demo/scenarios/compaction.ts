import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { expect, type Frame } from "@playwright/test"
import type { ClineApiServerMock } from "../../fixtures/server"
import { E2E_PROFILE_NAMES } from "../../utils/api-profile"
import { E2ETestHelper } from "../../utils/helpers"

/**
 * Automatic compaction scripted against the mock Responses provider.
 *
 * The first turn reports 125k input tokens on a 131k window, so the next user
 * message crosses the 60% trigger and runs one summarize pass before the reply.
 * Shared by the marketplace recording and the documentation recording.
 */
export const COMPACTION_TASK_TEXT = "Review the release checklist and keep the next action ready."
export const COMPACTION_READY_TEXT = "The release checklist is ready. The next action is preserved."
export const COMPACTION_CONTINUE_TEXT = "Continue with the next release check."
export const COMPACTION_SUMMARY_TEXT =
	"Context compacted automatically. Preserved: the release goal, completed checks, and the next action."
export const COMPACTION_COMPLETION_TEXT = "Context compacted. Continuing with the next release check."
export const COMPACT_INSTRUCTION_MARKER = "The current conversation is rapidly running out of context"
export const COMPACTION_CONTEXT_WINDOW = 131_072

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

async function readJsonWhenPresent<T>(filePath: string): Promise<T> {
	return E2ETestHelper.waitForValue(async () => {
		try {
			return JSON.parse(await readFile(filePath, "utf8")) as T
		} catch {
			return undefined
		}
	}, 15_000)
}

/** Point both modes at the Responses mock profile and enable an early auto-compaction trigger. */
export async function configureAutoCompaction(dlineDir: string): Promise<void> {
	const profilePath = path.join(dlineDir, "data", "settings", "api_profiles.json")
	const profiles = await readJsonWhenPresent<StoredProfile[]>(profilePath)
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	if (!profile?.openai?.capabilities) throw new Error("Missing configurable OpenAI Responses E2E profile")
	profile.modelId = "gpt-5.4-mini"
	profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	profile.openai.capabilities.contextWindow = COMPACTION_CONTEXT_WINDOW
	await writeFile(profilePath, `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

	const settingsPath = path.join(dlineDir, "data", "settings", "settings.json")
	const settings = await readJsonWhenPresent<Record<string, unknown>>(settingsPath)
	Object.assign(settings, {
		actModeProfile: profile.name,
		actModeProfileId: profile.id,
		planModeProfile: profile.name,
		planModeProfileId: profile.id,
		useAutoCondense: true,
		autoCondenseTriggerPercent: 60,
		autoCondenseMinReserveTokens: 10_000,
		autoCondenseMaxReserveTokens: 40_000,
		autoCondenseMaxContextTokens: 100_000,
		clineWebToolsEnabled: false,
	})
	await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

export async function selectProfile(sidebar: Frame, profileName: string): Promise<void> {
	const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
	await expect.poll(async () => (await modelSwitcher.innerText()).trim(), { timeout: 20_000 }).not.toContain("Loading profiles")
	if ((await modelSwitcher.innerText()).trim() === profileName) return

	await modelSwitcher.press("Enter")
	const profileOption = sidebar.getByRole("option").filter({ has: sidebar.getByText(profileName, { exact: true }) })
	await expect(profileOption).toHaveCount(1)
	await profileOption.press("Enter")
	await expect(modelSwitcher).toHaveText(profileName)
}

export function enqueueAutoCompaction(server: ClineApiServerMock): void {
	server.resetOpenAiMock()
	server.enqueueResponses(
		"openai-compatible-responses",
		{
			type: "tool",
			id: "call_r8_ready",
			name: "qna_respond",
			arguments: { response: COMPACTION_READY_TEXT },
			usage: { inputTokens: 125_000, outputTokens: 100 },
			expectedRequestIncludes: [COMPACTION_TASK_TEXT],
			matchRequestContract: true,
		},
		{
			type: "tool-with-completion-snapshots",
			id: "call_r8_summary",
			name: "summarize_task",
			arguments: { context: COMPACTION_SUMMARY_TEXT },
			toolArgumentChunkSize: 20,
			toolArgumentChunkDelayMs: 600,
			expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, COMPACTION_TASK_TEXT],
			expectedRequestExcludes: [COMPACTION_CONTINUE_TEXT],
			matchRequestContract: true,
		},
		{
			type: "tool",
			id: "call_r8_complete",
			name: "attempt_completion",
			arguments: { result: COMPACTION_COMPLETION_TEXT },
			delayMs: 2_000,
			usage: { inputTokens: 18_000, outputTokens: 120 },
			expectedRequestIncludes: [COMPACTION_SUMMARY_TEXT, COMPACTION_CONTINUE_TEXT],
			expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER],
			matchRequestContract: true,
		},
	)
}

export async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled({ timeout: 30_000 })
	await input.fill(text)
	await input.press("Enter")
	await expect(input).toHaveValue("")
}

/**
 * Run the first turn and expand the task header until the context bar reports
 * usage above the trigger, so the next message starts an automatic compaction.
 */
export async function primeContextNearLimit(sidebar: Frame): Promise<void> {
	await sendTask(sidebar, COMPACTION_TASK_TEXT)
	await expect(sidebar.getByText(COMPACTION_READY_TEXT, { exact: false }).last()).toBeVisible({ timeout: 60_000 })

	const taskHeaderToggle = sidebar.locator('[aria-label="Expand task header"], [aria-label="Collapse task header"]')
	await expect(taskHeaderToggle).toHaveCount(1)
	if ((await taskHeaderToggle.getAttribute("aria-label")) === "Expand task header") await taskHeaderToggle.click()
	const contextProgress = sidebar.getByTestId("context-window-segmented-progress")
	await expect(sidebar.getByTestId("context-window-indicator")).toBeVisible({ timeout: 30_000 })
	await expect(contextProgress).toHaveAttribute("data-context-window", String(COMPACTION_CONTEXT_WINDOW))
	await expect
		.poll(async () => Number((await contextProgress.getAttribute("aria-valuenow")) ?? 0), { timeout: 30_000 })
		.toBeGreaterThanOrEqual(120_000)
}

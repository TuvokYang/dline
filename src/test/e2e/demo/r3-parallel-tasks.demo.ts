import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { expect, type Frame, type Locator, type Page } from "@playwright/test"
import { E2E_PROFILE_NAMES } from "../utils/api-profile"
import { E2ETestHelper } from "../utils/helpers"
import { demo } from "./utils/demo-fixture"
import { dismissDemoNotifications } from "./utils/png-asset"
import { STEP_SETTLE_MS, WINDOW_RECORDING } from "./utils/recording-presets"

const SIDEBAR_TASK = "Review the workspace from the sidebar."
const LEFT_PANEL_TASK = "Plan the implementation from the first editor."
const RIGHT_PANEL_TASK = "Check delivery risks from the second editor."
const SIDEBAR_TURN = "Continue the sidebar review independently."
const LEFT_PANEL_TURN = "Continue the first editor plan independently."
const SIDEBAR_READY = "Sidebar task is ready."
const LEFT_PANEL_READY = "First editor task is ready."
const SIDEBAR_REASONING = "The sidebar task is reviewing the workspace."
const LEFT_PANEL_REASONING = "The first editor task is planning the implementation."
const RIGHT_PANEL_REASONING = "The second editor task is checking delivery risks."
const SIDEBAR_DONE = "Sidebar review complete."
const LEFT_PANEL_DONE = "Implementation plan complete."
const RIGHT_PANEL_DONE = "Risk review complete."
const SIDEBAR_STREAM_HOLD_MS = 10_000
const LEFT_PANEL_STREAM_HOLD_MS = 8_000
const RIGHT_PANEL_STREAM_HOLD_MS = 6_500
const REQUEST_OVERLAP_WINDOW_MS = RIGHT_PANEL_STREAM_HOLD_MS
const BETWEEN_SENDS_MS = 50
const R3_PROFILE_NAMES = [
	E2E_PROFILE_NAMES.mockDeepSeek,
	E2E_PROFILE_NAMES.mockOpenAiResponses,
	E2E_PROFILE_NAMES.mockOpenAiOfficialResponses,
] as const

interface StoredDemoProfile {
	id: string
	name: string
	webToolsMode?: "WEB_TOOLS_MODE_FORCE_OFF"
}

async function disableHostedWebTools(dlineDir: string): Promise<string> {
	const profilePath = path.join(dlineDir, "data", "settings", "api_profiles.json")
	const profiles = await E2ETestHelper.waitForValue(async () => {
		try {
			return JSON.parse(await readFile(profilePath, "utf8")) as StoredDemoProfile[]
		} catch {
			return undefined
		}
	}, 15_000)

	for (const profileName of R3_PROFILE_NAMES) {
		const profile = profiles.find((candidate) => candidate.name === profileName)
		if (!profile) throw new Error(`Missing R3 E2E profile: ${profileName}`)
		profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	}
	await writeFile(profilePath, `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

	const settingsPath = path.join(dlineDir, "data", "settings", "settings.json")
	const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>
	settings.clineWebToolsEnabled = false
	await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8")

	const rightProfile = profiles.find((profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAiOfficialResponses)
	if (!rightProfile) throw new Error(`Missing R3 E2E profile: ${E2E_PROFILE_NAMES.mockOpenAiOfficialResponses}`)
	return rightProfile.id
}

async function setDefaultProfileForNewTask(dlineDir: string, profileId: string): Promise<void> {
	const settingsPath = path.join(dlineDir, "data", "settings", "settings.json")
	const settings = await E2ETestHelper.waitForValue(async () => {
		try {
			return JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>
		} catch {
			return undefined
		}
	}, 15_000)
	settings.actModeProfile = E2E_PROFILE_NAMES.mockOpenAiOfficialResponses
	settings.actModeProfileId = profileId
	settings.planModeProfile = E2E_PROFILE_NAMES.mockOpenAiOfficialResponses
	settings.planModeProfileId = profileId
	await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

async function selectProfile(frame: Frame, profileName: string): Promise<void> {
	const modelSwitcher = frame.getByRole("button", { name: "Select model" })
	await expect.poll(async () => (await modelSwitcher.innerText()).trim(), { timeout: 20_000 }).not.toContain("Loading profiles")
	if ((await modelSwitcher.innerText()).trim() === profileName) return

	await modelSwitcher.press("Enter")
	const profileOption = frame.getByRole("option").filter({ has: frame.getByText(profileName, { exact: true }) })
	await expect(profileOption).toHaveCount(1)
	await profileOption.press("Enter")
	await expect(modelSwitcher).toHaveText(profileName)
}

async function findAdditionalDlineFrame(page: Page, existingFrames: ReadonlySet<Frame>): Promise<Frame> {
	let resolved: Frame | undefined
	await expect
		.poll(
			async () => {
				for (const frame of page.frames()) {
					if (existingFrames.has(frame) || frame.isDetached() || !frame.url().startsWith("vscode-webview://")) {
						continue
					}
					try {
						if ((await frame.locator("#root").count()) === 0) continue
					} catch {
						continue
					}
					resolved = frame
					return true
				}
				return false
			},
			{ timeout: 60_000 },
		)
		.toBe(true)
	if (!resolved) throw new Error("Dline editor panel frame was not created")
	return resolved
}

async function createDlinePanel(page: Page): Promise<Frame> {
	const existingFrames = new Set(page.frames())
	await page.getByRole("button", { name: "New Task", exact: true }).click()
	const panel = await findAdditionalDlineFrame(page, existingFrames)
	await E2ETestHelper.dismissWhatsNewModal(panel)
	await expect(panel.getByTestId("chat-input")).toBeVisible({ timeout: 60_000 })
	return panel
}

async function findActiveEditorTab(page: Page): Promise<Locator> {
	const groups = page.locator(".editor-group-container")
	const activeGroupIndex = await groups.evaluateAll((elements) =>
		elements.findIndex((element) => element.classList.contains("active")),
	)
	if (activeGroupIndex < 0) throw new Error("Active editor group was not found")

	const tabs = groups.nth(activeGroupIndex).locator(".tabs-container > .tab")
	const activeTabIndex = await tabs.evaluateAll((elements) =>
		elements.findIndex((element) => element.classList.contains("active")),
	)
	if (activeTabIndex < 0) throw new Error("Active Dline editor tab was not found")
	return tabs.nth(activeTabIndex)
}

async function prepareRightEditorGroup(page: Page): Promise<void> {
	const editorGroups = page.locator(".editor-group-container")
	const initialGroupCount = await editorGroups.count()
	const activeTab = await findActiveEditorTab(page)

	await activeTab.click()
	await page.keyboard.press("Control+\\")
	await expect(editorGroups).toHaveCount(initialGroupCount + 1)
	const rightGroup = editorGroups.nth(initialGroupCount)
	await expect(rightGroup.locator(".tabs-container > .tab")).toHaveCount(0)
}

async function moveActivePanelToRightGroup(page: Page): Promise<void> {
	const newTaskTab = page.locator('.tabs-container > .tab[aria-label^="Dline, Editor Group"]')
	await expect(newTaskTab).toHaveCount(1)
	await newTaskTab.click()
	await newTaskTab.click({ button: "right" })
	await page.getByRole("menuitem", { name: /Split & Move/i }).click()
	await page.getByRole("menuitem", { name: /^Move Right$/ }).click()
}

async function sendAndWait(frame: Frame, prompt: string, result: string): Promise<void> {
	const input = frame.getByTestId("chat-input")
	await expect(input).toBeEnabled({ timeout: 60_000 })
	await input.fill(prompt)
	await input.press("Enter")
	await expect(input).toHaveValue("")
	await expect(frame.getByText(result, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
}

async function sendPrompt(frame: Frame, prompt: string): Promise<void> {
	const input = frame.getByTestId("chat-input")
	await expect(input).toBeEnabled({ timeout: 60_000 })
	await input.fill(prompt)
	await frame.getByTestId("send-button").click()
	await expect(input).toHaveValue("")
}

async function waitForReasoning(frame: Frame, reasoning: string): Promise<void> {
	await expect(frame.getByText(reasoning, { exact: false }).last()).toBeVisible({ timeout: 30_000 })
}

demo(
	"R3",
	async ({ dlineDir, finishRecording, focusCamera, helper, pace, page, registerRecording, server, sidebar, userDataDir }) => {
		const rightProfileId = await disableHostedWebTools(dlineDir)
		await helper.signin(sidebar)

		await selectProfile(sidebar, E2E_PROFILE_NAMES.mockDeepSeek)
		server.resetOpenAiMock()
		server.enqueueResponses("deepseek-chat", {
			type: "tool",
			id: "call_r3_sidebar_ready",
			name: "qna_respond",
			arguments: { response: SIDEBAR_READY },
			expectedRequestIncludes: [SIDEBAR_TASK],
		})
		await sendAndWait(sidebar, SIDEBAR_TASK, SIDEBAR_READY)

		const leftPanel = await createDlinePanel(page)
		await selectProfile(leftPanel, E2E_PROFILE_NAMES.mockOpenAiResponses)
		server.enqueueResponses("openai-compatible-responses", {
			type: "tool",
			id: "call_r3_left_ready",
			name: "qna_respond",
			arguments: { response: LEFT_PANEL_READY },
			expectedRequestIncludes: [LEFT_PANEL_TASK],
		})
		await sendAndWait(leftPanel, LEFT_PANEL_TASK, LEFT_PANEL_READY)

		const sidebarProfile = sidebar.getByRole("button", { name: "Select model" })
		const leftProfile = leftPanel.getByRole("button", { name: "Select model" })
		await expect(sidebarProfile).toHaveText(E2E_PROFILE_NAMES.mockDeepSeek)
		await expect(leftProfile).toHaveText(E2E_PROFILE_NAMES.mockOpenAiResponses)

		await setDefaultProfileForNewTask(dlineDir, rightProfileId)
		await page.waitForTimeout(500)
		await prepareRightEditorGroup(page)

		server.resetOpenAiMock()
		server.enqueueResponses("deepseek-chat", {
			type: "tool",
			id: "call_r3_sidebar_done",
			name: "attempt_completion",
			reasoning: SIDEBAR_REASONING,
			afterReasoningDelayMs: SIDEBAR_STREAM_HOLD_MS,
			arguments: { result: SIDEBAR_DONE },
			usage: { inputTokens: 19_000, outputTokens: 40, cacheReadTokens: 19_000, reasoningTokens: 20 },
			expectedRequestIncludes: [SIDEBAR_TURN],
		})
		server.enqueueResponses("openai-compatible-responses", {
			type: "tool",
			id: "call_r3_left_done",
			name: "attempt_completion",
			reasoning: LEFT_PANEL_REASONING,
			afterReasoningDelayMs: LEFT_PANEL_STREAM_HOLD_MS,
			arguments: { result: LEFT_PANEL_DONE },
			usage: { inputTokens: 22_000, outputTokens: 44, cacheReadTokens: 21_000, reasoningTokens: 20 },
			expectedRequestIncludes: [LEFT_PANEL_TURN],
		})
		server.enqueueResponses("openai-official-responses", {
			type: "tool",
			id: "call_r3_right_done",
			name: "attempt_completion",
			reasoning: RIGHT_PANEL_REASONING,
			afterReasoningDelayMs: RIGHT_PANEL_STREAM_HOLD_MS,
			arguments: { result: RIGHT_PANEL_DONE },
			expectedRequestIncludes: [RIGHT_PANEL_TASK],
		})

		await dismissDemoNotifications(page)
		await registerRecording("r3-parallel-tasks", WINDOW_RECORDING)
		await focusCamera(page.getByRole("button", { name: "New Task", exact: true }), STEP_SETTLE_MS)
		const rightPanel = await createDlinePanel(page)
		await moveActivePanelToRightGroup(page)

		const rightProfile = rightPanel.getByRole("button", { name: "Select model" })
		await Promise.all([
			...([sidebar, leftPanel, rightPanel] as const).map((frame) =>
				expect(frame.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 }),
			),
			expect(sidebarProfile).toHaveText(E2E_PROFILE_NAMES.mockDeepSeek),
			expect(leftProfile).toHaveText(E2E_PROFILE_NAMES.mockOpenAiResponses),
			expect(rightProfile).toHaveText(E2E_PROFILE_NAMES.mockOpenAiOfficialResponses),
		])

		// Three independent tasks side by side: frame all of their model pickers and inputs at once.
		const taskInputs = [sidebar, leftPanel, rightPanel].map((frame) => frame.getByTestId("chat-input"))
		await focusCamera([...taskInputs, sidebarProfile, leftProfile, rightProfile], STEP_SETTLE_MS)
		await sendPrompt(sidebar, SIDEBAR_TURN)
		await pace(BETWEEN_SENDS_MS)
		await sendPrompt(leftPanel, LEFT_PANEL_TURN)
		await pace(BETWEEN_SENDS_MS)
		await sendPrompt(rightPanel, RIGHT_PANEL_TASK)
		await Promise.all([
			waitForReasoning(sidebar, SIDEBAR_REASONING),
			waitForReasoning(leftPanel, LEFT_PANEL_REASONING),
			waitForReasoning(rightPanel, RIGHT_PANEL_REASONING),
		])
		await focusCamera(
			[
				sidebar.getByText(SIDEBAR_REASONING, { exact: false }).last(),
				leftPanel.getByText(LEFT_PANEL_REASONING, { exact: false }).last(),
				rightPanel.getByText(RIGHT_PANEL_REASONING, { exact: false }).last(),
			],
			0,
		)

		const cancelButtons = [sidebar, leftPanel, rightPanel].map((frame) =>
			frame.getByRole("button", { name: "Cancel", exact: true }).first(),
		)
		await Promise.all(cancelButtons.map((button) => expect(button).toBeVisible()))
		await pace()
		await Promise.all(cancelButtons.map((button) => expect(button).toBeVisible()))

		const completions = [
			sidebar.getByText(SIDEBAR_DONE, { exact: false }).last(),
			leftPanel.getByText(LEFT_PANEL_DONE, { exact: false }).last(),
			rightPanel.getByText(RIGHT_PANEL_DONE, { exact: false }).last(),
		]
		await Promise.all(completions.map((completion) => expect(completion).toBeVisible({ timeout: 30_000 })))
		await focusCamera(completions, 0)
		await pace()
		await finishRecording()

		await Promise.all([
			expect(sidebarProfile).toHaveText(E2E_PROFILE_NAMES.mockDeepSeek),
			expect(leftProfile).toHaveText(E2E_PROFILE_NAMES.mockOpenAiResponses),
			expect(rightProfile).toHaveText(E2E_PROFILE_NAMES.mockOpenAiOfficialResponses),
		])
		await expect(sidebar.getByText(LEFT_PANEL_REASONING, { exact: false })).toHaveCount(0)
		await expect(sidebar.getByText(RIGHT_PANEL_REASONING, { exact: false })).toHaveCount(0)
		await expect(leftPanel.getByText(SIDEBAR_REASONING, { exact: false })).toHaveCount(0)
		await expect(leftPanel.getByText(RIGHT_PANEL_REASONING, { exact: false })).toHaveCount(0)
		await expect(rightPanel.getByText(SIDEBAR_REASONING, { exact: false })).toHaveCount(0)
		await expect(rightPanel.getByText(LEFT_PANEL_REASONING, { exact: false })).toHaveCount(0)

		const sidebarConsumptions = server.getMockConsumptions("deepseek-chat")
		const leftConsumptions = server.getMockConsumptions("openai-compatible-responses")
		const rightConsumptions = server.getMockConsumptions("openai-official-responses")
		expect(sidebarConsumptions).toHaveLength(1)
		expect(leftConsumptions).toHaveLength(1)
		expect(rightConsumptions).toHaveLength(1)
		expect(sidebarConsumptions[0]?.contractError).toBeUndefined()
		expect(leftConsumptions[0]?.contractError).toBeUndefined()
		expect(rightConsumptions[0]?.contractError).toBeUndefined()
		expect(sidebarConsumptions[0]?.requestToolResults[0]?.content).not.toContain(LEFT_PANEL_TURN)
		expect(leftConsumptions[0]?.requestToolResults[0]?.content).not.toContain(SIDEBAR_TURN)
		expect(rightConsumptions[0]?.requestToolResults).toHaveLength(0)
		const receivedAtMs = [
			sidebarConsumptions[0]?.receivedAtMs ?? 0,
			leftConsumptions[0]?.receivedAtMs ?? 0,
			rightConsumptions[0]?.receivedAtMs ?? 0,
		]
		expect(Math.max(...receivedAtMs) - Math.min(...receivedAtMs)).toBeLessThan(REQUEST_OVERLAP_WINDOW_MS)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

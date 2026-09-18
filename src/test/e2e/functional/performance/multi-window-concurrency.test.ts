import { access, readdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import {
	computeCompactTrigger,
	computeSummarizeBudget,
	getEstimationTolerance,
	shouldCompactProjectedUsage,
} from "@core/context/context-management/context-window-utils"
import type { MockApiConsumption } from "@e2e/fixtures/server"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { openTab } from "@e2e/utils/common"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Locator, type Page } from "@playwright/test"

const DLINE_RELOAD_NOTIFICATION =
	/Dline v\d+\.\d+\.\d+(?:-[^ ]+)? is installed\. Reload VS Code to finish activating the extension\./

async function selectProfile(frame: Frame, profileName: string): Promise<void> {
	const modelSwitcher = frame.getByRole("button", { name: "Select model" })
	if ((await modelSwitcher.innerText()).trim() === profileName) return
	await modelSwitcher.click()
	const profileOption = frame.getByRole("option").filter({ has: frame.getByText(profileName, { exact: true }) })
	await expect(profileOption).toHaveCount(1)
	await profileOption.click()
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
					if ((await frame.locator("#root").count()) > 0) {
						resolved = frame
						return true
					}
				}
				return false
			},
			{ timeout: 30_000 },
		)
		.toBe(true)
	if (!resolved) throw new Error("Dline editor panel frame was not created")
	return resolved
}

async function createDlinePanelFromTitleAction(page: Page): Promise<Frame> {
	const existingFrames = new Set(page.frames())
	await page.getByRole("button", { name: "New Task", exact: true }).click()
	return findAdditionalDlineFrame(page, existingFrames)
}

async function dismissExtensionsDisabledNotification(page: Page): Promise<void> {
	const blockingMessages: Array<string | RegExp> = [
		"All installed extensions are temporarily disabled.",
		DLINE_RELOAD_NOTIFICATION,
	]
	for (const message of blockingMessages) {
		const notification = page.getByRole("dialog").filter({ hasText: message })
		const clearButton = notification.getByRole("button", { name: "Clear Notification (Del)", exact: true })
		if (!(await clearButton.isVisible())) continue
		try {
			await clearButton.evaluate((element) => (element as HTMLElement).click())
		} catch (error) {
			if (await clearButton.isVisible().catch(() => false)) throw error
		}
		await expect(notification).not.toBeVisible()
	}
}

async function setAutoApproveAction(frame: Frame, label: string, enabled: boolean): Promise<void> {
	await frame.getByLabel("Open auto-approve settings").click()
	const checkbox = frame.locator("vscode-checkbox").filter({ hasText: label })
	await expect(checkbox).toHaveCount(1)
	const isChecked = () => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
	if ((await isChecked()) !== enabled) {
		await frame.getByText(label, { exact: true }).click()
	}
	await expect.poll(isChecked).toBe(enabled)
	await frame.getByLabel("Close auto-approve settings").click()
}

async function pathExists(filePath: string): Promise<boolean> {
	return access(filePath)
		.then(() => true)
		.catch(() => false)
}

async function findTaskIdByHistoryMarker(dlineDocsDir: string, marker: string): Promise<string> {
	return E2ETestHelper.waitForValue(async () => {
		const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true }).catch((error: unknown) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
			throw error
		})
		for (const entry of entries) {
			if (!entry.isDirectory()) continue
			const history = await readFile(
				path.join(dlineDocsDir, "tasks", entry.name, "api_conversation_history.jsonl"),
				"utf8",
			).catch((error: unknown) => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
				throw error
			})
			if (history.includes(marker)) return entry.name
		}
		return undefined
	}, 30_000)
}

async function waitForQnaInteraction(dlineDocsDir: string, taskId: string): Promise<void> {
	const readState = async () => {
		const snapshotText = await readFile(path.join(dlineDocsDir, "tasks", taskId, "snapshot.json"), "utf8")
		const snapshot = JSON.parse(snapshotText) as {
			phase?: string
			interaction?: { interactionId?: string; kind?: string; status?: string }
			turn?: { blocks?: Array<{ dlineTid?: string; phase?: string; toolName?: string }> }
		}
		const block = snapshot.turn?.blocks?.find((candidate) => candidate.toolName === "qna_respond")
		return {
			phase: snapshot.phase,
			interactionId: snapshot.interaction?.interactionId,
			interactionKind: snapshot.interaction?.kind,
			interactionStatus: snapshot.interaction?.status,
			blockId: block?.dlineTid,
			blockPhase: block?.phase,
		}
	}
	await expect.poll(readState, { timeout: 30_000 }).toMatchObject({
		phase: "executing",
		interactionKind: "qna_response",
		interactionStatus: "awaiting",
		blockPhase: "auto_executing",
	})
	const state = await readState()
	expect(state.interactionId).toBeTruthy()
	expect(state.interactionId).toBe(state.blockId)
}

function normalizeNewlines(value: string): string {
	return value.replaceAll("\r\n", "\n")
}

async function configureStressRuntime(dlineDir: string): Promise<void> {
	const profilePath = path.join(dlineDir, "data", "settings", "api_profiles.json")
	const profiles = JSON.parse(await readFile(profilePath, "utf8")) as StoredStressProfile[]
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAi)
	if (!profile?.openai?.capabilities) throw new Error("Missing configurable OpenAI Chat E2E profile")
	profile.modelId = "gpt-5.4-mini"
	profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	profile.openai.capabilities.contextWindow = STRESS_CONTEXT_WINDOW
	await writeFile(profilePath, `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

	const settingsPath = path.join(dlineDir, "data", "settings", "settings.json")
	const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>
	await writeFile(
		settingsPath,
		`${JSON.stringify(
			{
				...settings,
				actModeProfile: E2E_PROFILE_NAMES.mockOpenAi,
				planModeProfile: E2E_PROFILE_NAMES.mockOpenAi,
				useAutoCondense: true,
				autoCondenseTriggerPercent: STRESS_COMPACTION_TRIGGER_PERCENT,
				autoCondenseMinReserveTokens: STRESS_COMPACTION_MIN_RESERVE_TOKENS,
				autoCondenseMaxReserveTokens: STRESS_COMPACTION_MAX_RESERVE_TOKENS,
				autoCondenseMaxContextTokens: 0,
			},
			null,
			2,
		)}\n`,
		"utf8",
	)
}

interface ApiTimingSample {
	taskId: string
	request: number
	localPrepareMs: number
	upstreamTtfbMs: number
	streamMs: number
	totalMs: number
	activeTasks: number
}

interface ControllerDisposeSample {
	taskId: string
	cleanupMs: number
	stateBuildsAfterDetach: number
	suppressedStatePosts: number
}

interface StressTask {
	kind: "editor" | "sidebar"
	marker: string
	frame: Frame
	tab?: Locator
	taskId?: string
}

interface StoredStressProfile {
	name: string
	modelId?: string
	webToolsMode?: "WEB_TOOLS_MODE_FORCE_OFF"
	openai?: { capabilities?: { contextWindow?: number } }
}

interface StressTaskPlan {
	taskIndex: number
	turns: StressTurnPlan[]
	cumulativeInputTokens: number
	compactionCount: number
}

interface StressTurnPlan {
	turn: number
	incrementTokens: number
	contextTokens: number
	compaction?: {
		cycle: number
		triggerTokens: number
		summaryTokens: number
	}
}

const STRESS_CONTEXT_WINDOW = 1_000_000
const STRESS_COMPACTION_TRIGGER_PERCENT = 80
const STRESS_COMPACTION_MIN_RESERVE_TOKENS = 5_000
const STRESS_COMPACTION_MAX_RESERVE_TOKENS = 200_000
const STRESS_COMPACTION_TRIGGER_TOKENS = computeCompactTrigger(STRESS_CONTEXT_WINDOW, computeSummarizeBudget(), {
	triggerPercent: STRESS_COMPACTION_TRIGGER_PERCENT,
	minReserveTokens: STRESS_COMPACTION_MIN_RESERVE_TOKENS,
	maxReserveTokens: STRESS_COMPACTION_MAX_RESERVE_TOKENS,
})
const STRESS_COMPACTION_ESTIMATION_TOLERANCE = getEstimationTolerance()
const STRESS_PROJECTED_USAGE_TRIGGER_TOKENS = STRESS_COMPACTION_TRIGGER_TOKENS - STRESS_COMPACTION_ESTIMATION_TOLERANCE
const STRESS_TRIGGER_GUARD_TOKENS = 10_000
const STRESS_RESPONSE_OUTPUT_TOKENS = 25
const STRESS_MIN_INCREMENT_TOKENS = 100_000
const STRESS_MAX_INCREMENT_TOKENS = 200_000
const STRESS_SUMMARY_CONTEXT_TOKENS = 80_000
const STRESS_TARGET_CUMULATIVE_INPUT_TOKENS = Number.parseInt(process.env.DLINE_E2E_STRESS_TARGET_INPUT_TOKENS ?? "200000000", 10)
const STRESS_MIN_COMPACTIONS = Number.parseInt(process.env.DLINE_E2E_STRESS_MIN_COMPACTIONS ?? "2", 10)
const STRESS_MAX_TURNS = 1_000
const COMPACT_INSTRUCTION_MARKER = "The current conversation is rapidly running out of context"

function createSeededRandom(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
		return state / 0x1_0000_0000
	}
}

function serializedStressTurnEnvelope(marker: string, turn: number): string {
	const content = turn === 0 ? `<task>\n${marker}_TURN_${turn}\n</task>` : `<feedback>\n${marker}_TURN_${turn}\n</feedback>`
	return JSON.stringify(content).slice(1, -1)
}

function keepStressContextOutOfTriggerAmbiguity(baseContextTokens: number, incrementTokens: number): number {
	const projectedUsageWithoutPendingTurn = baseContextTokens + incrementTokens + STRESS_RESPONSE_OUTPUT_TOKENS
	const ambiguousStart = STRESS_PROJECTED_USAGE_TRIGGER_TOKENS - STRESS_TRIGGER_GUARD_TOKENS
	if (
		projectedUsageWithoutPendingTurn < ambiguousStart ||
		projectedUsageWithoutPendingTurn >= STRESS_PROJECTED_USAGE_TRIGGER_TOKENS
	) {
		return incrementTokens
	}

	const increaseToTrigger = STRESS_PROJECTED_USAGE_TRIGGER_TOKENS - projectedUsageWithoutPendingTurn
	if (incrementTokens + increaseToTrigger <= STRESS_MAX_INCREMENT_TOKENS) {
		return incrementTokens + increaseToTrigger
	}

	const decreaseBelowGuard = projectedUsageWithoutPendingTurn - ambiguousStart + 1
	if (incrementTokens - decreaseBelowGuard >= STRESS_MIN_INCREMENT_TOKENS) {
		return incrementTokens - decreaseBelowGuard
	}

	throw new Error("Stress increment cannot be moved outside the compaction trigger guard band")
}

function createStressTaskPlan(taskIndex: number): StressTaskPlan {
	const random = createSeededRandom(0xd11e_0000 + taskIndex)
	const turns: StressTurnPlan[] = []
	let currentContextTokens = 0
	let cumulativeInputTokens = 0
	let compactionCount = 0

	for (let turn = 0; turn < STRESS_MAX_TURNS; turn++) {
		let incrementTokens =
			STRESS_MIN_INCREMENT_TOKENS + Math.floor(random() * (STRESS_MAX_INCREMENT_TOKENS - STRESS_MIN_INCREMENT_TOKENS + 1))
		const shouldCompact =
			turns.length > 0 &&
			shouldCompactProjectedUsage(currentContextTokens + STRESS_RESPONSE_OUTPUT_TOKENS, STRESS_COMPACTION_TRIGGER_TOKENS)
		if (shouldCompact) compactionCount++

		const baseContextTokens = shouldCompact ? STRESS_SUMMARY_CONTEXT_TOKENS : currentContextTokens
		incrementTokens = keepStressContextOutOfTriggerAmbiguity(baseContextTokens, incrementTokens)
		const contextTokens = baseContextTokens + incrementTokens
		const summaryTokens = shouldCompact ? Math.min(currentContextTokens + 2_500, STRESS_CONTEXT_WINDOW - 10_000) : undefined
		turns.push({
			turn,
			incrementTokens,
			contextTokens,
			...(shouldCompact && summaryTokens !== undefined
				? {
						compaction: {
							cycle: compactionCount,
							triggerTokens: currentContextTokens,
							summaryTokens,
						},
					}
				: {}),
		})
		if (shouldCompact && summaryTokens !== undefined) cumulativeInputTokens += summaryTokens
		cumulativeInputTokens += contextTokens
		currentContextTokens = contextTokens

		if (
			cumulativeInputTokens > STRESS_TARGET_CUMULATIVE_INPUT_TOKENS &&
			compactionCount >= STRESS_MIN_COMPACTIONS &&
			currentContextTokens > STRESS_SUMMARY_CONTEXT_TOKENS + STRESS_MIN_INCREMENT_TOKENS
		) {
			return { taskIndex, turns, cumulativeInputTokens, compactionCount }
		}
	}

	throw new Error(`Stress plan ${taskIndex} did not reach the token target within ${STRESS_MAX_TURNS} turns`)
}

const API_TIMING_PATTERN =
	/\[Task (\d+)\] API timing: request=(\d+), localPrepareMs=(\d+), upstreamTtfbMs=(\d+), streamMs=(\d+), totalMs=(\d+), activeTasks=(\d+)/g
const CONTROLLER_DISPOSE_PATTERN =
	/\[Controller\] dispose timing: taskId=([^,]+), cleanupMs=(\d+), stateBuildsAfterDetach=(\d+), suppressedStatePosts=(\d+)/g

function parseApiTimingSamples(output: string): ApiTimingSample[] {
	return Array.from(output.matchAll(API_TIMING_PATTERN), (match) => ({
		taskId: match[1] ?? "",
		request: Number(match[2]),
		localPrepareMs: Number(match[3]),
		upstreamTtfbMs: Number(match[4]),
		streamMs: Number(match[5]),
		totalMs: Number(match[6]),
		activeTasks: Number(match[7]),
	}))
}

function formatMockFailure(consumption: MockApiConsumption): string {
	const requestText = JSON.stringify(consumption.requestBody)
	const stressMarkers = [...new Set(requestText.match(/E2E_STRESS_[A-Z0-9_]+/g) ?? [])]
	return JSON.stringify({
		receivedAtMs: consumption.receivedAtMs,
		responseType: consumption.responseType,
		toolName: consumption.toolName,
		toolCallId: consumption.toolCallId,
		contractError: consumption.contractError,
		requestToolPairing: consumption.requestToolPairing,
		requestToolResults: consumption.requestToolResults.slice(-3),
		stressMarkers: stressMarkers.slice(-12),
	})
}

function parseControllerDisposeSamples(output: string): ControllerDisposeSample[] {
	return Array.from(output.matchAll(CONTROLLER_DISPOSE_PATTERN), (match) => ({
		taskId: match[1] ?? "",
		cleanupMs: Number(match[2]),
		stateBuildsAfterDetach: Number(match[3]),
		suppressedStatePosts: Number(match[4]),
	}))
}

function summarizeDurations(values: readonly number[]) {
	const sorted = [...values].sort((left, right) => left - right)
	const percentile = (ratio: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0
	return {
		count: sorted.length,
		p50: percentile(0.5),
		p95: percentile(0.95),
		max: sorted.at(-1) ?? 0,
	}
}

function dlineEditorGroups(page: Page, taskMarkers: readonly string[] = []) {
	const tabSelector =
		taskMarkers.length > 0
			? taskMarkers.map((marker) => `.tabs-container > .tab[aria-label*="${marker}"]`).join(", ")
			: '.tabs-container > .tab[aria-label*="Dline"]'
	return page.locator(".editor-group-container").filter({
		has: page.locator(tabSelector),
	})
}

async function activateDlinePanel(tab: Locator, frame: Frame): Promise<void> {
	await tab.click()
	await expect(tab).toHaveClass(/\bactive\b/)
	const frameElement = await frame.frameElement()
	await frameElement.waitForElementState("visible")
	await expect(frame.locator("#root")).toBeVisible()
}

async function activateDlinePanelByFrame(group: Locator, frame: Frame): Promise<void> {
	const tabs = group.locator(".tabs-container > .tab")
	for (let index = 0; index < (await tabs.count()); index++) {
		const tab = tabs.nth(index)
		await tab.click()
		try {
			await frame.getByTestId("chat-input").click({ trial: true, timeout: 1_000 })
			await expect(tab).toHaveClass(/\bactive\b/)
			await expect(frame.locator("#root")).toBeVisible()
			return
		} catch {
			// The frame exists but another editor surface still owns pointer events.
		}
	}
	throw new Error("Dline panel tab for the requested frame was not found")
}

async function clickInDlinePanel(group: Locator, frame: Frame, control: Locator): Promise<void> {
	await expect(async () => {
		await activateDlinePanelByFrame(group, frame)
		await control.click({ timeout: 1_000 })
	}).toPass({ timeout: 30_000 })
}

async function findActiveDlineTab(page: Page): Promise<Locator> {
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

async function findVisibleStressTaskFrame(page: Page, marker: string): Promise<Frame | undefined> {
	let resolved: Frame | undefined
	await expect
		.poll(
			async () => {
				for (const frame of page.frames()) {
					if (frame.isDetached() || !frame.url().startsWith("vscode-webview://")) continue
					const input = frame.locator('[data-testid="chat-input"]:visible')
					if (!(await input.isVisible())) continue
					if ((await input.getAttribute("placeholder")) !== "Type a message...") continue
					if ((await frame.getByText(`${marker}_TURN_0`, { exact: true }).count()) === 0) continue
					resolved = frame
					return true
				}
				return false
			},
			{ timeout: 10_000 },
		)
		.toBe(true)
	return resolved
}

async function activateStressTask(page: Page, task: StressTask): Promise<void> {
	if (task.tab) {
		await task.tab.click()
		await expect(task.tab).toHaveClass(/\bactive\b/)
	}
	const resolvedFrame = await findVisibleStressTaskFrame(page, task.marker)
	if (resolvedFrame) task.frame = resolvedFrame
	const frameElement = await task.frame.frameElement()
	await frameElement.waitForElementState("visible")
	await expect(task.frame.locator("#root")).toBeVisible()
	await expect(task.frame.locator('[data-testid="chat-input"]:visible')).toBeEnabled()
}

async function closeEditorTab(tab: Locator, frame: Frame): Promise<void> {
	await expect(tab).toBeVisible()
	await tab.click({ button: "middle" })
	await expect.poll(() => frame.isDetached(), { timeout: 10_000 }).toBe(true)
}

e2e("Dline task panels share one editor group when newly created", async ({ helper, page, server, sidebar, userDataDir }) => {
	e2e.setTimeout(180_000)
	await helper.signin(sidebar)

	const firstTask = "E2E_PANEL_ONE_GROUP"
	server.resetOpenAiMock()
	server.enqueueResponses("openai-compatible-chat", {
		type: "tool",
		id: "call_dline_group_panel_one_completion",
		name: "attempt_completion",
		arguments: { result: "E2E_DLINE_GROUP_PANEL_ONE_DONE" },
		expectedRequestIncludes: [firstTask],
	})

	const firstPanel = await createDlinePanelFromTitleAction(page)
	await E2ETestHelper.dismissWhatsNewModal(firstPanel)
	await dismissExtensionsDisabledNotification(page)
	await firstPanel.getByTestId("chat-input").fill(firstTask)
	await firstPanel.getByTestId("chat-input").press("Enter")
	await expect(firstPanel.getByText("E2E_DLINE_GROUP_PANEL_ONE_DONE", { exact: false }).last()).toBeVisible({
		timeout: 60_000,
	})

	const secondPanel = await createDlinePanelFromTitleAction(page)
	await E2ETestHelper.dismissWhatsNewModal(secondPanel)
	const dlineGroups = dlineEditorGroups(page)
	await expect(dlineGroups).toHaveCount(1)
	const dlineGroupIndex = await dlineGroups
		.first()
		.evaluate((element) => Array.from(document.querySelectorAll(".editor-group-container")).indexOf(element))
	const dlineGroup = page.locator(".editor-group-container").nth(dlineGroupIndex)
	await expect(dlineGroup.locator(".tabs-container > .tab")).toHaveCount(2)

	const secondTask = "E2E_PANEL_TWO_GROUP"
	server.resetOpenAiMock()
	server.enqueueResponses("openai-compatible-chat", {
		type: "tool",
		id: "call_dline_group_panel_two_completion",
		name: "attempt_completion",
		arguments: { result: "E2E_DLINE_GROUP_PANEL_TWO_DONE" },
		expectedRequestIncludes: [secondTask],
	})
	await secondPanel.getByTestId("chat-input").fill(secondTask)
	await secondPanel.getByTestId("chat-input").press("Enter")
	await expect(secondPanel.getByText("E2E_DLINE_GROUP_PANEL_TWO_DONE", { exact: false }).last()).toBeVisible({
		timeout: 60_000,
	})

	const editorFrameCount = page
		.frames()
		.filter((frame) => frame.url().startsWith("vscode-webview://") && frame !== sidebar).length
	await dlineGroup.locator(`.tab[aria-label*="${firstTask.slice(0, 16)}"]`).click()
	await firstPanel.locator('vscode-button[aria-label="Start New Task"]').click()
	await expect(firstPanel.getByTestId("chat-input")).toBeEnabled()
	await expect(dlineGroup.locator(".tabs-container > .tab")).toHaveCount(2)
	await expect
		.poll(() => page.frames().filter((frame) => frame.url().startsWith("vscode-webview://") && frame !== sidebar).length)
		.toBe(editorFrameCount)
	await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
})

e2e("Dline task panels preserve independent editor groups across window reload", async ({ helper, page, server, sidebar }) => {
	e2e.setTimeout(240_000)
	await helper.signin(sidebar)

	const firstTask = "E2E_LAYOUT_A_PANEL"
	const secondTask = "E2E_LAYOUT_B_PANEL"
	server.resetOpenAiMock()
	server.enqueueResponses(
		"openai-compatible-chat",
		{
			type: "tool",
			id: "call_reload_layout_panel_a",
			name: "attempt_completion",
			arguments: { result: "E2E_RELOAD_LAYOUT_PANEL_A_DONE" },
			expectedRequestIncludes: [firstTask],
		},
		{
			type: "tool",
			id: "call_reload_layout_panel_b",
			name: "attempt_completion",
			arguments: { result: "E2E_RELOAD_LAYOUT_PANEL_B_DONE" },
			expectedRequestIncludes: [secondTask],
		},
	)

	const firstPanel = await createDlinePanelFromTitleAction(page)
	await E2ETestHelper.dismissWhatsNewModal(firstPanel)
	await dismissExtensionsDisabledNotification(page)
	const firstInput = firstPanel.getByTestId("chat-input")
	await firstInput.fill(firstTask)
	await firstInput.press("Enter")
	await expect(firstInput).toHaveValue("")
	await expect(firstPanel.getByText("E2E_RELOAD_LAYOUT_PANEL_A_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })

	const secondPanel = await createDlinePanelFromTitleAction(page)
	await E2ETestHelper.dismissWhatsNewModal(secondPanel)
	const secondInput = secondPanel.getByTestId("chat-input")
	await secondInput.fill(secondTask)
	await secondInput.press("Enter")
	await expect(secondInput).toHaveValue("")
	await expect(secondPanel.getByText("E2E_RELOAD_LAYOUT_PANEL_B_DONE", { exact: false }).last()).toBeVisible({
		timeout: 60_000,
	})

	const reloadTaskMarkers = [firstTask, secondTask].map((task) => task.slice(0, 16))
	const editorGroups = page.locator(".editor-group-container")
	const editorGroupCountBeforeMove = await editorGroups.count()
	const secondTaskTab = page.locator(`.tab[aria-label*="${secondTask.slice(0, 16)}"]`)
	// Ctrl+\ creates the destination group for this custom editor without moving it. Invoke
	// VS Code's command directly instead of relying on submenu pointer/keyboard ownership.
	await secondTaskTab.click()
	await page.keyboard.press("Control+\\")
	await expect(editorGroups).toHaveCount(editorGroupCountBeforeMove + 1)
	await secondTaskTab.click()
	// VS Code transfers focus into a selected custom-editor iframe asynchronously.
	// Let that transfer finish before opening QuickInput so it cannot close the palette afterward.
	await expect.poll(() => secondPanel.evaluate(() => document.hasFocus())).toBe(true)
	await E2ETestHelper.runCommandPalette(page, "View: Move Editor into Next Group")
	await expect(dlineEditorGroups(page, reloadTaskMarkers)).toHaveCount(2)

	await E2ETestHelper.runCommandPalette(page, "Developer: Reload Window")
	await expect(dlineEditorGroups(page, reloadTaskMarkers)).toHaveCount(2, { timeout: 60_000 })
	await expect(page.locator(`.tab[aria-label*="${firstTask.slice(0, 16)}"]`)).toHaveCount(1)
	await expect(page.locator(`.tab[aria-label*="${secondTask.slice(0, 16)}"]`)).toHaveCount(1)
})

e2e(
	"Closing a Dline task panel detaches its UI before asynchronous task cleanup",
	async ({ dlineDocsDir, helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)

		const task = "E2E_CLOSED_PANEL_NO_SYNC"
		server.resetOpenAiMock()
		server.enqueueResponses("openai-compatible-chat", {
			type: "tool",
			id: "call_closed_panel_delayed_read",
			name: "read_file",
			arguments: {
				path: "README.md",
				task_progress: "# Closed panel probe\\n- [ ] Read README",
			},
			delayMs: 3_000,
			expectedRequestIncludes: [task],
		})

		const panel = await createDlinePanelFromTitleAction(page)
		await E2ETestHelper.dismissWhatsNewModal(panel)
		const input = panel.getByTestId("chat-input")
		await input.fill(task)
		await input.press("Enter")
		await expect(input).toHaveValue("")
		await expect.poll(() => server.getRequestCount("openai-compatible-chat"), { timeout: 60_000 }).toBe(1)

		const taskIds = (await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
		const taskId = taskIds.at(-1)
		if (!taskId) throw new Error("Closed panel task ID was not persisted")
		const outputBeforeClose = await E2ETestHelper.readDlineOutput(userDataDir)

		await closeEditorTab(page.locator(`.tab[aria-label*="${task.slice(0, 16)}"]`), panel)
		await expect
			.poll(
				async () =>
					(await E2ETestHelper.readDlineOutput(userDataDir))
						.slice(outputBeforeClose.length)
						.includes("Controller disposed"),
				{ timeout: 30_000 },
			)
			.toBe(true)

		const outputAfterClose = (await E2ETestHelper.readDlineOutput(userDataDir)).slice(outputBeforeClose.length)
		const detachedLogIndex = outputAfterClose.indexOf(`[Controller] UI detached: taskId=${taskId}`)
		expect(detachedLogIndex).toBeGreaterThanOrEqual(0)
		const outputAfterDetach = outputAfterClose.slice(detachedLogIndex)
		expect(outputAfterDetach).not.toContain(`[Controller] Panel title synced: ${task}`)
		expect(outputAfterDetach).not.toContain(`getStateToPostToWebview took`)
	},
)

e2e(
	"Five tasks repeatedly auto-compact at 1M context and exceed 200M cumulative input tokens",
	{ tag: "@pressure" },
	async ({ dlineDir, dlineDocsDir, helper, page, server, userDataDir }, testInfo) => {
		e2e.setTimeout(2_400_000)
		await configureStressRuntime(dlineDir)
		const reloadNotification = page.getByRole("dialog").filter({ hasText: DLINE_RELOAD_NOTIFICATION })
		await reloadNotification.getByRole("button", { name: "Reload Window", exact: true }).click()
		await dismissExtensionsDisabledNotification(page)
		await E2ETestHelper.openClineSidebar(page)
		const stressSidebar = await helper.getSidebar(page)
		await E2ETestHelper.dismissWhatsNewModal(stressSidebar)
		const webviewErrors: string[] = []
		page.on("console", (message) => {
			if (message.type() === "error") webviewErrors.push(message.text())
		})
		page.on("pageerror", (error) => webviewErrors.push(error.stack ?? error.message))
		await helper.signin(stressSidebar)

		const editorSurfaces: Array<{ frame: Frame; tab: Locator }> = []
		for (let index = 0; index < 4; index++) {
			const frame = await createDlinePanelFromTitleAction(page)
			await E2ETestHelper.dismissWhatsNewModal(frame)
			const tab = await findActiveDlineTab(page)
			editorSurfaces.push({ frame, tab })
		}

		const tasks: StressTask[] = [
			...editorSurfaces.map(({ frame, tab }, index) => ({
				kind: "editor" as const,
				marker: `E2E_STRESS_EDITOR_${index}`,
				frame,
				tab,
			})),
			{ kind: "sidebar", marker: "E2E_STRESS_SIDEBAR", frame: stressSidebar },
		]
		for (const task of tasks) {
			if (task.tab) await activateDlinePanel(task.tab, task.frame)
			await selectProfile(task.frame, E2E_PROFILE_NAMES.mockOpenAi)
		}

		const taskPlans = tasks.map((_, taskIndex) => createStressTaskPlan(taskIndex))
		const maxTurns = Math.max(...taskPlans.map((plan) => plan.turns.length))
		server.resetOpenAiMock()
		const enqueueStressTurnResponses = (taskIndex: number, task: StressTask, turnPlan: StressTurnPlan): void => {
			if (turnPlan.compaction) {
				const summary = `${task.marker}_SUMMARY_${turnPlan.compaction.cycle} preserves the task and pending turn ${turnPlan.turn}.`
				server.enqueueResponses("openai-compatible-chat", {
					type: "tool",
					id: `call_stress_summary_${taskIndex}_${turnPlan.compaction.cycle}`,
					name: "summarize_task",
					arguments: { context: summary },
					expectedRequestIncludes: [
						COMPACT_INSTRUCTION_MARKER,
						serializedStressTurnEnvelope(task.marker, Math.max(0, turnPlan.turn - 2)),
					],
					expectedRequestExcludes: [
						serializedStressTurnEnvelope(task.marker, turnPlan.turn - 1),
						serializedStressTurnEnvelope(task.marker, turnPlan.turn),
						`${task.marker}_RESPONSE_${turnPlan.turn}`,
					],
					matchRequestContract: true,
					delayMs: 25,
					usage: { inputTokens: turnPlan.compaction.summaryTokens, outputTokens: 100 },
				})
			}
			server.enqueueResponses("openai-compatible-chat", {
				type: "tool",
				id: `call_stress_${taskIndex}_${turnPlan.turn}`,
				name: "qna_respond",
				arguments: { response: `${task.marker}_RESPONSE_${turnPlan.turn}` },
				expectedRequestIncludes: [
					serializedStressTurnEnvelope(task.marker, turnPlan.turn),
					...(turnPlan.compaction ? [`${task.marker}_SUMMARY_${turnPlan.compaction.cycle}`] : []),
				],
				expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER],
				matchRequestContract: true,
				delayMs: 25,
				usage: { inputTokens: turnPlan.contextTokens, outputTokens: STRESS_RESPONSE_OUTPUT_TOKENS },
			})
		}

		const startedAtMs = Date.now()
		for (let turn = 0; turn < maxTurns; turn++) {
			const activePlans = taskPlans.filter((plan) => plan.turns[turn] !== undefined)
			for (const plan of activePlans) {
				const task = tasks[plan.taskIndex]
				const turnPlan = plan.turns[turn]
				if (!task || !turnPlan) continue
				if (turn === 0) {
					if (task.tab) await activateDlinePanel(task.tab, task.frame)
				} else {
					await activateStressTask(page, task)
				}
				const input = task.frame.locator('[data-testid="chat-input"]:visible')
				const sendButton = task.frame.locator('[data-testid="send-button"]:visible')
				if (turn > 0) {
					task.taskId ??= await findTaskIdByHistoryMarker(dlineDocsDir, task.marker)
					await waitForQnaInteraction(dlineDocsDir, task.taskId)
				}
				enqueueStressTurnResponses(plan.taskIndex, task, turnPlan)
				const turnInput = `${task.marker}_TURN_${turn}`
				await input.fill(turnInput)
				await expect(input).toHaveValue(turnInput)
				await expect(sendButton).not.toHaveClass(/\bdisabled\b/)
				await sendButton.press("Enter")
				await expect(input).toHaveValue("")

				// Serialize provider completion per task so the next feedback binds to the completed qna_respond interaction.
				await expect
					.poll(
						() => {
							const unexpectedError = webviewErrors.find((error) =>
								/Unary RPC|HTTP 500|Internal Server Error|Protobus error/i.test(error),
							)
							if (unexpectedError)
								throw new Error(`Webview request failed during stress turn ${turn}: ${unexpectedError}`)
							const consumptions = server.getMockConsumptions("openai-compatible-chat")
							const unexpectedMockFailure = consumptions.find(
								(entry) => entry.contractError !== undefined || entry.responseType === "error",
							)
							if (unexpectedMockFailure) {
								throw new Error(
									`Mock request failed before ${task.marker} turn ${turn}: ${formatMockFailure(unexpectedMockFailure)}`,
								)
							}
							const matches = consumptions.filter(
								(entry) => entry.toolCallId === `call_stress_${plan.taskIndex}_${turn}`,
							)
							if (matches.length > 1) throw new Error(`Duplicate provider response for ${task.marker} turn ${turn}`)
							if (matches[0]?.contractError) throw new Error(matches[0].contractError)
							return matches.length === 1
						},
						{ timeout: 60_000 },
					)
					.toBe(true)
				await activateStressTask(page, task)
				await expect(task.frame.getByText(`${task.marker}_RESPONSE_${turn}`, { exact: false }).last()).toBeVisible({
					timeout: 60_000,
				})
				const readyInput = task.frame.locator('[data-testid="chat-input"]:visible')
				await expect(readyInput).toBeEnabled()
			}

			await expect
				.poll(
					() => {
						const unexpectedError = webviewErrors.find((error) =>
							/Unary RPC|HTTP 500|Internal Server Error|Protobus error/i.test(error),
						)
						if (unexpectedError)
							throw new Error(`Webview request failed during stress turn ${turn}: ${unexpectedError}`)
						const consumptions = server.getMockConsumptions("openai-compatible-chat")
						return activePlans.every((plan) =>
							consumptions.some((entry) => entry.toolCallId === `call_stress_${plan.taskIndex}_${turn}`),
						)
					},
					{ timeout: 60_000 },
				)
				.toBe(true)

			const consumptions = server.getMockConsumptions("openai-compatible-chat")
			for (const plan of activePlans) {
				const task = tasks[plan.taskIndex]
				const turnPlan = plan.turns[turn]
				if (!task || !turnPlan) continue
				const taskMatches = consumptions.filter((entry) => entry.toolCallId === `call_stress_${plan.taskIndex}_${turn}`)
				expect(taskMatches, `Missing or duplicate request for ${task.marker} turn ${turn}`).toHaveLength(1)
				expect(taskMatches[0]?.contractError).toBeUndefined()
				if (turnPlan.compaction) {
					const summaryMatches = consumptions.filter(
						(entry) => entry.toolCallId === `call_stress_summary_${plan.taskIndex}_${turnPlan.compaction?.cycle}`,
					)
					expect(summaryMatches, `Missing compaction pass for ${task.marker} turn ${turn}`).toHaveLength(1)
					expect(summaryMatches[0]?.contractError).toBeUndefined()
				}
				if (turn === 0) {
					await activateStressTask(page, task)
					const expandTaskHeader = task.frame.getByLabel("Expand task header")
					if (await expandTaskHeader.isVisible()) await expandTaskHeader.click()
					await expect(task.frame.locator('[title="Maximum context window size for this model"]')).toHaveText("1.0m")
				}
			}
		}
		const elapsedMs = Date.now() - startedAtMs
		const totalTurns = taskPlans.reduce((sum, plan) => sum + plan.turns.length, 0)
		const totalCompactions = taskPlans.reduce((sum, plan) => sum + plan.compactionCount, 0)
		const totalCompactionPasses = totalCompactions
		const totalRequests = totalTurns + totalCompactionPasses
		await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(totalRequests)

		const consumptions = server.getMockConsumptions("openai-compatible-chat")
		expect(consumptions).toHaveLength(totalRequests)
		expect(consumptions.map((entry) => entry.contractError).filter((error) => error !== undefined)).toEqual([])
		const tokenTotals = Object.fromEntries(
			tasks.map((task, taskIndex) => {
				const plan = taskPlans[taskIndex]
				if (!plan) throw new Error(`Missing stress plan for ${task.marker}`)
				const taskConsumptions = consumptions.filter(
					(entry) =>
						entry.toolCallId?.startsWith(`call_stress_${taskIndex}_`) ||
						entry.toolCallId?.startsWith(`call_stress_summary_${taskIndex}_`),
				)
				const cumulativeInputTokens = taskConsumptions.reduce((sum, entry) => sum + (entry.usage?.inputTokens ?? 0), 0)
				expect(cumulativeInputTokens).toBe(plan.cumulativeInputTokens)
				expect(cumulativeInputTokens).toBeGreaterThan(STRESS_TARGET_CUMULATIVE_INPUT_TOKENS)
				expect(plan.compactionCount).toBeGreaterThanOrEqual(STRESS_MIN_COMPACTIONS)
				for (const turnPlan of plan.turns.filter((candidate) => candidate.compaction)) {
					const previous = plan.turns[turnPlan.turn - 1]
					expect(
						(previous?.contextTokens ?? 0) + STRESS_RESPONSE_OUTPUT_TOKENS + STRESS_COMPACTION_ESTIMATION_TOLERANCE,
					).toBeGreaterThanOrEqual(STRESS_COMPACTION_TRIGGER_TOKENS)
					expect(turnPlan.contextTokens).toBeLessThan(previous?.contextTokens ?? Number.POSITIVE_INFINITY)
					expect(turnPlan.contextTokens).toBeGreaterThanOrEqual(
						STRESS_SUMMARY_CONTEXT_TOKENS + STRESS_MIN_INCREMENT_TOKENS,
					)
				}
				return [task.marker, cumulativeInputTokens]
			}),
		)
		await openTab(page, "Explorer ")
		await page.getByRole("treeitem", { name: "index.html" }).locator("a").click()
		const fileTab = page.getByRole("tab", { name: "index.html" })
		const fileEditorGroup = page.locator(".editor-group-container").filter({ has: fileTab })
		const fileEditor = fileEditorGroup.locator(".monaco-editor:visible").last()
		await expect(fileTab).toBeVisible({ timeout: 30_000 })
		await expect(fileTab).toHaveAttribute("aria-selected", "true")
		await expect(fileEditor).toBeVisible({ timeout: 30_000 })

		const switchCycles = 10
		const taskTabActiveMs: number[] = []
		const taskInputInteractiveMs: number[] = []
		const fileTabActiveMs: number[] = []
		const fileEditorVisibleMs: number[] = []
		const sidebarActiveMs: number[] = []
		const sidebarInputInteractiveMs: number[] = []
		for (let cycle = 0; cycle < switchCycles; cycle++) {
			for (const task of tasks.filter((candidate) => candidate.kind === "editor")) {
				const tab = task.tab
				if (!tab) throw new Error(`Missing editor tab for ${task.marker}`)
				const startedAt = Date.now()
				await tab.click()
				await expect(tab).toHaveClass(/\bactive\b/)
				taskTabActiveMs.push(Date.now() - startedAt)
				const resolvedFrame = await findVisibleStressTaskFrame(page, task.marker)
				if (resolvedFrame) task.frame = resolvedFrame
				const frameElement = await task.frame.frameElement()
				await frameElement.waitForElementState("visible")
				await expect(task.frame.locator("#root")).toBeVisible()
				await expect(task.frame.locator('[data-testid="chat-input"]:visible')).toBeEnabled()
				taskInputInteractiveMs.push(Date.now() - startedAt)
			}

			const fileStartedAt = Date.now()
			await fileTab.click()
			await expect(fileTab).toHaveClass(/\bactive\b/)
			fileTabActiveMs.push(Date.now() - fileStartedAt)
			await expect(fileEditor).toBeVisible()
			fileEditorVisibleMs.push(Date.now() - fileStartedAt)

			await openTab(page, "Explorer ")
			const sidebarStartedAt = Date.now()
			await E2ETestHelper.openClineSidebar(page)
			sidebarActiveMs.push(Date.now() - sidebarStartedAt)
			const sidebarTask = tasks.at(-1)
			if (!sidebarTask) throw new Error("Missing sidebar stress task")
			const sidebarFrame = await findVisibleStressTaskFrame(page, sidebarTask.marker)
			if (sidebarFrame) sidebarTask.frame = sidebarFrame
			await expect(sidebarTask.frame.locator('[data-testid="chat-input"]:visible')).toBeEnabled()
			sidebarInputInteractiveMs.push(Date.now() - sidebarStartedAt)
		}

		const output = await E2ETestHelper.readDlineOutput(userDataDir)
		// Internal compaction requests use their own request path; API timing covers ordinary turn requests only.
		const allApiSamples = parseApiTimingSamples(output)
		expect(allApiSamples).toHaveLength(totalTurns)
		const apiSamples = allApiSamples.filter((sample) => sample.activeTasks >= tasks.length)
		const timedRequestsBeforeAllTasksWereActive = tasks.length - 1
		expect(apiSamples).toHaveLength(totalTurns - timedRequestsBeforeAllTasksWereActive)
		const report = {
			taskCount: tasks.length,
			editorTaskCount: editorSurfaces.length,
			sidebarTaskCount: 1,
			contextWindow: STRESS_CONTEXT_WINDOW,
			compactionTriggerPercent: STRESS_COMPACTION_TRIGGER_PERCENT,
			compactionTriggerTokens: STRESS_COMPACTION_TRIGGER_TOKENS,
			effectiveCompactionTriggerTokens: STRESS_COMPACTION_TRIGGER_TOKENS - STRESS_COMPACTION_ESTIMATION_TOLERANCE,
			incrementTokenRange: [STRESS_MIN_INCREMENT_TOKENS, STRESS_MAX_INCREMENT_TOKENS],
			turnsByTask: Object.fromEntries(
				tasks.map((task, taskIndex) => [task.marker, taskPlans[taskIndex]?.turns.length ?? 0]),
			),
			compactionsByTask: Object.fromEntries(
				tasks.map((task, taskIndex) => [task.marker, taskPlans[taskIndex]?.compactionCount ?? 0]),
			),
			totalTurns,
			totalCompactions,
			totalCompactionPasses,
			totalRequests,
			timedRequests: allApiSamples.length,
			timedRequestsBeforeAllTasksWereActive,
			cumulativeInputTokensByTask: tokenTotals,
			elapsedMs,
			localPrepareMs: summarizeDurations(apiSamples.map((sample) => sample.localPrepareMs)),
			upstreamTtfbMs: summarizeDurations(apiSamples.map((sample) => sample.upstreamTtfbMs)),
			streamMs: summarizeDurations(apiSamples.map((sample) => sample.streamMs)),
			totalMs: summarizeDurations(apiSamples.map((sample) => sample.totalMs)),
			surfaceSwitching: {
				cycles: switchCycles,
				taskTabActiveMs: summarizeDurations(taskTabActiveMs),
				taskInputInteractiveMs: summarizeDurations(taskInputInteractiveMs),
				fileTabActiveMs: summarizeDurations(fileTabActiveMs),
				fileEditorVisibleMs: summarizeDurations(fileEditorVisibleMs),
				sidebarActiveMs: summarizeDurations(sidebarActiveMs),
				sidebarInputInteractiveMs: summarizeDurations(sidebarInputInteractiveMs),
			},
		}
		await testInfo.attach("five-task-auto-compact-200m-performance.json", {
			body: Buffer.from(JSON.stringify(report, null, 2)),
			contentType: "application/json",
		})
		expect(report.localPrepareMs.p95).toBeLessThan(20_000)
		expect(report.upstreamTtfbMs.p95).toBeLessThan(10_000)
		expect(report.streamMs.p95).toBeLessThan(10_000)
		expect(report.surfaceSwitching.taskInputInteractiveMs.p95).toBeLessThan(5_000)
		expect(report.surfaceSwitching.fileEditorVisibleMs.p95).toBeLessThan(5_000)
		expect(report.surfaceSwitching.sidebarInputInteractiveMs.p95).toBeLessThan(5_000)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"New Task panel creation and close remains isolated across 100 cycles",
	async ({ helper, page, sidebar, userDataDir }, testInfo) => {
		e2e.setTimeout(1_200_000)
		await helper.signin(sidebar)

		const cycles = Number.parseInt(process.env.DLINE_E2E_PANEL_CYCLES ?? "100", 10)
		if (!Number.isInteger(cycles) || cycles <= 0) throw new Error("DLINE_E2E_PANEL_CYCLES must be a positive integer")
		const outputBefore = await E2ETestHelper.readDlineOutput(userDataDir)
		const cycleDurationsMs: number[] = []
		for (let index = 0; index < cycles; index++) {
			const startedAtMs = Date.now()
			const panel = await createDlinePanelFromTitleAction(page)
			if (index === 0) await E2ETestHelper.dismissWhatsNewModal(panel)
			const dlineTab = page.locator('.tabs-container > .tab[aria-label*="Dline"]').last()
			await closeEditorTab(dlineTab, panel)
			cycleDurationsMs.push(Date.now() - startedAtMs)
		}

		await expect
			.poll(
				async () =>
					parseControllerDisposeSamples((await E2ETestHelper.readDlineOutput(userDataDir)).slice(outputBefore.length))
						.length,
				{ timeout: 30_000 },
			)
			.toBe(cycles)
		const outputAfter = (await E2ETestHelper.readDlineOutput(userDataDir)).slice(outputBefore.length)
		const disposeSamples = parseControllerDisposeSamples(outputAfter)
		expect(disposeSamples).toHaveLength(cycles)
		expect(disposeSamples.every((sample) => sample.stateBuildsAfterDetach === 0)).toBe(true)
		const report = {
			cycles,
			cycleMs: summarizeDurations(cycleDurationsMs),
			cleanupMs: summarizeDurations(disposeSamples.map((sample) => sample.cleanupMs)),
			suppressedStatePosts: disposeSamples.reduce((sum, sample) => sum + sample.suppressedStatePosts, 0),
		}
		await testInfo.attach("new-task-close-100-cycle-performance.json", {
			body: Buffer.from(JSON.stringify(report, null, 2)),
			contentType: "application/json",
		})
		expect(report.cycleMs.p95).toBeLessThan(5_000)
		expect(report.cleanupMs.p95).toBeLessThan(5_000)
	},
)

e2e(
	"Concurrent edit panels isolate checkpoint writes and restores in one workspace",
	async ({ helper, page, server, sidebar, userDataDir, workspaceDir }, testInfo) => {
		e2e.setTimeout(300_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Edit project files", true)

		const panelA = await createDlinePanelFromTitleAction(page)
		await E2ETestHelper.dismissWhatsNewModal(panelA)
		await dismissExtensionsDisabledNotification(page)
		const panelB = await createDlinePanelFromTitleAction(page)
		await E2ETestHelper.dismissWhatsNewModal(panelB)

		const dlineGroups = dlineEditorGroups(page)
		await expect(dlineGroups).toHaveCount(1)
		const dlineGroupIndex = await dlineGroups
			.first()
			.evaluate((element) => Array.from(document.querySelectorAll(".editor-group-container")).indexOf(element))
		const dlineGroup = page.locator(".editor-group-container").nth(dlineGroupIndex)
		const panelTabs = dlineGroup.locator(".tabs-container > .tab")
		await expect(panelTabs).toHaveCount(2)

		const panelATask = "E2E_CONCURRENT_CHECKPOINT_PANEL_A"
		const panelBTask = "E2E_CONCURRENT_CHECKPOINT_PANEL_B"
		const panelAFollowUp = "E2E_CONCURRENT_PANEL_A_RESTORED"
		const panelBFollowUp = "E2E_CONCURRENT_PANEL_B_CONTINUES"
		const panelARelativePath = "panel-a-checkpoint.txt"
		const panelBRelativePath = "panel-b-checkpoint.txt"
		const panelAPath = path.join(workspaceDir, panelARelativePath)
		const panelBPath = path.join(workspaceDir, panelBRelativePath)

		server.resetOpenAiMock()
		server.enqueueResponses(
			"openai-compatible-chat",
			{
				type: "tool",
				id: "call_concurrent_panel_a_write",
				name: "write_to_file",
				arguments: { path: panelARelativePath, content: "panel A checkpoint content\n" },
				expectedRequestIncludes: [panelATask],
			},
			{
				type: "tool",
				id: "call_concurrent_panel_a_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_CONCURRENT_PANEL_A_DONE" },
				expectedToolResults: [{ callId: "call_concurrent_panel_a_write", contentIncludes: "successfully saved" }],
			},
		)
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_concurrent_panel_b_write",
				name: "write_to_file",
				arguments: { path: panelBRelativePath, content: "panel B checkpoint content\n" },
				expectedRequestIncludes: [panelBTask],
			},
			{
				type: "tool",
				id: "call_concurrent_panel_b_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_CONCURRENT_PANEL_B_DONE" },
				expectedToolResults: [{ callId: "call_concurrent_panel_b_write", contentIncludes: "successfully saved" }],
			},
		)

		await activateDlinePanelByFrame(dlineGroup, panelA)
		await expect(panelA.getByTestId("chat-input")).toBeVisible()
		await selectProfile(panelA, E2E_PROFILE_NAMES.mockOpenAi)
		await panelA.getByTestId("chat-input").fill(panelATask)
		const panelASubmittedAtMs = Date.now()
		await panelA.getByTestId("send-button").click()
		await expect(panelA.getByTestId("chat-input")).toHaveValue("")
		await expect(panelA.getByText(panelATask, { exact: true }).first()).toBeVisible()
		await activateDlinePanelByFrame(dlineGroup, panelB)
		await expect(panelB.getByTestId("chat-input")).toBeVisible()
		await selectProfile(panelB, E2E_PROFILE_NAMES.mockOpenAiResponses)
		await panelB.getByTestId("chat-input").fill(panelBTask)
		const panelBSubmittedAtMs = Date.now()
		await clickInDlinePanel(dlineGroup, panelB, panelB.getByTestId("send-button"))
		await expect(panelB.getByTestId("chat-input")).toHaveValue("")
		await expect(panelB.getByText(panelBTask, { exact: true }).first()).toBeVisible()

		await Promise.all([
			expect.poll(() => server.getRequestCount("openai-compatible-chat"), { timeout: 60_000 }).toBe(2),
			expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 60_000 }).toBe(2),
		])
		const chatRequests = server.getMockConsumptions("openai-compatible-chat")
		const responsesRequests = server.getMockConsumptions("openai-compatible-responses")
		const performance = {
			panelAInitializationMs: chatRequests[0].receivedAtMs - panelASubmittedAtMs,
			panelBInitializationMs: responsesRequests[0].receivedAtMs - panelBSubmittedAtMs,
			panelACommitMs: chatRequests[1].receivedAtMs - chatRequests[0].receivedAtMs,
			panelBCommitMs: responsesRequests[1].receivedAtMs - responsesRequests[0].receivedAtMs,
			firstRequestDeltaMs: Math.abs(chatRequests[0].receivedAtMs - responsesRequests[0].receivedAtMs),
		}
		await testInfo.attach("concurrent-checkpoint-performance.json", {
			body: Buffer.from(JSON.stringify(performance, null, 2)),
			contentType: "application/json",
		})
		expect(performance.panelAInitializationMs).toBeLessThan(20_000)
		expect(performance.panelBInitializationMs).toBeLessThan(20_000)
		expect(performance.panelACommitMs).toBeLessThan(20_000)
		expect(performance.panelBCommitMs).toBeLessThan(20_000)
		expect(performance.firstRequestDeltaMs).toBeLessThan(10_000)

		await activateDlinePanelByFrame(dlineGroup, panelA)
		await expect(panelA.getByText(panelATask, { exact: true }).first()).toBeVisible()
		await expect(panelA.locator('vscode-button[aria-label="Start New Task"]')).toBeVisible({ timeout: 60_000 })
		await activateDlinePanelByFrame(dlineGroup, panelB)
		await expect(panelB.getByText(panelBTask, { exact: true }).first()).toBeVisible()
		await expect(panelB.locator('vscode-button[aria-label="Start New Task"]')).toBeVisible({ timeout: 60_000 })
		await expect.poll(() => pathExists(panelAPath)).toBe(true)
		await expect.poll(() => pathExists(panelBPath)).toBe(true)
		expect(normalizeNewlines(await readFile(panelAPath, "utf8"))).toBe("panel A checkpoint content\n")
		expect(normalizeNewlines(await readFile(panelBPath, "utf8"))).toBe("panel B checkpoint content\n")

		await activateDlinePanelByFrame(dlineGroup, panelA)
		const checkpointLabels = panelA.getByText("Checkpoint", { exact: true })
		await expect.poll(() => checkpointLabels.count()).toBeGreaterThan(0)
		const initialCheckpoint = checkpointLabels.first().locator("..").locator("..")
		await initialCheckpoint.hover()
		await initialCheckpoint.getByRole("button", { name: "Restore", exact: true }).click()
		const restoreAllButton = panelA.getByRole("button", { name: "Restore Files & Task", exact: true })
		await expect(restoreAllButton).toBeVisible()
		await restoreAllButton.click()
		await expect.poll(() => pathExists(panelAPath)).toBe(false)
		await expect.poll(() => pathExists(panelBPath)).toBe(true)
		expect(normalizeNewlines(await readFile(panelBPath, "utf8"))).toBe("panel B checkpoint content\n")
		await expect(panelA.locator('vscode-button[aria-label="Resume"]')).toBeVisible({ timeout: 30_000 })

		await activateDlinePanelByFrame(dlineGroup, panelB)
		await expect(panelB.getByText(panelBTask, { exact: true }).first()).toBeVisible()
		await expect(panelB.locator('vscode-button[aria-label="Start New Task"]')).toBeVisible()
		await expect(panelB.getByRole("button", { name: "Select model" })).toHaveText(E2E_PROFILE_NAMES.mockOpenAiResponses)
		server.enqueueResponses("openai-compatible-responses", {
			type: "tool",
			id: "call_concurrent_panel_b_follow_up",
			name: "attempt_completion",
			arguments: { result: "E2E_CONCURRENT_PANEL_B_STILL_WORKS" },
			expectedToolResults: [{ callId: "call_concurrent_panel_b_completion", contentIncludes: panelBFollowUp }],
		})
		await panelB.getByTestId("chat-input").fill(panelBFollowUp)
		await panelB.getByTestId("send-button").click()
		await expect(panelB.getByText("E2E_CONCURRENT_PANEL_B_STILL_WORKS", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => pathExists(panelBPath)).toBe(true)
		expect(normalizeNewlines(await readFile(panelBPath, "utf8"))).toBe("panel B checkpoint content\n")

		await activateDlinePanelByFrame(dlineGroup, panelA)
		const panelAResume = panelA.locator('vscode-button[aria-label="Resume"]')
		server.enqueueResponses("openai-compatible-chat", {
			type: "tool",
			id: "call_concurrent_panel_a_follow_up",
			name: "attempt_completion",
			arguments: { result: "E2E_CONCURRENT_PANEL_A_RESTORE_CONTINUES" },
			expectedRequestIncludes: [panelAFollowUp],
		})
		const panelAInput = panelA.getByTestId("chat-input")
		await panelAInput.fill(panelAFollowUp)
		await expect(panelAInput).toHaveValue(panelAFollowUp)
		await expect(panelAResume).toBeVisible()
		await panelAResume.click()
		await expect(panelA.getByText("E2E_CONCURRENT_PANEL_A_RESTORE_CONTINUES", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Three concurrent OpenAI Responses tasks keep cache partitions and histories isolated",
	async ({ dlineDocsDir, helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(240_000)
		await helper.signin(sidebar)
		await dismissExtensionsDisabledNotification(page)

		const taskCases = [
			{
				marker: "E2E_RESPONSES_CACHE_CONCURRENT_A",
				firstResult: "E2E_RESPONSES_CACHE_A_FIRST_OK",
				followUp: "E2E_RESPONSES_CACHE_A_FOLLOW_UP",
				followUpResult: "E2E_RESPONSES_CACHE_A_SECOND_OK",
			},
			{
				marker: "E2E_RESPONSES_CACHE_CONCURRENT_B",
				firstResult: "E2E_RESPONSES_CACHE_B_FIRST_OK",
				followUp: "E2E_RESPONSES_CACHE_B_FOLLOW_UP",
				followUpResult: "E2E_RESPONSES_CACHE_B_SECOND_OK",
			},
			{
				marker: "E2E_RESPONSES_CACHE_CONCURRENT_C",
				firstResult: "E2E_RESPONSES_CACHE_C_FIRST_OK",
				followUp: "E2E_RESPONSES_CACHE_C_FOLLOW_UP",
				followUpResult: "E2E_RESPONSES_CACHE_C_SECOND_OK",
			},
		] as const

		server.resetOpenAiMock()
		for (const [index, taskCase] of taskCases.entries()) {
			server.enqueueResponses("openai-compatible-responses", {
				type: "tool",
				id: `call_responses_cache_concurrent_${index}_first`,
				name: "qna_respond",
				arguments: { response: taskCase.firstResult },
				expectedRequestIncludes: [taskCase.marker],
				matchRequestContract: true,
				delayMs: 10_000,
			})
		}

		const tasks: Array<{
			marker: string
			firstResult: string
			frame: Frame
			tab: Locator
			followUp: string
			followUpResult: string
		}> = []
		for (const [index, taskCase] of taskCases.entries()) {
			const frame = await createDlinePanelFromTitleAction(page)
			await E2ETestHelper.dismissWhatsNewModal(frame)
			const tab = await findActiveDlineTab(page)
			await activateDlinePanel(tab, frame)
			await selectProfile(frame, E2E_PROFILE_NAMES.mockOpenAiResponses)
			const task = {
				marker: taskCase.marker,
				firstResult: taskCase.firstResult,
				frame,
				tab,
				followUp: taskCase.followUp,
				followUpResult: taskCase.followUpResult,
			}
			tasks.push(task)
			const input = frame.getByTestId("chat-input")
			await input.fill(task.marker)
			await frame.getByTestId("send-button").click()
			await expect(input).toHaveValue("")
			await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 30_000 }).toBe(index + 1)
		}
		await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 60_000 }).toBe(3)
		const firstRoundRequests = server.getMockConsumptions("openai-compatible-responses")
		expect(firstRoundRequests).toHaveLength(3)
		expect(
			Math.max(...firstRoundRequests.map(({ receivedAtMs }) => receivedAtMs)) -
				Math.min(...firstRoundRequests.map(({ receivedAtMs }) => receivedAtMs)),
		).toBeLessThan(10_000)
		for (const task of tasks) {
			await activateDlinePanel(task.tab, task.frame)
			await expect(task.frame.getByText(task.firstResult, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			const taskId = await findTaskIdByHistoryMarker(dlineDocsDir, task.marker)
			await waitForQnaInteraction(dlineDocsDir, taskId)
		}

		for (const [index, taskCase] of taskCases.entries()) {
			server.enqueueResponses("openai-compatible-responses", {
				type: "tool",
				id: `call_responses_cache_concurrent_${index}_second`,
				name: "qna_respond",
				arguments: { response: taskCase.followUpResult },
				expectedRequestIncludes: [taskCase.marker, taskCase.followUp],
				matchRequestContract: true,
				delayMs: 10_000,
			})
		}
		for (const [index, task] of tasks.entries()) {
			await activateDlinePanel(task.tab, task.frame)
			const input = task.frame.getByTestId("chat-input")
			await expect(input).toBeEnabled()
			await input.fill(task.followUp)
			await input.press("Enter")
			await expect(input).toHaveValue("")
			const feedback = task.frame.getByTestId(/^(?:user|queued)-input-markdown-scroll$/).filter({ hasText: task.followUp })
			await expect(feedback).toHaveCount(1)
			await expect(feedback).toHaveText(task.followUp)
			await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 30_000 }).toBe(index + 4)
		}
		await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 60_000 }).toBe(6)
		const secondRoundRequests = server.getMockConsumptions("openai-compatible-responses").slice(3)
		expect(secondRoundRequests).toHaveLength(3)
		expect(
			Math.max(...secondRoundRequests.map(({ receivedAtMs }) => receivedAtMs)) -
				Math.min(...secondRoundRequests.map(({ receivedAtMs }) => receivedAtMs)),
		).toBeLessThan(10_000)
		for (const task of tasks) {
			await activateDlinePanel(task.tab, task.frame)
			await expect(task.frame.getByText(task.followUpResult, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		}

		const consumptions = server.getMockConsumptions("openai-compatible-responses")
		expect(consumptions).toHaveLength(6)
		expect(consumptions.map((entry) => entry.contractError).filter((error) => error !== undefined)).toEqual([])
		const taskKeys = new Map<string, string>()
		for (const [index, taskCase] of taskCases.entries()) {
			const firstRequest = consumptions.find(
				(entry) => entry.toolCallId === `call_responses_cache_concurrent_${index}_first`,
			)
			const secondRequest = consumptions.find(
				(entry) => entry.toolCallId === `call_responses_cache_concurrent_${index}_second`,
			)
			if (!firstRequest || !secondRequest) throw new Error(`Missing Requests for ${taskCase.marker}`)
			const firstBody = firstRequest.requestBody as Record<string, unknown>
			const secondBody = secondRequest.requestBody as Record<string, unknown>
			expect(firstBody).not.toHaveProperty("previous_response_id")
			expect(secondBody).not.toHaveProperty("previous_response_id")
			expect(firstBody).not.toHaveProperty("conversation")
			expect(secondBody).not.toHaveProperty("conversation")
			expect(firstBody.prompt_cache_options).toBeUndefined()
			expect(secondBody.prompt_cache_options).toBeUndefined()
			const firstHistory = JSON.stringify(firstBody).replace(/<environment_details>[\s\S]*?<\/environment_details>/g, "")
			const secondHistory = JSON.stringify(secondBody).replace(/<environment_details>[\s\S]*?<\/environment_details>/g, "")
			for (const otherCase of taskCases.filter((candidate) => candidate.marker !== taskCase.marker)) {
				expect(firstHistory).not.toContain(otherCase.marker)
				expect(secondHistory).not.toContain(otherCase.marker)
				expect(secondHistory).not.toContain(otherCase.followUp)
			}
			expect(firstHistory).not.toContain("prompt_cache_breakpoint")
			expect(secondHistory).not.toContain("prompt_cache_breakpoint")
			expect(typeof firstBody.prompt_cache_key).toBe("string")
			expect(secondBody.prompt_cache_key).toBe(firstBody.prompt_cache_key)
			expect(firstRequest.cacheDiagnostic?.state).toBe("cold")
			expect(secondRequest.cacheDiagnostic?.state).toBe("warm")
			expect(secondRequest.cacheDiagnostic?.cacheReadTokens).toBeGreaterThan(
				firstRequest.cacheDiagnostic?.cacheReadTokens ?? 0,
			)
			expect(secondRequest.cacheDiagnostic?.reusablePrefixTokens).toBeGreaterThan(
				(firstRequest.cacheDiagnostic?.totalInputTokens ?? 0) * 0.9,
			)
			expect(secondRequest.cacheDiagnostic?.componentHashes.system).toBe(
				firstRequest.cacheDiagnostic?.componentHashes.system,
			)
			expect(secondRequest.cacheDiagnostic?.componentHashes.tools).toBe(firstRequest.cacheDiagnostic?.componentHashes.tools)
			taskKeys.set(taskCase.marker, String(firstBody.prompt_cache_key))
		}
		expect(new Set(taskKeys.values()).size).toBe(taskCases.length)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Multi-window tasks - sidebar and restored panel run independent conversations concurrently",
	async ({ dlineDocsDir, helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)

		const panelTask = "E2E_MULTI_WINDOW_PANEL_TASK"
		server.resetOpenAiMock()
		server.enqueueResponses("openai-compatible-chat", {
			type: "tool",
			id: "call_multi_window_setup_completion",
			name: "attempt_completion",
			arguments: { result: "E2E_MULTI_WINDOW_PANEL_READY" },
			expectedRequestIncludes: [panelTask],
		})

		const sidebarInput = sidebar.getByTestId("chat-input")
		await sidebarInput.fill(panelTask)
		await sidebar.getByTestId("send-button").click()
		await expect(sidebar.getByText("E2E_MULTI_WINDOW_PANEL_READY", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		const panelTaskIds = (await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
		expect(panelTaskIds).toHaveLength(1)
		const panelTaskId = panelTaskIds[0]
		if (!panelTaskId) throw new Error("Panel task ID was not persisted")

		await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
		await page.getByRole("button", { name: "History", exact: true }).click()
		await E2ETestHelper.dismissWhatsNewModal(sidebar)
		const historyItem = sidebar.locator(".history-item").filter({ hasText: panelTask })
		await expect(historyItem).toHaveCount(1)
		await historyItem.hover()

		const existingFrames = new Set(page.frames())
		await historyItem.getByRole("button", { name: "Open in New Window", exact: true }).click()
		const panel = await findAdditionalDlineFrame(page, existingFrames)
		await E2ETestHelper.dismissWhatsNewModal(panel)
		await expect(panel.getByText(panelTask, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
		await expect(panel.getByTestId("chat-input")).toBeEnabled()
		const restoredSnapshotText = await readFile(path.join(dlineDocsDir, "tasks", panelTaskId, "snapshot.json"), "utf8")
		const restoredSnapshot = JSON.parse(restoredSnapshotText) as {
			interaction?: { interactionId?: string; kind?: string }
			turn?: { blocks?: Array<{ dlineTid?: string; toolName?: string }> }
		}
		const completionBlock = restoredSnapshot.turn?.blocks?.find((block) => block.toolName === "attempt_completion")
		expect(restoredSnapshot.interaction?.kind, restoredSnapshotText).toBe("completion")
		expect(restoredSnapshot.interaction?.interactionId, restoredSnapshotText).toBe(completionBlock?.dlineTid)
		await selectProfile(panel, E2E_PROFILE_NAMES.mockOpenAiResponses)

		await sidebar.getByRole("button", { name: "Done", exact: true }).click()
		const sidebarModelSwitcher = sidebar.getByRole("button", { name: "Select model" })
		await expect(sidebarModelSwitcher).toHaveText(E2E_PROFILE_NAMES.mockOpenAi)
		await expect(panel.getByRole("button", { name: "Select model" })).toHaveText(E2E_PROFILE_NAMES.mockOpenAiResponses)

		const sidebarTask = "E2E_MULTI_WINDOW_SIDEBAR_TASK"
		server.resetOpenAiMock()
		server.enqueueResponses("openai-compatible-chat", {
			type: "tool",
			id: "call_multi_window_sidebar_setup_completion",
			name: "attempt_completion",
			arguments: { result: "E2E_MULTI_WINDOW_SIDEBAR_READY" },
			expectedRequestIncludes: [`<task>\\n${sidebarTask}\\n</task>`],
		})
		const concurrentSidebarInput = sidebar.locator('[data-testid="chat-input"]:visible')
		await concurrentSidebarInput.fill(sidebarTask)
		await sidebar.locator('[data-testid="send-button"]:visible').click()
		await expect(sidebar.getByText("E2E_MULTI_WINDOW_SIDEBAR_READY", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect(sidebarModelSwitcher).toHaveText(E2E_PROFILE_NAMES.mockOpenAi)

		const sidebarTurn = "E2E_MULTI_WINDOW_SIDEBAR_TURN"
		const panelTurn = "E2E_MULTI_WINDOW_PANEL_TURN"
		const responseDelayMs = 3_000
		server.resetOpenAiMock()
		server.enqueueResponses("openai-compatible-chat", {
			type: "tool",
			id: "call_multi_window_sidebar_completion",
			name: "attempt_completion",
			arguments: { result: "E2E_MULTI_WINDOW_SIDEBAR_OK" },
			delayMs: responseDelayMs,
			expectedToolResultCount: 1,
			expectedToolResults: [{ callId: "call_multi_window_sidebar_setup_completion", contentIncludes: sidebarTurn }],
		})
		server.enqueueResponses("openai-compatible-responses", {
			type: "tool",
			id: "call_multi_window_panel_completion",
			name: "attempt_completion",
			arguments: { result: "E2E_MULTI_WINDOW_PANEL_OK" },
			delayMs: responseDelayMs,
			expectedToolResultCount: 1,
			expectedToolResults: [{ callId: "call_multi_window_setup_completion", contentIncludes: panelTurn }],
		})

		const panelInput = panel.locator('[data-testid="chat-input"]:visible')
		await concurrentSidebarInput.fill(sidebarTurn)
		await panelInput.fill(panelTurn)
		await expect(concurrentSidebarInput).toHaveValue(sidebarTurn)
		await expect(panelInput).toHaveValue(panelTurn)
		await dismissExtensionsDisabledNotification(page)
		const submittedAtMs = Date.now()
		await Promise.all([
			sidebar.locator('[data-testid="send-button"]:visible').click(),
			panel.locator('[data-testid="send-button"]:visible').click(),
		])
		await expect(concurrentSidebarInput).toHaveValue("")
		await expect(panelInput).toHaveValue("")

		await Promise.all([
			expect.poll(() => server.getRequestCount("openai-compatible-chat"), { timeout: 10_000 }).toBe(1),
			expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 10_000 }).toBe(1),
		])
		const chatRequest = server.getMockConsumptions("openai-compatible-chat")[0]
		const responsesRequest = server.getMockConsumptions("openai-compatible-responses")[0]
		expect(chatRequest.contractError).toBeUndefined()
		expect(responsesRequest.contractError).toBeUndefined()
		expect(chatRequest.requestToolResults[0]?.content).not.toContain(panelTurn)
		expect(responsesRequest.requestToolResults[0]?.content).not.toContain(sidebarTurn)
		expect(Math.abs(chatRequest.receivedAtMs - responsesRequest.receivedAtMs)).toBeLessThan(responseDelayMs)

		const [sidebarRenderedAtMs, panelRenderedAtMs] = await Promise.all([
			(async () => {
				await expect(sidebar.getByText("E2E_MULTI_WINDOW_SIDEBAR_OK", { exact: false }).last()).toBeVisible({
					timeout: 10_000,
				})
				return Date.now()
			})(),
			(async () => {
				await expect(panel.getByText("E2E_MULTI_WINDOW_PANEL_OK", { exact: false }).last()).toBeVisible({
					timeout: 10_000,
				})
				return Date.now()
			})(),
		])
		expect(sidebarRenderedAtMs - submittedAtMs).toBeLessThan(8_000)
		expect(panelRenderedAtMs - submittedAtMs).toBeLessThan(8_000)
		expect(Math.abs(sidebarRenderedAtMs - panelRenderedAtMs)).toBeLessThan(responseDelayMs)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

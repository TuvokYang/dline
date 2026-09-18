import { readdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { readTaskApiRateMetrics } from "@e2e/utils/read-task-api-rate-metrics"
import { expect, type Frame, type Locator, type Page } from "@playwright/test"
import type { ElectronApplication } from "playwright"

interface StoredProfile {
	name: string
	openai?: {
		streamIdleTimeoutSeconds?: number
	}
}

const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")

async function readProfiles(dlineDir: string): Promise<StoredProfile[]> {
	return JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
}

async function clearResponsesIdleTimeout(dlineDir: string): Promise<void> {
	const profiles = await readProfiles(dlineDir)
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	if (!profile?.openai) throw new Error("Missing OpenAI Responses E2E profile")
	delete profile.openai.streamIdleTimeoutSeconds
	await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")
}

async function selectResponsesProfile(dlineDir: string, enableCheckpoints?: boolean): Promise<void> {
	const settingsPath = path.join(dlineDir, "data", "settings", "settings.json")
	const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>
	settings.actModeProfile = E2E_PROFILE_NAMES.mockOpenAiResponses
	settings.planModeProfile = E2E_PROFILE_NAMES.mockOpenAiResponses
	if (enableCheckpoints !== undefined) settings.enableCheckpointsSetting = enableCheckpoints
	await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

async function configureResponsesIdleTimeout(dlineDir: string): Promise<void> {
	const profiles = await readProfiles(dlineDir)
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	if (!profile?.openai) throw new Error("Missing OpenAI Responses E2E profile")
	profile.openai.streamIdleTimeoutSeconds = 1
	await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")
	await selectResponsesProfile(dlineDir)
}

async function openSidebar(app: ElectronApplication, helper: E2ETestHelper): Promise<Frame> {
	const page = await app.firstWindow()
	await E2ETestHelper.openClineSidebar(page)
	const sidebar = await helper.getSidebar(page)
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	await helper.signin(sidebar)
	return sidebar
}

function escapeForRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function openResponsesProfileEditor(app: ElectronApplication, sidebar: Frame): Promise<Locator> {
	const page = await app.firstWindow()
	await page.getByRole("button", { name: "Settings", exact: true }).click()
	await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible()
	const profileName = E2E_PROFILE_NAMES.mockOpenAiResponses
	const card = sidebar.getByTestId("api-profile-card").filter({
		has: sidebar.getByRole("button", { name: new RegExp(`^(Expand|Collapse) ${escapeForRegExp(profileName)}$`) }),
	})
	await expect(card).toHaveCount(1)
	const expandToggle = card.getByRole("button", { name: /^Expand / })
	if (await expandToggle.isVisible()) await expandToggle.click()
	const providerSelector = card.locator('select[aria-label="Provider"]')
	await expect(providerSelector).toBeVisible()
	return card
}

async function widenWebviewForRateMetrics(sidebar: Frame): Promise<void> {
	await sidebar.evaluate(() => {
		document.documentElement.style.width = "900px"
		document.body.style.width = "900px"
	})
}

async function findAdditionalDlineFrame(page: Page, existingFrames: ReadonlySet<Frame>): Promise<Frame> {
	let resolved: Frame | undefined
	await expect
		.poll(
			async () => {
				for (const frame of page.frames()) {
					if (existingFrames.has(frame) || frame.isDetached() || !frame.url().startsWith("vscode-webview://")) continue
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

async function createDlinePanel(page: Page): Promise<Frame> {
	const existingFrames = new Set(page.frames())
	await page.getByRole("button", { name: "New Task", exact: true }).click()
	return findAdditionalDlineFrame(page, existingFrames)
}

async function activateDlinePanel(tab: Locator, frame: Frame): Promise<void> {
	await tab.click()
	await expect(tab).toHaveClass(/\bactive\b/)
	const frameElement = await frame.frameElement()
	await frameElement.waitForElementState("visible")
	await expect(frame.locator("#root")).toBeVisible()
}

interface StoredRateMetricsRecord {
	schemaVersion?: number
	kind?: string
	taskId?: string
	second?: number
	revision?: number
	signals?: string[]
	requestCount?: number
	effectiveTokens?: number
	tokenQuality?: string
}

interface StoredRateSecondRecord extends StoredRateMetricsRecord {
	kind: "second"
	second: number
	revision: number
	signals: string[]
	requestCount: number
	effectiveTokens: number
	tokenQuality: string
}

interface StoredTaskRateMetrics {
	meta: StoredRateMetricsRecord
	rawSeconds: StoredRateSecondRecord[]
	canonicalSeconds: StoredRateSecondRecord[]
}

interface RateSummary {
	activeSeconds: number
	requestCount: number
	tokenCount: number
	requestsPerMinute: number
	tokensPerMinute: number
	lastMinute: {
		activeSeconds: number
		requestCount: number
		tokenCount: number
		requestsPerMinute: number
		tokensPerMinute: number
		quality: string
	}
}

interface RateTaskCase {
	marker: string
	completion: string
	inputTokens: number
	outputTokens: number
}

function isStoredRateSecondRecord(record: StoredRateMetricsRecord): record is StoredRateSecondRecord {
	return (
		record.kind === "second" &&
		typeof record.second === "number" &&
		typeof record.revision === "number" &&
		Array.isArray(record.signals) &&
		typeof record.requestCount === "number" &&
		typeof record.effectiveTokens === "number" &&
		typeof record.tokenQuality === "string"
	)
}

function foldStoredRateMetrics(records: readonly StoredRateSecondRecord[]): StoredRateSecondRecord[] {
	const canonical = new Map<number, StoredRateSecondRecord>()
	for (const record of records) {
		const current = canonical.get(record.second)
		if (!current || record.revision >= current.revision) canonical.set(record.second, record)
	}
	return [...canonical.values()].sort((left, right) => left.second - right.second)
}

async function readStoredTaskRateMetrics(dlineDocsDir: string, taskId: string): Promise<StoredTaskRateMetrics | undefined> {
	const records = readTaskApiRateMetrics<StoredRateMetricsRecord>(dlineDocsDir, taskId) ?? []
	const meta = records.find((record) => record.kind === "meta")
	const rawSeconds = records.filter(isStoredRateSecondRecord)
	if (!meta || rawSeconds.length === 0) return undefined
	return { meta, rawSeconds, canonicalSeconds: foldStoredRateMetrics(rawSeconds) }
}

async function findTaskIdsByMarker(dlineDocsDir: string, markers: readonly string[]): Promise<Map<string, string>> {
	const markerSet = new Set(markers)
	const taskIdsByMarker = new Map<string, string>()
	const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true }).catch(() => [])
	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		const messages = await readFile(path.join(dlineDocsDir, "tasks", entry.name, "ui_messages.jsonl"), "utf8").catch(() => "")
		for (const line of messages.split(/\r?\n/)) {
			if (!line) continue
			const message = JSON.parse(line) as { type?: unknown; say?: unknown; text?: unknown }
			if (
				message.type === "say" &&
				message.say === "task" &&
				typeof message.text === "string" &&
				markerSet.has(message.text)
			) {
				taskIdsByMarker.set(message.text, entry.name)
				break
			}
		}
	}
	return taskIdsByMarker
}

function extrapolatePerMinute(count: number, activeSeconds: number): number {
	return activeSeconds === 0 ? 0 : Math.round((count * 60) / activeSeconds)
}

function summarizeStoredActivity(records: readonly StoredRateSecondRecord[]): {
	activeSeconds: number
	providerActiveSeconds: number
} {
	return records.reduce(
		(total, record) => {
			const taskActive = record.signals.includes("task_active")
			const providerActive = record.signals.includes("provider_active")
			const legacyActive = !taskActive && !providerActive
			return {
				activeSeconds: total.activeSeconds + (taskActive || legacyActive ? 1 : 0),
				providerActiveSeconds: total.providerActiveSeconds + (providerActive || legacyActive ? 1 : 0),
			}
		},
		{ activeSeconds: 0, providerActiveSeconds: 0 },
	)
}

function formatStoredQuality(records: readonly StoredRateSecondRecord[]): string {
	const qualities = new Set(records.filter((record) => record.effectiveTokens > 0).map((record) => record.tokenQuality))
	if (qualities.size !== 1) return "Mixed"
	const quality = records[0]?.tokenQuality
	return quality === "exact" ? "Exact" : quality === "mixed" ? "Mixed" : "Estimated"
}

function summarizeStoredRateMetrics(records: readonly StoredRateSecondRecord[]): RateSummary {
	const activity = summarizeStoredActivity(records)
	const requestCount = records.reduce((total, record) => total + record.requestCount, 0)
	const tokenCount = records.reduce((total, record) => total + record.effectiveTokens, 0)
	const lastSecond = records.at(-1)?.second
	if (lastSecond === undefined) throw new Error("Expected at least one canonical API rate second")
	const lastMinuteStart = Math.floor(lastSecond / 60) * 60
	const lastMinuteRecords = records.filter((record) => record.second >= lastMinuteStart && record.second < lastMinuteStart + 60)
	const lastMinuteActivity = summarizeStoredActivity(lastMinuteRecords)
	const lastMinuteRequestCount = lastMinuteRecords.reduce((total, record) => total + record.requestCount, 0)
	const lastMinuteTokenCount = lastMinuteRecords.reduce((total, record) => total + record.effectiveTokens, 0)
	return {
		activeSeconds: activity.activeSeconds,
		requestCount,
		tokenCount,
		requestsPerMinute: extrapolatePerMinute(requestCount, activity.activeSeconds),
		tokensPerMinute: extrapolatePerMinute(tokenCount, activity.providerActiveSeconds),
		lastMinute: {
			activeSeconds: lastMinuteActivity.activeSeconds,
			requestCount: lastMinuteRequestCount,
			tokenCount: lastMinuteTokenCount,
			requestsPerMinute: extrapolatePerMinute(lastMinuteRequestCount, lastMinuteActivity.activeSeconds),
			tokensPerMinute: extrapolatePerMinute(lastMinuteTokenCount, lastMinuteActivity.providerActiveSeconds),
			quality: formatStoredQuality(lastMinuteRecords),
		},
	}
}

async function expectRateMetricsDialog(frame: Frame, summary: RateSummary, exerciseResolutions: boolean): Promise<void> {
	const rate = frame.getByTestId("task-rate-metrics")
	await expect(rate).toHaveAttribute("aria-label", /(?:^|; )RPM: [1-9]\d*(?:;|$)/, { timeout: 30_000 })
	const ariaLabel = await rate.getAttribute("aria-label")
	expect(ariaLabel).toContain("View API rate history")
	expect(ariaLabel).toMatch(/(?:^|; )RPM: [1-9]\d*(?:;|$)/)
	expect(ariaLabel).toContain(`TPM: ${summary.tokensPerMinute}`)
	expect(ariaLabel).not.toContain("Request")
	await rate.click()
	const dialog = frame.getByRole("dialog")
	await expect(dialog.getByRole("heading", { name: "API Rate History", exact: true })).toBeVisible()
	const resolutionSelect = dialog.getByRole("combobox", { name: "History resolution", exact: true })
	await expect(resolutionSelect).toHaveValue("hour")
	await expect(dialog.getByRole("radio", { name: "Token/Cache", exact: true })).toHaveAttribute("aria-checked", "true")
	const chart = dialog.getByRole("img", { name: "Task metrics history chart", exact: true })
	await expect(chart).toBeVisible({ timeout: 30_000 })
	await expect(chart).toHaveAttribute("data-view", "tokenCache")
	await expect(chart).toHaveAttribute("data-chart-type", "line")

	await dialog.getByRole("radio", { name: "TPM/RPM", exact: true }).click()
	await expect(chart).toHaveAttribute("data-view", "rates")
	await dialog.getByRole("radio", { name: "Bar", exact: true }).click()
	await expect(chart).toHaveAttribute("data-chart-type", "bar")
	await expect(dialog.locator('[data-testid^="task-metrics-bar-tpm-"]').last()).toBeVisible()
	await expect(dialog.getByRole("button", { name: "TPM", exact: true })).toHaveAttribute("aria-pressed", "true")
	await expect(dialog.getByRole("button", { name: "RPM", exact: true })).toHaveAttribute("aria-pressed", "true")

	await dialog.getByRole("radio", { name: "Line", exact: true }).click()
	await expect(chart).toHaveAttribute("data-chart-type", "line")
	await expect(dialog.locator('[data-testid^="task-metrics-point-tpm-"]').last()).toBeVisible()

	if (exerciseResolutions) {
		for (const resolution of ["hour", "day", "minute"] as const) {
			await resolutionSelect.selectOption(resolution)
			await expect(resolutionSelect).toHaveValue(resolution)
			await expect(dialog.getByRole("img", { name: "Task metrics history chart", exact: true })).toBeVisible({
				timeout: 30_000,
			})
		}
	}
	await dialog.getByRole("button", { name: "Close", exact: true }).click()
	await expect(dialog).not.toBeVisible()
}

e2e(
	"OpenAI Responses stream idle timeout defaults to 120 seconds and persists after reopening VS Code",
	async ({ dlineDir, helper, openVSCode, userDataDir, workspaceDir }) => {
		e2e.setTimeout(150_000)
		await clearResponsesIdleTimeout(dlineDir)
		let firstApp: ElectronApplication | undefined
		let reopenedApp: ElectronApplication | undefined

		try {
			firstApp = await openVSCode(workspaceDir)
			const firstSidebar = await openSidebar(firstApp, helper)
			const firstCard = await openResponsesProfileEditor(firstApp, firstSidebar)
			const firstTimeoutField = firstCard.getByRole("textbox", {
				name: "Responses stream idle timeout (seconds)",
			})
			await expect(firstTimeoutField).toHaveValue("120")
			await firstTimeoutField.fill("45")
			await firstTimeoutField.press("Tab")
			await E2ETestHelper.waitUntil(async () => {
				const profile = (await readProfiles(dlineDir)).find(
					(candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiResponses,
				)
				return profile?.openai?.streamIdleTimeoutSeconds === 45
			})

			await firstApp.close()
			firstApp = undefined
			helper.clearCachedFrame()

			reopenedApp = await openVSCode(workspaceDir)
			const reopenedSidebar = await openSidebar(reopenedApp, helper)
			const reopenedCard = await openResponsesProfileEditor(reopenedApp, reopenedSidebar)
			await expect(reopenedCard.getByRole("textbox", { name: "Responses stream idle timeout (seconds)" })).toHaveValue("45")
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await reopenedApp?.close()
			await firstApp?.close()
		}
	},
)

e2e(
	"Task API rate history persists active seconds, isolates four concurrent tasks, and restores trend queries",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(300_000)
		await selectResponsesProfile(dlineDir, false)
		const responseDelayMs = 8_000
		const taskCases: RateTaskCase[] = [
			{ marker: "E2E_RATE_SIDEBAR", completion: "E2E_RATE_SIDEBAR_DONE", inputTokens: 1_000, outputTokens: 110 },
			{ marker: "E2E_RATE_PANEL_A", completion: "E2E_RATE_PANEL_A_DONE", inputTokens: 2_000, outputTokens: 220 },
			{ marker: "E2E_RATE_PANEL_B", completion: "E2E_RATE_PANEL_B_DONE", inputTokens: 3_000, outputTokens: 330 },
			{ marker: "E2E_RATE_PANEL_C", completion: "E2E_RATE_PANEL_C_DONE", inputTokens: 4_000, outputTokens: 440 },
		]
		server.resetOpenAiMock()
		for (const [index, taskCase] of taskCases.entries()) {
			server.enqueueResponses("openai-compatible-responses", {
				type: "tool",
				id: `call_rate_metrics_${index}`,
				name: "attempt_completion",
				arguments: { result: taskCase.completion },
				delayMs: responseDelayMs,
				expectedRequestIncludes: [`<task>\\n${taskCase.marker}\\n</task>`],
				matchRequestContract: true,
				usage: { inputTokens: taskCase.inputTokens, outputTokens: taskCase.outputTokens, reasoningTokens: 0 },
			})
		}

		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			const sidebar = await openSidebar(app, helper)
			await widenWebviewForRateMetrics(sidebar)
			const editorFrames: Frame[] = []
			for (let index = 0; index < 3; index++) {
				const frame = await createDlinePanel(page)
				await E2ETestHelper.dismissWhatsNewModal(frame)
				await widenWebviewForRateMetrics(frame)
				editorFrames.push(frame)
			}
			const panelTabs = page.locator(".editor-group-container").first().locator(".tabs-container > .tab")
			await expect(panelTabs).toHaveCount(3)
			const taskSurfaces = [
				{ taskCase: taskCases[0], frame: sidebar },
				...editorFrames.map((frame, index) => ({ taskCase: taskCases[index + 1], frame, tab: panelTabs.nth(index) })),
			]

			for (const surface of taskSurfaces.slice(1)) {
				if (!surface.taskCase || !surface.tab) throw new Error("Missing editor rate metrics Task surface")
				await activateDlinePanel(surface.tab, surface.frame)
				const input = surface.frame.locator('[data-testid="chat-input"]:visible')
				await input.fill(surface.taskCase.marker)
				await input.press("Enter")
				await expect(input).toHaveValue("")
			}
			const sidebarCase = taskCases[0]
			if (!sidebarCase) throw new Error("Missing sidebar rate metrics Task case")
			const sidebarInput = sidebar.locator('[data-testid="chat-input"]:visible')
			await sidebarInput.fill(sidebarCase.marker)
			await sidebarInput.press("Enter")
			await expect(sidebarInput).toHaveValue("")

			await expect.poll(() => server.getMockConsumptions("openai-compatible-responses").length, { timeout: 20_000 }).toBe(4)
			const receivedAt = server
				.getMockConsumptions("openai-compatible-responses")
				.map((consumption) => consumption.receivedAtMs)
			expect(Math.max(...receivedAt) - Math.min(...receivedAt)).toBeLessThan(responseDelayMs)

			for (const surface of taskSurfaces.slice(1)) {
				if (!surface.taskCase || !surface.tab) throw new Error("Missing editor rate metrics completion surface")
				await activateDlinePanel(surface.tab, surface.frame)
				await expect(surface.frame.getByText(surface.taskCase.completion, { exact: false }).last()).toBeVisible({
					timeout: 60_000,
				})
			}
			await expect(sidebar.getByText(sidebarCase.completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			const consumptions = server.getMockConsumptions("openai-compatible-responses")
			expect(consumptions).toHaveLength(4)
			expect(consumptions.every((consumption) => consumption.contractError === undefined)).toBe(true)

			const taskIdsByMarker = await E2ETestHelper.waitForValue(async () => {
				const mapping = await findTaskIdsByMarker(
					dlineDocsDir,
					taskCases.map((taskCase) => taskCase.marker),
				)
				return mapping.size === taskCases.length ? mapping : undefined
			}, 30_000)
			expect(new Set(taskIdsByMarker.values()).size).toBe(taskCases.length)

			const summaries = new Map<string, RateSummary>()
			for (const taskCase of taskCases) {
				const taskId = taskIdsByMarker.get(taskCase.marker)
				if (!taskId) throw new Error(`Missing persisted Task ID for ${taskCase.marker}`)
				const expectedTokens = taskCase.inputTokens + taskCase.outputTokens
				const stored = await E2ETestHelper.waitForValue(async () => {
					const candidate = await readStoredTaskRateMetrics(dlineDocsDir, taskId)
					if (!candidate) return undefined
					const tokenCount = candidate.canonicalSeconds.reduce((total, record) => total + record.effectiveTokens, 0)
					return tokenCount === expectedTokens ? candidate : undefined
				}, 30_000)
				expect(stored.meta).toMatchObject({ schemaVersion: 1, kind: "meta", taskId })
				expect(stored.rawSeconds.every((record) => record.signals.length > 0)).toBe(true)
				expect(stored.rawSeconds.some((record) => record.revision > 0)).toBe(true)
				expect(stored.canonicalSeconds.reduce((total, record) => total + record.requestCount, 0)).toBe(1)
				expect(stored.canonicalSeconds.reduce((total, record) => total + record.effectiveTokens, 0)).toBe(expectedTokens)
				expect(stored.canonicalSeconds.every((record) => record.signals.some((signal) => signal !== "task_active"))).toBe(
					true,
				)
				summaries.set(taskCase.marker, summarizeStoredRateMetrics(stored.canonicalSeconds))
			}

			for (const [index, surface] of taskSurfaces.entries()) {
				if (!surface.taskCase) throw new Error("Missing rate metrics Task surface")
				if (surface.tab) await activateDlinePanel(surface.tab, surface.frame)
				const summary = summaries.get(surface.taskCase.marker)
				if (!summary) throw new Error(`Missing rate metrics summary for ${surface.taskCase.marker}`)
				await expectRateMetricsDialog(surface.frame, summary, index === 0)
			}

			const sidebarSummary = summaries.get(sidebarCase.marker)
			if (!sidebarSummary) throw new Error("Missing sidebar rate metrics summary")
			await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
			await expect(sidebar.getByTestId("chat-input")).toBeVisible()
			await page.getByRole("button", { name: "History", exact: true }).click()
			await E2ETestHelper.dismissWhatsNewModal(sidebar)
			const historyTask = sidebar.locator(".history-item").filter({ hasText: sidebarCase.marker })
			await expect(historyTask).toHaveCount(1)
			await historyTask.click()
			await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
			await expect(sidebar.getByText(sidebarCase.marker, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
			await widenWebviewForRateMetrics(sidebar)
			await expectRateMetricsDialog(sidebar, sidebarSummary, false)
			expect(server.getMockConsumptions("openai-compatible-responses")).toHaveLength(4)

			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"OpenAI Responses idle timeout aborts, retries, and exposes TaskHeader RPM/TPM",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(150_000)
		await configureResponsesIdleTimeout(dlineDir)
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "message",
				text: "THIS_RESPONSE_MUST_BE_ABORTED",
				reasoning: "E2E_STREAM_IDLE_REASONING",
				afterReasoningDelayMs: 2_500,
				usage: { inputTokens: 1_000, outputTokens: 200, reasoningTokens: 100 },
			},
			{
				type: "tool",
				name: "attempt_completion",
				arguments: { result: "E2E_STREAM_IDLE_RETRY_OK" },
				usage: { inputTokens: 1_200, outputTokens: 300, reasoningTokens: 120 },
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const sidebar = await openSidebar(app, helper)
			await widenWebviewForRateMetrics(sidebar)
			const input = sidebar.getByTestId("chat-input")
			await input.fill("Exercise OpenAI Responses stream idle recovery.")
			await input.press("Enter")

			await expect(sidebar.getByText("E2E_STREAM_IDLE_REASONING", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expect(sidebar.getByText("E2E_STREAM_IDLE_RETRY_OK", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expect(sidebar.getByText("THIS_RESPONSE_MUST_BE_ABORTED", { exact: false })).toHaveCount(0)

			const consumptions = server.getMockConsumptions("openai-compatible-responses")
			expect(consumptions).toHaveLength(2)
			expect(consumptions[0].abortedAtMs).toBeDefined()
			expect(consumptions[1].contractError).toBeUndefined()

			const rate = sidebar.getByTestId("task-rate-metrics")
			await expect(rate).toBeVisible()
			await expect(rate).toContainText(/RPM:[1-9]/)
			await expect(rate).toContainText(/TPM:[1-9]/)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [
				/OpenAI Responses stream received no event for 1 seconds/,
			])
		} finally {
			await app.close()
		}
	},
)

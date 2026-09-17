import { readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { seedTaskStatistics } from "@e2e/utils/seed-task-statistics"
import { expect, type Frame, type Locator, type TestInfo } from "@playwright/test"
import type { ElectronApplication } from "playwright"

const TASK_TEXT = "E2E_TASK_STATISTICS_CHART"
const COMPLETION_TEXT = "E2E_TASK_STATISTICS_CHART_READY"
const GRPC_METHOD = "getTaskRateMetrics"
const HOUR_MS = 60 * 60 * 1_000

interface GrpcLogEntry {
	service?: string
	method?: string
	status?: string
}

interface GrpcSessionLog {
	entries?: GrpcLogEntry[]
}

interface StoredProfile {
	name: string
	webToolsMode?: string
}

e2e.use({ grpcRecorderEnabled: true })

async function configureProfileBeforeLaunch(dlineDir: string): Promise<void> {
	const settingsDirectory = path.join(dlineDir, "data", "settings")
	const profilesPath = path.join(settingsDirectory, "api_profiles.json")
	const profiles = JSON.parse(await readFile(profilesPath, "utf8")) as StoredProfile[]
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	if (!profile) throw new Error(`Missing Task statistics E2E profile: ${E2E_PROFILE_NAMES.mockOpenAiResponses}`)
	profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	await writeFile(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

	const settingsPath = path.join(settingsDirectory, "settings.json")
	const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>
	settings.actModeProfile = E2E_PROFILE_NAMES.mockOpenAiResponses
	settings.planModeProfile = E2E_PROFILE_NAMES.mockOpenAiResponses
	settings.clineWebToolsEnabled = false
	await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

async function openSidebar(app: ElectronApplication, helper: E2ETestHelper): Promise<Frame> {
	const page = await app.firstWindow()
	await E2ETestHelper.openClineSidebar(page)
	const sidebar = await helper.getSidebar(page)
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	await helper.signin(sidebar)
	await sidebar.evaluate(() => {
		document.documentElement.style.width = "1100px"
		document.body.style.width = "1100px"
	})
	return sidebar
}

async function onlyTaskId(dlineDocsDir: string): Promise<string> {
	return E2ETestHelper.waitForValue(async () => {
		const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true }).catch(() => [])
		const taskIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
		return taskIds.length === 1 ? taskIds[0] : undefined
	}, 30_000)
}

async function closeCurrentTask(sidebar: Frame): Promise<void> {
	const closeButton = sidebar.getByRole("button", { name: "Close Task", exact: true })
	await expect(closeButton).toBeVisible()
	await closeButton.click()
	await expect(sidebar.getByTestId("chat-input")).toHaveAttribute("placeholder", "Type your task here...")
}

async function reopenTaskFromHistory(app: ElectronApplication, sidebar: Frame): Promise<void> {
	const page = await app.firstWindow()
	await page.getByRole("button", { name: "History", exact: true }).click()
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	const historyTask = sidebar.locator(".history-item").filter({ hasText: TASK_TEXT })
	await expect(historyTask).toHaveCount(1)
	await historyTask.click()
	await expect(sidebar.getByText(TASK_TEXT, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
	await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
}

function grpcLogPath(testInfo: TestInfo): string {
	const fileName = E2ETestHelper.generateTestFileName(testInfo.title, testInfo.project.name)
	return path.join(E2ETestHelper.CODEBASE_ROOT_DIR, "tests", "specs", `grpc_recorded_session_${fileName}.json`)
}

async function readRateMetricsRpcCount(logPath: string): Promise<number | undefined> {
	const raw = await readFile(logPath, "utf8").catch(() => undefined)
	if (!raw) return 0
	try {
		const session = JSON.parse(raw) as GrpcSessionLog
		return (session.entries ?? []).filter(
			(entry) => entry.service === "dline.TaskService" && entry.method === GRPC_METHOD && entry.status === "completed",
		).length
	} catch (error) {
		if (error instanceof SyntaxError) return undefined
		throw error
	}
}

async function waitForRateMetricsRpcCount(logPath: string, expected: number): Promise<void> {
	await expect.poll(() => readRateMetricsRpcCount(logPath), { timeout: 30_000 }).toBe(expected)
}

async function captureDialog(dialog: Locator, testInfo: TestInfo, fileName: string): Promise<void> {
	const screenshotPath = testInfo.outputPath(fileName)
	await dialog.screenshot({ animations: "disabled", path: screenshotPath })
	await testInfo.attach(fileName, { path: screenshotPath, contentType: "image/png" })
}

async function expectTooltipWithinDialog(dialog: Locator, tooltip: Locator): Promise<void> {
	await expect
		.poll(async () => {
			const [dialogBox, tooltipBox] = await Promise.all([dialog.boundingBox(), tooltip.boundingBox()])
			if (!dialogBox || !tooltipBox) return false
			return (
				tooltipBox.x >= dialogBox.x &&
				tooltipBox.y >= dialogBox.y &&
				tooltipBox.x + tooltipBox.width <= dialogBox.x + dialogBox.width &&
				tooltipBox.y + tooltipBox.height <= dialogBox.y + dialogBox.height
			)
		})
		.toBe(true)
}

async function expectToolbarControlsWithinDialog(dialog: Locator): Promise<void> {
	const toolbar = dialog.getByRole("toolbar", { name: "Task metrics controls" })
	await expect(toolbar).toHaveCSS("flex-wrap", "wrap")
	await expect
		.poll(async () => {
			const geometry = await toolbar.evaluate((element) => ({
				clientHeight: element.clientHeight,
				clientWidth: element.clientWidth,
				scrollHeight: element.scrollHeight,
				scrollWidth: element.scrollWidth,
			}))
			return { ...geometry, fitsHorizontally: geometry.scrollWidth <= geometry.clientWidth }
		})
		.toMatchObject({ fitsHorizontally: true })
	for (const control of [
		dialog.getByRole("combobox", { name: "History resolution", exact: true }),
		dialog.getByRole("radio", { name: "Token/Cache", exact: true }),
		dialog.getByRole("radio", { name: "TPM/RPM", exact: true }),
		dialog.getByRole("radio", { name: "Bar", exact: true }),
		dialog.getByRole("radio", { name: "Line", exact: true }),
		dialog.getByRole("button", { name: "Refresh", exact: true }),
	]) {
		await expect(control).toBeVisible()
		await expect
			.poll(async () => {
				const [dialogBox, controlBox] = await Promise.all([dialog.boundingBox(), control.boundingBox()])
				if (!dialogBox || !controlBox) return false
				return controlBox.x >= dialogBox.x && controlBox.x + controlBox.width <= dialogBox.x + dialogBox.width
			})
			.toBe(true)
	}
}

async function assertDefaultTokenCacheChart(dialog: Locator): Promise<void> {
	const toolbar = dialog.getByRole("toolbar", { name: "Task metrics controls" })
	await expect(toolbar).toBeVisible()
	const resolution = dialog.getByRole("combobox", { name: "History resolution", exact: true })
	await expect(resolution).toHaveValue("hour")
	await expect(resolution).toHaveCSS("text-align-last", "center")
	await expect(dialog.getByRole("option", { name: "Round", exact: true })).toHaveCount(0)
	await expect(dialog.getByRole("radio", { name: "Token/Cache", exact: true })).toHaveAttribute("aria-checked", "true")
	await expect(dialog.getByRole("radio", { name: "Line", exact: true })).toHaveAttribute("aria-checked", "true")
	await expectToolbarControlsWithinDialog(dialog)

	const chart = dialog.getByRole("img", { name: "Task metrics history chart", exact: true })
	await expect(chart).toBeVisible({ timeout: 30_000 })
	await expect(chart).toHaveAttribute("data-view", "tokenCache")
	await expect(chart).toHaveAttribute("data-chart-type", "line")
	for (const [label, enabled] of [
		["Input", true],
		["Output", true],
		["Cache Read", true],
		["Cache Hit Rate", true],
		["Total Tokens", false],
	] as const) {
		await expect(dialog.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", String(enabled))
	}
	await expect(dialog.getByTestId("task-metrics-percentage-tick")).toHaveText(["0%", "20%", "40%", "60%", "80%", "100%"])
	await expect(dialog.locator('[data-testid^="task-metrics-focus-anchor-"]')).toHaveCount(24)
	const inputPoints = dialog.locator('[data-testid^="task-metrics-point-input-"]')
	await expect(inputPoints).toHaveCount(24)
	await expect(inputPoints.first()).toHaveAttribute("data-value", "0")
	await expect(inputPoints.first()).toHaveAttribute("cx", "62")
	await expect(inputPoints.last()).toHaveAttribute("data-value", "0")
	await expect(inputPoints.last()).toHaveAttribute("cx", "666")

	for (const [key, color] of [
		["input", "--vscode-charts-blue"],
		["output", "--vscode-charts-green"],
		["cacheRead", "--vscode-charts-cyan"],
	] as const) {
		const line = dialog.locator(`[data-testid^="task-metrics-line-${key}-"]`).first()
		await expect(line).toBeVisible()
		await expect(line).toHaveAttribute("stroke", new RegExp(color))
		await expect(line).not.toHaveAttribute("stroke-dasharray")
	}
	await expect(dialog.getByRole("button", { name: "Cache Write", exact: true })).toHaveCount(0)
	await expect(dialog.locator('[data-testid^="task-metrics-line-cacheWrite-"]')).toHaveCount(0)
	const cacheHitLine = dialog.locator('[data-testid^="task-metrics-line-cacheHit-"]').first()
	await expect(cacheHitLine).toBeVisible()
	await expect(cacheHitLine).toHaveAttribute("stroke", /--vscode-charts-purple/)
	await expect(cacheHitLine).toHaveAttribute("stroke-dasharray", "6 4")
	await expect(dialog.getByTestId("task-metrics-point-cacheHit-0")).toHaveAttribute("data-value", "0")
}

e2e(
	"Task statistics chart renders compact dual views, accessible legends, smooth lines, and contained tooltips",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		const testInfo = e2e.info()
		const recorderPath = grpcLogPath(testInfo)
		await rm(recorderPath, { force: true })
		await configureProfileBeforeLaunch(dlineDir)
		server.resetOpenAiMock()
		server.enqueueResponses("openai-compatible-responses", {
			type: "tool",
			id: "call_task_statistics_ready",
			name: "attempt_completion",
			arguments: { result: COMPLETION_TEXT },
			usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 0 },
		})

		let app: ElectronApplication | undefined
		let reopenedApp: ElectronApplication | undefined
		try {
			app = await openVSCode(workspaceDir)
			let sidebar = await openSidebar(app, helper)
			const input = sidebar.getByTestId("chat-input")
			await input.fill(TASK_TEXT)
			await input.press("Enter")
			await expect(sidebar.getByText(COMPLETION_TEXT, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			expect(server.getMockConsumptions("openai-compatible-responses")).toHaveLength(1)
			expect(server.getMockConsumptions("openai-compatible-responses")[0]?.contractError).toBeUndefined()

			const taskId = await onlyTaskId(dlineDocsDir)
			await closeCurrentTask(sidebar)
			await app.close()
			app = undefined
			helper.clearCachedFrame()

			const seeded = await seedTaskStatistics(dlineDocsDir, taskId)
			reopenedApp = await openVSCode(workspaceDir)
			sidebar = await openSidebar(reopenedApp, helper)
			await reopenTaskFromHistory(reopenedApp, sidebar)

			const rate = sidebar.getByTestId("task-rate-metrics")
			await expect(rate).toBeVisible({ timeout: 30_000 })
			await expect(rate).toHaveAttribute("aria-label", new RegExp(`(?:^|; )RPM: ${seeded.expectedHeaderRpm}(?:;|$)`))
			await expect(rate).toHaveAttribute("aria-label", new RegExp(`Hit: ${seeded.expectedCacheHitPercent.toFixed(1)}%`))
			await expect(rate).not.toHaveAttribute("aria-label", /Request/)
			expect(server.getMockConsumptions("openai-compatible-responses")).toHaveLength(1)
			await waitForRateMetricsRpcCount(recorderPath, 0)

			const taskHeaderToggle = sidebar.locator('[aria-label="Expand task header"], [aria-label="Collapse task header"]')
			await expect(taskHeaderToggle).toHaveCount(1)
			const initialHeaderLabel = await taskHeaderToggle.getAttribute("aria-label")
			if (!initialHeaderLabel) throw new Error("Expected the Task header expansion label before opening rate history")
			await rate.click()
			const dialog = sidebar.getByRole("dialog")
			await expect(dialog.getByRole("heading", { name: "API Rate History", exact: true })).toBeVisible()
			await assertDefaultTokenCacheChart(dialog)
			await expect(taskHeaderToggle).toHaveAttribute("aria-label", initialHeaderLabel)
			await waitForRateMetricsRpcCount(recorderPath, 1)
			await captureDialog(dialog, testInfo, "task-statistics-hour-token-cache-line.png")

			const activeHourStarts = seeded.completedAtMs.map((completedAtMs) => Math.floor(completedAtMs / HOUR_MS) * HOUR_MS)
			const secondInputPoint = dialog.locator(
				`[data-testid^="task-metrics-point-input-"][data-bucket-start-ms="${activeHourStarts[1]}"]`,
			)
			await secondInputPoint.hover()
			let tooltip = sidebar.getByRole("tooltip")
			await expect(tooltip).toContainText("Input: 800")
			await expect(tooltip).toContainText("Output: 300")
			await expect(tooltip).not.toContainText("Cache Write")
			await expect(tooltip).toContainText("Cache Read: 400")
			await expect(tooltip).toContainText("Cache Hit Rate: 33.3%")
			await expect(tooltip).toContainText("History: Complete")
			await expect(tooltip).not.toContainText(/Round|Request|API index|Provider attempt/i)
			await expectTooltipWithinDialog(dialog, tooltip)
			await captureDialog(dialog, testInfo, "task-statistics-hour-token-cache-hover-tooltip.png")

			await dialog
				.locator(`[data-testid^="task-metrics-focus-anchor-"][data-bucket-start-ms="${activeHourStarts[2]}"]`)
				.focus()
			tooltip = sidebar.getByRole("tooltip")
			await expect(tooltip).toContainText("Input: 1,600")
			await expect(tooltip).toContainText("Cache Hit Rate: 33.3%")
			await expectTooltipWithinDialog(dialog, tooltip)
			await captureDialog(dialog, testInfo, "task-statistics-hour-token-cache-focus-tooltip.png")

			const totalTokensLegend = dialog.getByRole("button", { name: "Total Tokens", exact: true })
			await totalTokensLegend.focus()
			await totalTokensLegend.press("Space")
			await expect(totalTokensLegend).toHaveAttribute("aria-pressed", "true")
			await expect(dialog.locator('[data-testid^="task-metrics-line-totalTokens-"]').first()).toBeVisible()
			await waitForRateMetricsRpcCount(recorderPath, 1)
			await captureDialog(dialog, testInfo, "task-statistics-hour-token-cache-total-enabled.png")

			const inputLegend = dialog.getByRole("button", { name: "Input", exact: true })
			await inputLegend.click()
			await expect(inputLegend).toHaveAttribute("aria-pressed", "false")
			await expect(dialog.locator('[data-testid^="task-metrics-line-input-"]')).toHaveCount(0)
			await waitForRateMetricsRpcCount(recorderPath, 1)
			await inputLegend.click()
			await expect(inputLegend).toHaveAttribute("aria-pressed", "true")

			await dialog.getByRole("radio", { name: "TPM/RPM", exact: true }).click()
			const chart = dialog.getByRole("img", { name: "Task metrics history chart", exact: true })
			await expect(chart).toHaveAttribute("data-view", "rates")
			await expect(chart).toHaveAttribute("data-chart-type", "line")
			await expect(dialog.locator('[data-testid^="task-metrics-line-tpm-"]').first()).toBeVisible()
			await expect(dialog.locator('[data-testid^="task-metrics-line-rpm-"]').first()).toBeVisible()
			await waitForRateMetricsRpcCount(recorderPath, 1)
			await captureDialog(dialog, testInfo, "task-statistics-hour-tpm-rpm-line.png")

			await dialog.getByRole("radio", { name: "Bar", exact: true }).click()
			await expect(chart).toHaveAttribute("data-chart-type", "bar")
			await expect(dialog.locator('[data-testid^="task-metrics-bar-tpm-"]:not([height="0"])').first()).toBeVisible()
			await expect(dialog.locator('[data-testid^="task-metrics-bar-rpm-"]:not([height="0"])').first()).toBeVisible()
			await waitForRateMetricsRpcCount(recorderPath, 1)
			await captureDialog(dialog, testInfo, "task-statistics-hour-tpm-rpm-bar.png")

			const resolution = dialog.getByRole("combobox", { name: "History resolution", exact: true })
			await resolution.selectOption("minute")
			await waitForRateMetricsRpcCount(recorderPath, 2)
			await expect(resolution).toHaveValue("minute")
			await expect(dialog.getByRole("img", { name: "Task metrics history chart", exact: true })).toBeVisible()
			await expect(dialog.locator('[data-testid^="task-metrics-bar-tpm-"]:not([height="0"])').first()).toBeVisible()
			await resolution.selectOption("day")
			await waitForRateMetricsRpcCount(recorderPath, 3)
			await expect(dialog.locator('[data-testid^="task-metrics-focus-anchor-"]')).toHaveCount(30)
			expect(server.getMockConsumptions("openai-compatible-responses")).toHaveLength(1)

			await dialog.getByRole("button", { name: "Refresh", exact: true }).click()
			await waitForRateMetricsRpcCount(recorderPath, 4)
			expect(server.getMockConsumptions("openai-compatible-responses")).toHaveLength(1)

			await dialog.getByRole("button", { name: "Close", exact: true }).click()
			await expect(dialog).toHaveCount(0)
			await expect(taskHeaderToggle).toHaveAttribute("aria-label", initialHeaderLabel)

			const recorderEvidence = await readFile(recorderPath)
			await testInfo.attach("task-statistics-grpc-recording.json", {
				body: recorderEvidence,
				contentType: "application/json",
			})
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await reopenedApp?.close()
			await app?.close()
			await rm(recorderPath, { force: true })
		}
	},
)

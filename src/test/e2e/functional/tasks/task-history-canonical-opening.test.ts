import { copyFile, mkdir, readFile } from "node:fs/promises"
import * as path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Page } from "@playwright/test"

const TASK_ID = "1790708947870"
const TASK_TEXT = "E2E_HISTORY_TASK_1790708947870"
const BODY_MARKER = "E2E_HISTORY_1790708947870_CURRENT_OPENING_BODY"
const FAULT_MARKER = "history-1790708947870-first-opening"
const WATCHER_READY_DELAY_MS = 5_000
const FIXTURE_DIRECTORY = path.join(
	E2ETestHelper.CODEBASE_ROOT_DIR,
	"src",
	"test",
	"e2e",
	"fixtures",
	"history-task-1790708947870",
)

const delayedFirstMessageWindow = JSON.stringify({
	action: "delayEmptyFetchMessage",
	service: "dline.TaskService",
	method: "fetchMessage",
	occurrence: 1,
	delayMs: 2_500,
	markerName: FAULT_MARKER,
})

async function seedStaticHistoryFixture(dlineDocsDir: string): Promise<void> {
	const tasksDirectory = path.join(dlineDocsDir, "tasks")
	const taskDirectory = path.join(tasksDirectory, TASK_ID)
	await mkdir(taskDirectory, { recursive: true })
	await Promise.all([
		copyFile(path.join(FIXTURE_DIRECTORY, "taskHistory.jsonl"), path.join(tasksDirectory, "taskHistory.jsonl")),
		copyFile(path.join(FIXTURE_DIRECTORY, "ui_messages.jsonl"), path.join(taskDirectory, "ui_messages.jsonl")),
		copyFile(
			path.join(FIXTURE_DIRECTORY, "api_conversation_history.jsonl"),
			path.join(taskDirectory, "api_conversation_history.jsonl"),
		),
	])
}

async function openHistoryTask(page: Page, sidebar: Frame): Promise<void> {
	await page.getByRole("button", { name: "History", exact: true }).click()
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	const allTasks = sidebar.getByRole("button", { name: "All", exact: true })
	if (await allTasks.isVisible()) await allTasks.click()
	const historyTask = sidebar.locator(".history-item").filter({ hasText: TASK_TEXT })
	await expect(historyTask).toHaveCount(1, { timeout: 30_000 })
	await historyTask.click()
	await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
}

function resumeButton(sidebar: Frame) {
	return sidebar.getByRole("contentinfo").locator('vscode-button[aria-label="Resume"]')
}

function outputSince(userDataDir: string, baseline: string): string {
	const output = E2ETestHelper.readDlineOutputIfPresent(userDataDir) ?? ""
	return output.startsWith(baseline) ? output.slice(baseline.length) : output
}

function startedHistoryStage(stage: string): string {
	return `[TaskInitPerf] phase=${stage} state=start taskId=${TASK_ID}`
}

function completedHistoryStage(stage: string): string {
	return `[TaskInitPerf] phase=${stage} state=complete taskId=${TASK_ID}`
}

function outputLineAt(output: string, index: number): string {
	const lineEnd = output.indexOf("\n", index)
	return output.slice(index, lineEnd >= 0 ? lineEnd : undefined)
}

async function expectPreviousOpeningDrainedBeforeLockRelease(userDataDir: string): Promise<void> {
	const drainedOutput = await E2ETestHelper.waitForValue(() => {
		const output = E2ETestHelper.readDlineOutputIfPresent(userDataDir) ?? ""
		const watcherStarted = output.indexOf(startedHistoryStage("history_watcher"))
		const watcherReady = output.indexOf("[PromptInputWatcherPerf] phase=ready", watcherStarted)
		const watcherComplete = output.indexOf(completedHistoryStage("history_watcher"), watcherReady)
		const backgroundComplete = output.indexOf(completedHistoryStage("history_background_prepare"), watcherComplete)
		const historyPrepare = output.indexOf(`[TaskInitPerf] phase=history_prepare taskId=${TASK_ID}`, backgroundComplete)
		const lockRelease = output.indexOf(`[ControllerClosePerf] phase=lock_release taskId=${TASK_ID}`, historyPrepare)
		return watcherStarted >= 0 &&
			watcherReady > watcherStarted &&
			watcherComplete > watcherReady &&
			backgroundComplete > watcherComplete &&
			historyPrepare > backgroundComplete &&
			lockRelease > historyPrepare
			? output
			: undefined
	}, 30_000)

	const watcherComplete = drainedOutput.indexOf(completedHistoryStage("history_watcher"))
	const backgroundComplete = drainedOutput.indexOf(completedHistoryStage("history_background_prepare"), watcherComplete)
	const historyPrepare = drainedOutput.indexOf(`[TaskInitPerf] phase=history_prepare taskId=${TASK_ID}`, backgroundComplete)
	expect(outputLineAt(drainedOutput, watcherComplete)).toContain("outcome=superseded")
	expect(outputLineAt(drainedOutput, backgroundComplete)).toContain("outcome=superseded")
	expect(outputLineAt(drainedOutput, historyPrepare)).toContain("current=false")
}

async function expectCurrentHistoryOpening(sidebar: Frame, userDataDir: string, outputBaseline: string): Promise<void> {
	const finalOutput = await E2ETestHelper.waitForValue(() => {
		const output = outputSince(userDataDir, outputBaseline)
		const surfaceReady = output.indexOf(completedHistoryStage("history_surface_ready"))
		const watcherStarted = output.indexOf(startedHistoryStage("history_watcher"), surfaceReady)
		const watcherComplete = output.indexOf(completedHistoryStage("history_watcher"), watcherStarted)
		const metricsComplete = output.indexOf(completedHistoryStage("history_metrics"), watcherStarted)
		const reconciliationComplete = output.indexOf(completedHistoryStage("history_reconciliation"), watcherStarted)
		const interactionReady = output.indexOf(completedHistoryStage("history_interaction_ready"), watcherStarted)
		const barriersComplete =
			watcherComplete > watcherStarted && metricsComplete > watcherStarted && reconciliationComplete > watcherStarted
		const lastBarrier = Math.max(watcherComplete, metricsComplete, reconciliationComplete)
		return surfaceReady >= 0 && watcherStarted > surfaceReady && barriersComplete && interactionReady > lastBarrier
			? output
			: undefined
	}, 30_000)
	const surfaceReady = finalOutput.indexOf(completedHistoryStage("history_surface_ready"))
	const watcherStarted = finalOutput.indexOf(startedHistoryStage("history_watcher"), surfaceReady)
	const watcherComplete = finalOutput.indexOf(completedHistoryStage("history_watcher"), watcherStarted)
	expect(outputLineAt(finalOutput, watcherComplete)).toContain("outcome=success")
	expect(finalOutput).not.toContain("[PromptInputWatcherPerf] phase=start")

	await expect(sidebar.getByText(TASK_TEXT, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
	await expect(sidebar.getByText(BODY_MARKER, { exact: true })).toBeVisible({ timeout: 30_000 })
	const resume = resumeButton(sidebar)
	await expect(resume).toBeVisible({ timeout: 30_000 })
	await expect(resume).toHaveAttribute("aria-disabled", "false")
}

async function expectCurrentContextSummary(sidebar: Frame): Promise<void> {
	const expandTaskHeader = sidebar.getByLabel("Expand task header")
	if (await expandTaskHeader.isVisible()) await expandTaskHeader.click()
	await sidebar.getByTestId("context-window-progress-track").hover()
	const surface = sidebar.locator('[data-context-window-surface="summary"]')
	const summary = sidebar.getByTestId("context-window-summary")
	await expect(surface).toBeVisible()
	await expect(summary.getByText("Context Window", { exact: true })).toBeVisible()
	for (const label of ["Used", "Remaining", "Total"]) {
		await expect(summary.getByText(label, { exact: true })).toBeVisible()
	}
	await expect(summary).toContainText("Segment details unavailable for this saved task.")
	await expect(summary).not.toContainText("Input (Current)")
	await expect(summary).not.toContainText("Output Capacity")
	const screenshotPath = e2e.info().outputPath("history-1790708947870-context-summary.png")
	await surface.screenshot({ animations: "disabled", path: screenshotPath })
	await e2e.info().attach("history-1790708947870-context-summary", { contentType: "image/png", path: screenshotPath })
}

e2e.describe("History canonical Task opening", () => {
	e2e.use({
		grpcUnaryFaults: delayedFirstMessageWindow,
		promptInputWatcherReadyDelayMs: WATCHER_READY_DELAY_MS,
	})

	e2e(
		"same-ID reopen drains stale readiness before lock release and reuses the warm watcher",
		async ({ dlineDir, dlineDocsDir, helper, openVSCode, userDataDir, workspaceDir }) => {
			e2e.setTimeout(180_000)
			await seedStaticHistoryFixture(dlineDocsDir)
			expect(await readFile(path.join(dlineDocsDir, "tasks", TASK_ID, "ui_messages.jsonl"), "utf8")).toContain(BODY_MARKER)

			const app = await openVSCode(workspaceDir)
			try {
				const page = await app.firstWindow()
				await E2ETestHelper.openClineSidebar(page)
				const sidebar = await helper.getSidebar(page)
				await helper.signin(sidebar)

				await openHistoryTask(page, sidebar)
				await expect
					.poll(() => readFile(path.join(dlineDir, "e2e-markers", FAULT_MARKER), "utf8").catch(() => ""), {
						timeout: 30_000,
					})
					.toBe("started")

				await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
				await expect(sidebar.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 })
				await expectPreviousOpeningDrainedBeforeLockRelease(userDataDir)
				const outputBeforeReopen = E2ETestHelper.readDlineOutputIfPresent(userDataDir) ?? ""
				await openHistoryTask(page, sidebar)
				await expectCurrentHistoryOpening(sidebar, userDataDir, outputBeforeReopen)

				await expect
					.poll(() => readFile(path.join(dlineDir, "e2e-markers", FAULT_MARKER), "utf8").catch(() => ""), {
						timeout: 30_000,
					})
					.toBe("released")
				await expectCurrentHistoryOpening(sidebar, userDataDir, outputBeforeReopen)
				await expectCurrentContextSummary(sidebar)
				await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
			} finally {
				await app.close()
			}
		},
	)
})

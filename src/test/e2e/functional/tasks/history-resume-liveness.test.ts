import { readdir } from "node:fs/promises"
import * as path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { rewriteTaskActivities } from "@e2e/utils/task-instance-store"
import { expect, type Frame } from "@playwright/test"
import type { TaskActivityRecord } from "@shared/task-activity"

const HISTORY_SURFACE_BUDGET_MS = 500
const BROWSER_MESSAGE_SURFACE_BUDGET_MS = 1_500

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

async function closeCurrentTask(sidebar: Frame): Promise<void> {
	const closeButton = sidebar.getByRole("button", { name: "Close Task", exact: true })
	await expect(closeButton).toBeVisible()
	await closeButton.click()
	await expect(closeButton).toHaveCount(0, { timeout: 30_000 })
	await expect(sidebar.getByTestId("chat-input")).toBeVisible()
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
}

async function onlyTaskId(dlineDocsDir: string): Promise<string> {
	const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true })
	const taskIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
	if (taskIds.length !== 1 || !taskIds[0]) {
		throw new Error(`Expected exactly one persisted task, found ${taskIds.length}`)
	}
	return taskIds[0]
}

function readCompletedHistoryStageDurationMs(output: string, taskId: string, stage: string): number | undefined {
	const match = output.match(
		new RegExp(`\\[TaskInitPerf\\] phase=${stage} state=complete taskId=${taskId} kind=history[^\\n]* durationMs=(\\d+)`),
	)
	return match?.[1] === undefined ? undefined : Number(match[1])
}

function readHistorySurfaceDurationMs(output: string, taskId: string): number | undefined {
	const durations = ["history_surface_preparing", "history_display", "history_surface_ready"].map((stage) =>
		readCompletedHistoryStageDurationMs(output, taskId, stage),
	)
	return durations.some((duration) => duration === undefined)
		? undefined
		: durations.reduce<number>((total, duration) => total + (duration ?? 0), 0)
}

/** The output written since `before` was read, so an earlier opening of the same task is not measured. */
function outputSince(userDataDir: string, before: string): string {
	const output = E2ETestHelper.readDlineOutputIfPresent(userDataDir) ?? ""
	return output.startsWith(before) ? output.slice(before.length) : output
}

async function seedLargeTransientActivityHistory(dlineDocsDir: string, taskId: string): Promise<void> {
	const createdAt = Date.now()
	const detail = "E2E_HISTORY_LIVENESS_ACTIVITY_DETAIL_".padEnd(64 * 1024, "x")
	const output = "E2E_HISTORY_LIVENESS_ACTIVITY_OUTPUT_".padEnd(64 * 1024, "y")
	const activities = Array.from({ length: 160 }, (_, index) => ({
		schemaVersion: 1,
		activityId: `e2e-history-liveness-${index}`,
		taskId,
		kind: "command",
		executionMode: "background",
		cancellationOwner: "task",
		status: "running",
		createdAt: createdAt + index,
		updatedAt: createdAt + index,
		title: `E2E_HISTORY_LIVENESS_ACTIVITY_${index}`,
		detail,
		output,
		timeoutSeconds: 0,
		events: [],
	}))
	await rewriteTaskActivities(dlineDocsDir, taskId, () => activities as unknown as TaskActivityRecord[])
}

e2e(
	"History Resume is published before large interrupted activity maintenance completes",
	async ({ dlineDocsDir, helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_history_liveness_read",
				name: "read_file",
				arguments: { path: "README.md" },
			},
			{
				type: "tool",
				id: "call_history_liveness_interrupted",
				name: "attempt_completion",
				arguments: { result: "E2E_HISTORY_LIVENESS_INTERRUPTED_MUST_NOT_RENDER" },
				delayMs: 30_000,
				expectedToolResults: [{ callId: "call_history_liveness_read", contentIncludes: "# Test Workspace" }],
			},
			{
				type: "tool",
				id: "call_history_liveness_resumed",
				name: "attempt_completion",
				arguments: { result: "E2E_HISTORY_LIVENESS_RESUMED" },
				expectedToolResults: [{ callId: "call_history_liveness_read", contentIncludes: "# Test Workspace" }],
				expectedRequestIncludes: [
					"The previous task session was closed and has now been restored.",
					"E2E_HISTORY_LIVENESS_DRAFT",
				],
			},
		)

		const taskText = "E2E_HISTORY_RESUME_LIVENESS_TASK"
		await sendTask(sidebar, taskText)
		await expect(sidebar.getByText("Dline read 1 file:", { exact: true })).toBeVisible({ timeout: 60_000 })
		await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(2)
		await closeCurrentTask(sidebar)

		const taskId = await onlyTaskId(dlineDocsDir)
		await seedLargeTransientActivityHistory(dlineDocsDir, taskId)

		const historyTask = sidebar.getByText(taskText, { exact: true }).last()
		await expect(historyTask).toBeVisible({ timeout: 30_000 })
		const outputBeforeHistoryOpen = E2ETestHelper.readDlineOutputIfPresent(userDataDir) ?? ""
		const historyClickedAt = performance.now()
		await historyTask.click()

		await expect(sidebar.getByText(taskText, { exact: true }).first()).toBeVisible({ timeout: 5_000 })
		await expect(sidebar.getByText("Dline read 1 file:", { exact: true })).toBeVisible({ timeout: 5_000 })
		const browserMessageSurfaceMs = Math.round(performance.now() - historyClickedAt)
		const footer = sidebar.getByRole("contentinfo")
		const resumeButton = footer.getByText("Resume", { exact: true })
		await expect(resumeButton).toBeVisible({ timeout: 5_000 })
		const browserSurfaceMs = Math.round(performance.now() - historyClickedAt)
		// The extension's share is measured by its own stage timings: a browser
		// clock also counts Webview transport, rendering, and the poll interval.
		const extensionSurfaceMs = await E2ETestHelper.waitForValue(
			() => readHistorySurfaceDurationMs(outputSince(userDataDir, outputBeforeHistoryOpen), taskId),
			5_000,
		)
		const messageSurfaceMs = await E2ETestHelper.waitForValue(
			() =>
				readCompletedHistoryStageDurationMs(
					outputSince(userDataDir, outputBeforeHistoryOpen),
					taskId,
					"history_message_surface",
				),
			5_000,
		)
		const timing = { browserMessageSurfaceMs, browserSurfaceMs, messageSurfaceMs, extensionSurfaceMs }
		console.log(`[history-resume-liveness] ${JSON.stringify(timing)}`)
		await e2e.info().attach("history-resume-liveness.json", {
			body: Buffer.from(`${JSON.stringify(timing, null, 2)}\n`, "utf8"),
			contentType: "application/json",
		})
		expect(extensionSurfaceMs, `Extension history surface must be ready under ${HISTORY_SURFACE_BUDGET_MS}ms`).toBeLessThan(
			HISTORY_SURFACE_BUDGET_MS,
		)
		expect(messageSurfaceMs, "Message-ready publication must not wait for activity maintenance").toBeLessThan(
			HISTORY_SURFACE_BUDGET_MS,
		)
		expect(browserMessageSurfaceMs, "Click-to-message visibility must include Webview transport and rendering").toBeLessThan(
			BROWSER_MESSAGE_SURFACE_BUDGET_MS,
		)
		await expect.poll(() => server.openAiRequestCount).toBe(2)
		await expect(sidebar.getByText("E2E_HISTORY_LIVENESS_INTERRUPTED_MUST_NOT_RENDER", { exact: false })).toHaveCount(0)

		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_HISTORY_LIVENESS_DRAFT")
		await resumeButton.click()
		await expect(input).toHaveValue("")
		await expect(sidebar.getByText("E2E_HISTORY_LIVENESS_RESUMED", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		await expect.poll(() => server.openAiRequestCount).toBe(3)
		const continuation = server.getMockConsumptions("openai-compatible-chat")[2]
		expect(continuation.contractError).toBeUndefined()
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

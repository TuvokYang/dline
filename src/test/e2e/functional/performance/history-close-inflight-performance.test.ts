import { readdir, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

const TASK_TEXT = "E2E_HISTORY_CLOSE_INFLIGHT_TASK"
const CLOSE_BUDGET_MS = 2_000

async function sendTask(sidebar: Frame): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(TASK_TEXT)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(TASK_TEXT, { exact: true }).first()).toBeVisible()
}

async function closeCurrentTask(sidebar: Frame): Promise<void> {
	const closeButton = sidebar.getByRole("button", { name: "Close Task", exact: true })
	await expect(closeButton).toBeVisible({ timeout: 30_000 })
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

async function seedLargeTransientActivityHistory(taskDirectory: string, taskId: string): Promise<void> {
	const createdAt = Date.now()
	const detail = "E2E_HISTORY_CLOSE_ACTIVITY_DETAIL_".padEnd(64 * 1024, "x")
	const output = "E2E_HISTORY_CLOSE_ACTIVITY_OUTPUT_".padEnd(64 * 1024, "y")
	const activities = Array.from({ length: 160 }, (_, index) => ({
		schemaVersion: 1,
		activityId: `e2e-history-close-${index}`,
		taskId,
		kind: "command",
		executionMode: "background",
		cancellationOwner: "task",
		status: "running",
		createdAt: createdAt + index,
		updatedAt: createdAt + index,
		title: `E2E_HISTORY_CLOSE_ACTIVITY_${index}`,
		detail,
		output,
		timeoutSeconds: 0,
		events: [],
	}))
	await writeFile(path.join(taskDirectory, "activities.json"), JSON.stringify({ schemaVersion: 1, taskId, activities }), "utf8")
}

e2e(
	"History Close stays responsive while historical preparation is in flight",
	async ({ dlineDocsDir, helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_history_close_read",
				name: "read_file",
				arguments: { path: "README.md" },
			},
			{
				type: "tool",
				id: "call_history_close_interrupted",
				name: "attempt_completion",
				arguments: { result: "E2E_HISTORY_CLOSE_INTERRUPTED_MUST_NOT_RENDER" },
				delayMs: 30_000,
				expectedToolResults: [{ callId: "call_history_close_read", contentIncludes: "# Test Workspace" }],
			},
		)

		await sendTask(sidebar)
		await expect(sidebar.getByText("Dline read 1 file:", { exact: true })).toBeVisible({ timeout: 60_000 })
		await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(2)
		await closeCurrentTask(sidebar)

		const taskId = await onlyTaskId(dlineDocsDir)
		await seedLargeTransientActivityHistory(path.join(dlineDocsDir, "tasks", taskId), taskId)

		const historyTask = sidebar.getByText(TASK_TEXT, { exact: true }).last()
		await expect(historyTask).toBeVisible({ timeout: 30_000 })
		await historyTask.click()

		await expect(sidebar.getByText(TASK_TEXT, { exact: true }).first()).toBeVisible({ timeout: 5_000 })
		const closeButton = sidebar.getByRole("button", { name: "Close Task", exact: true })
		await expect(closeButton).toBeVisible({ timeout: 5_000 })
		const closeStartedAt = performance.now()
		await closeButton.click()
		await expect(closeButton).toHaveCount(0, { timeout: 30_000 })
		await expect(sidebar.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 })
		const closeMs = Math.round(performance.now() - closeStartedAt)

		console.log(`[history-close-inflight-performance] ${JSON.stringify({ closeMs })}`)
		await e2e.info().attach("history-close-inflight-performance.json", {
			body: Buffer.from(`${JSON.stringify({ closeMs }, null, 2)}\n`, "utf8"),
			contentType: "application/json",
		})
		expect(closeMs, `History Close must return to the empty composer under ${CLOSE_BUDGET_MS}ms`).toBeLessThan(
			CLOSE_BUDGET_MS,
		)
		await expect(sidebar.getByText("E2E_HISTORY_CLOSE_INTERRUPTED_MUST_NOT_RENDER", { exact: false })).toHaveCount(0)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [
			/Error getting latest git commit hash/i,
			/Dline instance aborted/i,
		])
		const dlineOutput = await E2ETestHelper.readDlineOutput(userDataDir)
		const dlineOutputPath = e2e.info().outputPath("dline-output.log")
		await writeFile(dlineOutputPath, dlineOutput, "utf8")
		await e2e.info().attach("dline-output.log", {
			path: dlineOutputPath,
			contentType: "text/plain",
		})
	},
)

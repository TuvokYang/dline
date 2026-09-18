import { readdir, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

const HISTORY_SURFACE_BUDGET_MS = 500

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

async function seedLargeTransientActivityHistory(taskDirectory: string, taskId: string): Promise<void> {
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
	await writeFile(path.join(taskDirectory, "activities.json"), JSON.stringify({ schemaVersion: 1, taskId, activities }), "utf8")
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
		const taskDirectory = path.join(dlineDocsDir, "tasks", taskId)
		await seedLargeTransientActivityHistory(taskDirectory, taskId)

		const historyTask = sidebar.getByText(taskText, { exact: true }).last()
		await expect(historyTask).toBeVisible({ timeout: 30_000 })
		const historyClickedAt = performance.now()
		await historyTask.click()

		await expect(sidebar.getByText(taskText, { exact: true }).first()).toBeVisible({ timeout: 5_000 })
		await expect(sidebar.getByText("Dline read 1 file:", { exact: true })).toBeVisible({ timeout: 5_000 })
		const footer = sidebar.getByRole("contentinfo")
		const resumeButton = footer.getByText("Resume", { exact: true })
		await expect(resumeButton).toBeVisible({ timeout: 5_000 })
		const historySurfaceMs = Math.round(performance.now() - historyClickedAt)
		console.log(`[history-resume-liveness] ${JSON.stringify({ historySurfaceMs })}`)
		await e2e.info().attach("history-resume-liveness.json", {
			body: Buffer.from(`${JSON.stringify({ historySurfaceMs }, null, 2)}\n`, "utf8"),
			contentType: "application/json",
		})
		expect(historySurfaceMs, `History surface must be ready under ${HISTORY_SURFACE_BUDGET_MS}ms`).toBeLessThan(
			HISTORY_SURFACE_BUDGET_MS,
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

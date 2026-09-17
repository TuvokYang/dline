import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect } from "@playwright/test"

const TASK_ID = "e2e-history-empty-first-window"
const TASK_TEXT = "E2E_HISTORY_EMPTY_FIRST_WINDOW_TASK"
const BODY_MARKER = "E2E_HISTORY_PERSISTED_BODY_MUST_RECOVER"
const FAULT_MARKER = "empty-first-fetch-message"

const emptyFirstMessageWindow = JSON.stringify({
	action: "delayEmptyFetchMessage",
	service: "dline.TaskService",
	method: "fetchMessage",
	occurrence: 1,
	delayMs: 2_500,
	markerName: FAULT_MARKER,
})

async function seedCompletedTask(dlineDocsDir: string, workspaceDir: string): Promise<string> {
	const tasksDir = path.join(dlineDocsDir, "tasks")
	const taskDir = path.join(tasksDir, TASK_ID)
	await mkdir(taskDir, { recursive: true })
	const baseTimestamp = Date.now() - 30_000
	const historyItem = {
		id: TASK_ID,
		ts: baseTimestamp,
		task: TASK_TEXT,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		cwdOnTaskInitialization: workspaceDir,
	}
	const messages = [
		{ ts: baseTimestamp, type: "say", say: "task", text: TASK_TEXT },
		{ ts: baseTimestamp + 1, type: "say", say: "text", text: BODY_MARKER },
	]
	await Promise.all([
		writeFile(path.join(tasksDir, "taskHistory.jsonl"), `${JSON.stringify(historyItem)}\n`, "utf8"),
		writeFile(
			path.join(taskDir, "ui_messages.jsonl"),
			`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
			"utf8",
		),
		writeFile(path.join(taskDir, "api_conversation_history.jsonl"), "", "utf8"),
		writeFile(
			path.join(taskDir, ".lock"),
			JSON.stringify({ held_by: "e2e-other-dline-instance", locked_at: Date.now(), pid: 4242 }),
			"utf8",
		),
	])
	return path.join(taskDir, "ui_messages.jsonl")
}

e2e.describe("Task message window recovery", () => {
	e2e.use({ grpcUnaryFaults: emptyFirstMessageWindow })

	e2e(
		"recovers persisted history after the first message window is empty",
		async ({ dlineDir, dlineDocsDir, helper, openVSCode, userDataDir, workspaceDir }) => {
			e2e.setTimeout(180_000)
			const uiMessagesPath = await seedCompletedTask(dlineDocsDir, workspaceDir)
			expect(await readFile(uiMessagesPath, "utf8")).toContain(BODY_MARKER)

			const app = await openVSCode(workspaceDir)
			try {
				const page = await app.firstWindow()
				await E2ETestHelper.openClineSidebar(page)
				const sidebar = await helper.getSidebar(page)
				await helper.signin(sidebar)
				await page.getByRole("button", { name: "History", exact: true }).click()
				await E2ETestHelper.dismissWhatsNewModal(sidebar)
				const historyTask = sidebar.locator(".history-item").filter({ hasText: TASK_TEXT })
				await expect(historyTask).toHaveCount(1)
				await historyTask.click()

				await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
				await expect(sidebar.getByText(TASK_TEXT, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
				await expect
					.poll(async () => readFile(path.join(dlineDir, "e2e-markers", FAULT_MARKER), "utf8").catch(() => ""), {
						timeout: 30_000,
					})
					.toBe("released")
				expect(await readFile(uiMessagesPath, "utf8")).toContain(BODY_MARKER)
				await expect(sidebar.getByText(BODY_MARKER, { exact: true })).toBeVisible({ timeout: 5_000 })
				await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
			} finally {
				await app.close()
			}
		},
	)
})

import { readdir } from "node:fs/promises"
import * as path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { readStoredTaskHistoryItem, seedLegacyTaskHistory } from "@e2e/utils/task-history-store"
import { expect, type Frame, type Page } from "@playwright/test"
import type { HistoryItem } from "@shared/HistoryItem"
import type { ElectronApplication } from "playwright"

const TASK_TEXT = "E2E_TASK_HISTORY_COMPLETION_STATE"
const FIRST_COMPLETION = "E2E_TASK_HISTORY_COMPLETION_FIRST"
const CONTINUATION_READY = "E2E_TASK_HISTORY_COMPLETION_CONTINUED"
const FINAL_COMPLETION = "E2E_TASK_HISTORY_COMPLETION_FINAL"
const CONTINUATION_FEEDBACK = "E2E_TASK_HISTORY_CONTINUE_AFTER_COMPLETION"
const CLOSE_TASK_TEXT = "E2E_TASK_HISTORY_COMPLETION_CLOSE"
const CLOSE_COMPLETION = "E2E_TASK_HISTORY_COMPLETION_CLOSE_DONE"

async function openSidebar(app: ElectronApplication, helper: E2ETestHelper): Promise<{ page: Page; sidebar: Frame }> {
	const page = await app.firstWindow()
	await E2ETestHelper.openClineSidebar(page)
	const sidebar = await helper.getSidebar(page)
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	await helper.signin(sidebar)
	return { page, sidebar }
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

async function submitFeedback(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled({ timeout: 30_000 })
	await input.fill(text)
	await input.press("Enter")
	await expect(input).toHaveValue("")
	// The submitted feedback is rendered as a direct user message row; assert on
	// that contract rather than on a styling class that the chat rows no longer carry.
	await expect(sidebar.getByTestId("direct-user-input").filter({ hasText: text })).toHaveCount(1, { timeout: 30_000 })
}

async function closeTask(sidebar: Frame): Promise<void> {
	const closeButton = sidebar.getByRole("button", { name: "Close Task", exact: true })
	await expect(closeButton).toBeVisible({ timeout: 30_000 })
	await closeButton.click()
	await expect(sidebar.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 })
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
}

async function startNewTask(sidebar: Frame): Promise<void> {
	const startButton = sidebar.locator('vscode-button[aria-label="Start New Task"]')
	await expect(startButton).toBeVisible({ timeout: 30_000 })
	await startButton.click()
	await expect(sidebar.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 })
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
}

function historyPreviewItem(sidebar: Frame, taskText: string) {
	return sidebar.locator(".history-preview-item").filter({ hasText: taskText })
}

async function expectHistoryCompletion(sidebar: Frame, taskText: string, completed: boolean): Promise<void> {
	const item = historyPreviewItem(sidebar, taskText)
	await expect(item).toHaveCount(1, { timeout: 30_000 })
	const completion = item.getByLabel("Completed")
	if (completed) {
		await expect(completion).toHaveCount(1, { timeout: 30_000 })
		await expect(completion).toBeVisible()
	} else {
		await expect(completion).toHaveCount(0, { timeout: 30_000 })
	}
}

async function onlyTaskId(dlineDocsDir: string): Promise<string> {
	return await E2ETestHelper.waitForValue(async () => {
		const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true }).catch(() => [])
		const taskIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
		return taskIds.length === 1 ? taskIds[0] : undefined
	}, 30_000)
}

async function readHistoryItem(dlineDocsDir: string, taskId: string): Promise<HistoryItem | undefined> {
	return await readStoredTaskHistoryItem(dlineDocsDir, taskId)
}

async function expectPersistedCompletion(
	dlineDocsDir: string,
	taskId: string,
	isCompleted: boolean,
	minimumRevision = 0,
): Promise<number> {
	return await E2ETestHelper.waitForValue(async () => {
		const item = await readHistoryItem(dlineDocsDir, taskId)
		if (
			item?.isCompleted !== isCompleted ||
			item.completionStateRevision === undefined ||
			item.completionStateRevision < minimumRevision
		) {
			return undefined
		}
		return item.completionStateRevision
	}, 30_000)
}

async function reopenTaskFromPreview(sidebar: Frame, taskText: string): Promise<void> {
	const item = historyPreviewItem(sidebar, taskText)
	await expect(item).toHaveCount(1, { timeout: 30_000 })
	await item.click()
	await expect(sidebar.getByText(taskText, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
	await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
}

e2e(
	"Task history completed projection persists across restart and follows completion feedback",
	async ({ dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(300_000)
		let app: ElectronApplication | undefined

		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{ type: "tool", name: "attempt_completion", arguments: { result: FIRST_COMPLETION } },
			{ type: "tool", name: "qna_respond", arguments: { response: CONTINUATION_READY } },
			{ type: "tool", name: "attempt_completion", arguments: { result: FINAL_COMPLETION } },
		)

		try {
			app = await openVSCode(workspaceDir)
			let opened = await openSidebar(app, helper)
			await sendTask(opened.sidebar, TASK_TEXT)
			await expect(opened.sidebar.getByText(FIRST_COMPLETION, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect(opened.sidebar.getByRole("contentinfo").getByText("Start New Task", { exact: true })).toBeVisible()

			const taskId = await onlyTaskId(dlineDocsDir)
			const completedRevision = await expectPersistedCompletion(dlineDocsDir, taskId, true)
			await startNewTask(opened.sidebar)
			await expectHistoryCompletion(opened.sidebar, TASK_TEXT, true)

			await app.close()
			helper.clearCachedFrame()
			app = undefined

			app = await openVSCode(workspaceDir)
			opened = await openSidebar(app, helper)
			await expectHistoryCompletion(opened.sidebar, TASK_TEXT, true)
			await expectPersistedCompletion(dlineDocsDir, taskId, true, completedRevision)
			await reopenTaskFromPreview(opened.sidebar, TASK_TEXT)

			await submitFeedback(opened.sidebar, CONTINUATION_FEEDBACK)
			await expect(opened.sidebar.getByText(CONTINUATION_READY, { exact: true })).toBeVisible({ timeout: 60_000 })
			await expect(opened.sidebar.getByRole("contentinfo").getByText("Start New Task", { exact: true })).toHaveCount(0)
			const continuedRevision = await expectPersistedCompletion(dlineDocsDir, taskId, false, completedRevision + 1)
			await closeTask(opened.sidebar)
			await expectHistoryCompletion(opened.sidebar, TASK_TEXT, false)

			await app.close()
			helper.clearCachedFrame()
			app = undefined

			app = await openVSCode(workspaceDir)
			opened = await openSidebar(app, helper)
			await expectHistoryCompletion(opened.sidebar, TASK_TEXT, false)
			await expectPersistedCompletion(dlineDocsDir, taskId, false, continuedRevision)
			await reopenTaskFromPreview(opened.sidebar, TASK_TEXT)

			await submitFeedback(opened.sidebar, "E2E_TASK_HISTORY_FINISH_NOW")
			await expect(opened.sidebar.getByText(FINAL_COMPLETION, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			// The completion footer is published by a separate state update, so it can
			// settle after the completion text itself becomes visible.
			await expect(opened.sidebar.getByRole("contentinfo").getByText("Start New Task", { exact: true })).toBeVisible({
				timeout: 30_000,
			})
			await expectPersistedCompletion(dlineDocsDir, taskId, true, continuedRevision + 1)
			await startNewTask(opened.sidebar)
			await expectHistoryCompletion(opened.sidebar, TASK_TEXT, true)

			const consumptions = server.getMockConsumptions("openai-compatible-chat")
			expect(consumptions).toHaveLength(3)
			expect(consumptions.map((entry) => entry.toolName)).toEqual([
				"attempt_completion",
				"qna_respond",
				"attempt_completion",
			])
			expect(consumptions.every((entry) => entry.contractError === undefined)).toBe(true)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
			helper.clearCachedFrame()
		}
	},
)

e2e(
	"Task history keeps the completed projection after the task is closed",
	async ({ dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(300_000)
		let app: ElectronApplication | undefined

		server.resetOpenAiMock()
		server.enqueueOpenAiResponses({
			type: "tool",
			name: "attempt_completion",
			arguments: { result: CLOSE_COMPLETION },
		})

		try {
			app = await openVSCode(workspaceDir)
			let opened = await openSidebar(app, helper)
			await sendTask(opened.sidebar, CLOSE_TASK_TEXT)
			await expect(opened.sidebar.getByText(CLOSE_COMPLETION, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect(opened.sidebar.getByRole("contentinfo").getByText("Start New Task", { exact: true })).toBeVisible()

			const taskId = await onlyTaskId(dlineDocsDir)
			const completedRevision = await expectPersistedCompletion(dlineDocsDir, taskId, true)

			// Closing a finished Task only ends the session; it must not retract the
			// completion verdict the Task already established.
			await closeTask(opened.sidebar)
			await expectPersistedCompletion(dlineDocsDir, taskId, true, completedRevision)
			await expectHistoryCompletion(opened.sidebar, CLOSE_TASK_TEXT, true)

			await app.close()
			helper.clearCachedFrame()
			app = undefined

			app = await openVSCode(workspaceDir)
			opened = await openSidebar(app, helper)
			await expectHistoryCompletion(opened.sidebar, CLOSE_TASK_TEXT, true)
			await expectPersistedCompletion(dlineDocsDir, taskId, true, completedRevision)

			const consumptions = server.getMockConsumptions("openai-compatible-chat")
			expect(consumptions).toHaveLength(1)
			expect(consumptions.map((entry) => entry.toolName)).toEqual(["attempt_completion"])
			expect(consumptions.every((entry) => entry.contractError === undefined)).toBe(true)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
			helper.clearCachedFrame()
		}
	},
)

e2e(
	"Task history ignores a legacy completed boolean without a runtime revision",
	async ({ dlineDocsDir, helper, openVSCode, userDataDir, workspaceDir }) => {
		const historyItem: HistoryItem = {
			id: "e2e-legacy-unrevisioned-completion",
			ts: Date.now(),
			task: "E2E_LEGACY_UNREVISIONED_COMPLETION",
			cwdOnTaskInitialization: workspaceDir,
			isCompleted: true,
		}
		// Seeding the legacy file also exercises the one-time import on first launch.
		await seedLegacyTaskHistory(dlineDocsDir, [historyItem])

		const app = await openVSCode(workspaceDir)
		try {
			const opened = await openSidebar(app, helper)
			await expectHistoryCompletion(opened.sidebar, historyItem.task, false)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

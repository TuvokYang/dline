import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"
import type { ElectronApplication } from "playwright"

/**
 * BUGFIX-098 — ordinary turns must extend the task's message files in place.
 *
 * A task holds the only writable handle on its message files, so a commit
 * writes from its in-memory baseline: appends go to the end and an edited
 * recent message only replaces the file's tail. Rewriting the whole file
 * through a temp file and a rename on every turn is what made long tasks
 * slow, and the rename is observable as a new inode.
 *
 * The restart half pins that what was written in place reads back complete.
 */

const TASK_TEXT = "E2E_INCREMENTAL_WRITES_TASK"
const READY_MARKER = "E2E_INCREMENTAL_WRITES_READY"
const FOLLOW_UP_TEXT = "E2E_INCREMENTAL_WRITES_FOLLOW_UP"
const COMPLETION_MARKER = "E2E_INCREMENTAL_WRITES_DONE"
const MESSAGE_FILES = ["ui_messages.jsonl", "api_conversation_history.jsonl"] as const

async function openSidebar(app: ElectronApplication, helper: E2ETestHelper): Promise<Frame> {
	const page = await app.firstWindow()
	await E2ETestHelper.openClineSidebar(page)
	const sidebar = await helper.getSidebar(page)
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	await helper.signin(sidebar)
	return sidebar
}

async function sendMessage(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled({ timeout: 30_000 })
	await input.fill(text)
	await input.press("Enter")
	await expect(sidebar.getByText(text, { exact: true }).last()).toBeVisible()
}

async function onlyTaskId(dlineDocsDir: string): Promise<string> {
	return await E2ETestHelper.waitForValue(async () => {
		const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true }).catch(() => [])
		const taskIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
		return taskIds.length === 1 ? taskIds[0] : undefined
	}, 30_000)
}

/** Wait until every message file durably holds the marker, then report each file's inode. */
async function inodesOnceDurable(taskDir: string, marker: string): Promise<number[]> {
	await expect
		.poll(
			async () =>
				(
					await Promise.all(
						MESSAGE_FILES.map((name) =>
							readFile(path.join(taskDir, name), "utf8")
								.then((content) => content.includes(marker))
								.catch(() => false),
						),
					)
				).every(Boolean),
			{ timeout: 30_000 },
		)
		.toBe(true)
	return await Promise.all(MESSAGE_FILES.map(async (name) => (await stat(path.join(taskDir, name))).ino))
}

e2e(
	"Message stores extend task files in place across turns and read back after a restart",
	async ({ dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{ type: "tool", id: "call_incremental_ready", name: "qna_respond", arguments: { response: READY_MARKER } },
			{
				type: "tool",
				id: "call_incremental_done",
				name: "attempt_completion",
				arguments: { result: COMPLETION_MARKER },
				expectedRequestIncludes: [READY_MARKER, FOLLOW_UP_TEXT],
			},
		)

		let taskDir: string
		const firstApp = await openVSCode(workspaceDir)
		try {
			const sidebar = await openSidebar(firstApp, helper)
			await sendMessage(sidebar, TASK_TEXT)
			await expect(sidebar.getByText(READY_MARKER, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			taskDir = path.join(dlineDocsDir, "tasks", await onlyTaskId(dlineDocsDir))
			const inodesAfterFirstTurn = await inodesOnceDurable(taskDir, READY_MARKER)

			await sendMessage(sidebar, FOLLOW_UP_TEXT)
			await expect(sidebar.getByText(COMPLETION_MARKER, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			const inodesAfterSecondTurn = await inodesOnceDurable(taskDir, COMPLETION_MARKER)

			// A temp-file rename would give the path a new inode.
			expect(inodesAfterSecondTurn, `in-place writes expected for ${MESSAGE_FILES.join(", ")}`).toEqual(
				inodesAfterFirstTurn,
			)
			const consumptions = server.getMockConsumptions()
			expect(consumptions.map((consumption) => consumption.contractError)).toEqual([undefined, undefined])
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await firstApp.close()
		}

		const reopenedApp = await openVSCode(workspaceDir)
		try {
			const sidebar = await openSidebar(reopenedApp, helper)
			await sidebar.page().getByRole("button", { name: "History", exact: true }).click()
			const historyTask = sidebar.locator(".history-item").filter({ hasText: TASK_TEXT })
			await expect(historyTask).toHaveCount(1, { timeout: 30_000 })
			await historyTask.click()
			await expect(sidebar.getByText(READY_MARKER, { exact: false }).first()).toBeVisible({ timeout: 30_000 })
			await expect(sidebar.getByText(COMPLETION_MARKER, { exact: false }).last()).toBeVisible({ timeout: 30_000 })

			// Every line must still parse: a tail replaced in place must not leave
			// a torn or duplicated record behind.
			for (const name of MESSAGE_FILES) {
				const lines = (await readFile(path.join(taskDir, name), "utf8")).split("\n").filter(Boolean)
				const timestamps = lines.map((line) => (JSON.parse(line) as { ts: number }).ts)
				expect(new Set(timestamps).size, `${name} holds each timestamp once`).toBe(timestamps.length)
			}
		} finally {
			await reopenedApp.close()
		}
	},
)

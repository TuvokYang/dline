import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { prepareWorkSession, sendWorkMessage, setWorkAutoApproveAction } from "@e2e/utils/work/session"
import { expect } from "@playwright/test"

const TARGET = "openai-compatible-chat" as const
const TASK_TEXT = "WORK_DAILY_CHAT_TOOLS_TASK"
const READ_REQUEST = "WORK_DAILY_READ_REQUEST"
const READ_NOTE = "WORK_DAILY_READ_APPROVAL_NOTE"
const REPLACE_REQUEST = "WORK_DAILY_REPLACE_REQUEST"
const REPLACE_COMPLETE = "WORK_DAILY_REPLACE_COMPLETE"
const REPLACE_RELATIVE_PATH = "work-daily-replace-text.txt"
const REPLACE_BEFORE = "WORK_DAILY_REPLACE_BEFORE"
const REPLACE_AFTER = "WORK_DAILY_REPLACE_AFTER"
const COMMAND_REQUEST = "WORK_DAILY_COMMAND_REQUEST"
const EXIT_REQUEST = "WORK_DAILY_EXIT_REQUEST"
const EXIT_RESUME_NOTE = "WORK_DAILY_EXIT_RESUME_NOTE"
const EXIT_CLOSED = "WORK_DAILY_EXITED_RESPONSE_MUST_NOT_RENDER"
const EXIT_RESUMED = "WORK_DAILY_EXIT_RESUME_OK"
const FINISH_REQUEST = "WORK_DAILY_FINISH_REQUEST"
const RESUME_NOTE = "WORK_DAILY_RESUME_NOTE"
const COMPLETE = "WORK_DAILY_CHAT_TOOLS_COMPLETE"
const CANCELLED = "WORK_DAILY_CANCELLED_MUST_NOT_RENDER"
const COMMAND = `node -e "console.log('WORK_DAILY_COMMAND_START'); console.log('WORK_DAILY_COMMAND_END')"`

e2e(
	"daily chat and tools workflow remains usable through approval, project edit, command, cancel, resume, and history",
	async ({ helper, page, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(600_000)
		const replacePath = path.join(workspaceDir, REPLACE_RELATIVE_PATH)
		await writeFile(replacePath, `${REPLACE_BEFORE}\n`, "utf8")
		await prepareWorkSession(sidebar, helper)
		await setWorkAutoApproveAction(sidebar, "Read project files", false)
		await setWorkAutoApproveAction(sidebar, "Edit project files", false)
		await setWorkAutoApproveAction(sidebar, "Edit all files", false)
		await setWorkAutoApproveAction(sidebar, "Execute safe commands", false)
		server.resetOpenAiMock()
		server.enqueueResponses(
			TARGET,
			{
				type: "tool",
				id: "call_daily_ready",
				name: "qna_respond",
				arguments: { response: "WORK_DAILY_CHAT_READY" },
				expectedRequestIncludes: [TASK_TEXT],
			},
			{
				type: "tool",
				id: "call_daily_read",
				name: "read_file",
				arguments: { path: "README.md" },
				expectedRequestIncludes: [READ_REQUEST],
			},
			{
				type: "tool",
				id: "call_daily_read_done",
				name: "qna_respond",
				arguments: { response: "WORK_DAILY_READ_COMPLETE" },
				expectedRequestIncludes: [READ_NOTE],
				expectedToolResults: [{ callId: "call_daily_read", contentIncludes: "# Test Workspace" }],
			},
			{
				type: "tool",
				id: "call_daily_replace",
				name: "replace_text",
				arguments: {
					file_pattern: REPLACE_RELATIVE_PATH,
					find: REPLACE_BEFORE,
					replace: REPLACE_AFTER,
					literal: true,
					dry_run: false,
				},
				expectedRequestIncludes: [REPLACE_REQUEST],
			},
			{
				type: "tool",
				id: "call_daily_replace_done",
				name: "qna_respond",
				arguments: { response: REPLACE_COMPLETE },
				expectedToolResults: [{ callId: "call_daily_replace", contentIncludes: REPLACE_AFTER }],
			},
			{
				type: "tool",
				id: "call_daily_command",
				name: "execute_command",
				arguments: {
					command: COMMAND,
					workdirectory: ".",
					requires_approval: false,
					synchronous: true,
					timeout: 60,
				},
				expectedRequestIncludes: [COMMAND_REQUEST],
			},
			{
				type: "tool",
				id: "call_daily_command_done",
				name: "qna_respond",
				arguments: { response: "WORK_DAILY_COMMAND_COMPLETE" },
				expectedToolResults: [
					{
						callId: "call_daily_command",
						contentIncludes: ["Command executed successfully", "WORK_DAILY_COMMAND_START", "WORK_DAILY_COMMAND_END"],
					},
				],
			},
			{
				type: "tool",
				id: "call_daily_exit_read",
				name: "read_file",
				arguments: { path: "README.md" },
				expectedRequestIncludes: [EXIT_REQUEST],
			},
			{
				type: "tool",
				id: "call_daily_exit_interrupted",
				name: "qna_respond",
				arguments: { response: EXIT_CLOSED },
				delayMs: 30_000,
				expectedToolResults: [{ callId: "call_daily_exit_read", contentIncludes: "# Test Workspace" }],
			},
			{
				type: "tool",
				id: "call_daily_exit_resumed",
				name: "qna_respond",
				arguments: { response: EXIT_RESUMED },
				expectedToolResults: [{ callId: "call_daily_exit_read", contentIncludes: "# Test Workspace" }],
				expectedRequestIncludes: ["The previous task session was closed and has now been restored.", EXIT_RESUME_NOTE],
			},
			{
				type: "tool",
				id: "call_daily_cancelled",
				name: "attempt_completion",
				arguments: { result: CANCELLED },
				expectedRequestIncludes: [FINISH_REQUEST],
				delayMs: 30_000,
			},
			{
				type: "tool",
				id: "call_daily_resumed",
				name: "attempt_completion",
				arguments: { result: COMPLETE },
				expectedRequestIncludes: [RESUME_NOTE],
			},
			{
				type: "error",
				status: 500,
				code: "unexpected_additional_request",
				message: "Unexpected request after daily chat/tools completion",
			},
		)

		await sendWorkMessage(sidebar, TASK_TEXT)
		await expect(sidebar.getByText("WORK_DAILY_CHAT_READY", { exact: true })).toBeVisible({
			timeout: 60_000,
		})

		await sendWorkMessage(sidebar, READ_REQUEST)
		const footer = sidebar.getByRole("contentinfo")
		const approve = footer.getByText("Approve", { exact: true })
		await expect(approve).toHaveCount(1, { timeout: 60_000 })
		await expect(sidebar.getByText("README.md", { exact: false }).last()).toBeVisible({ timeout: 30_000 })
		await sidebar.getByTestId("chat-input").fill(READ_NOTE)
		await approve.click()
		await expect(sidebar.getByText("Dline read 1 file:", { exact: true })).toBeVisible({ timeout: 30_000 })
		await expect(sidebar.getByText("WORK_DAILY_READ_COMPLETE", { exact: true })).toBeVisible({
			timeout: 60_000,
		})
		await expect(footer.getByText("Approve", { exact: true })).toHaveCount(0)

		await setWorkAutoApproveAction(sidebar, "Edit project files", true)
		await sendWorkMessage(sidebar, REPLACE_REQUEST)
		await expect(sidebar.getByText(REPLACE_COMPLETE, { exact: true })).toBeVisible({ timeout: 60_000 })
		await expect(footer.getByText("Approve", { exact: true })).toHaveCount(0)
		await expect(footer.getByText("Reject", { exact: true })).toHaveCount(0)
		await expect.poll(() => readFile(replacePath, "utf8")).toContain(REPLACE_AFTER)
		await setWorkAutoApproveAction(sidebar, "Edit project files", false)

		await setWorkAutoApproveAction(sidebar, "Execute safe commands", true)
		await sendWorkMessage(sidebar, COMMAND_REQUEST)
		await expect(sidebar.getByTestId("command-execution-mode").last()).toHaveText("Foreground", {
			timeout: 60_000,
		})
		await expect(sidebar.getByText("WORK_DAILY_COMMAND_COMPLETE", { exact: true })).toBeVisible({
			timeout: 90_000,
		})
		const commandCard = sidebar.getByTestId("command-card").last()
		const collapsedCommand = commandCard.getByRole("button", { name: COMMAND, exact: true })
		await expect(collapsedCommand).toBeVisible()
		await collapsedCommand.click()
		const commandOutput = commandCard.getByTestId("command-output-scroll")
		await expect(commandOutput).toContainText("WORK_DAILY_COMMAND_START")
		await expect(commandOutput).toContainText("WORK_DAILY_COMMAND_END")
		await setWorkAutoApproveAction(sidebar, "Execute safe commands", false)

		await sendWorkMessage(sidebar, EXIT_REQUEST)
		const exitApprove = footer.getByText("Approve", { exact: true })
		await expect(exitApprove).toBeVisible({ timeout: 60_000 })
		await exitApprove.click()
		await expect.poll(() => server.getRequestCount(TARGET), { timeout: 60_000 }).toBe(9)
		await expect(sidebar.getByText("Dline read 1 file:", { exact: true }).last()).toBeVisible({ timeout: 30_000 })
		await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
		await E2ETestHelper.dismissWhatsNewModal(sidebar)
		await page.getByRole("button", { name: "History", exact: true }).click()
		await E2ETestHelper.dismissWhatsNewModal(sidebar)
		const interruptedHistoryRow = sidebar.getByText(TASK_TEXT, { exact: true }).last()
		await expect(interruptedHistoryRow).toBeVisible({ timeout: 30_000 })
		await interruptedHistoryRow.click()
		const exitResume = sidebar.getByRole("contentinfo").getByText("Resume", { exact: true })
		await expect(exitResume).toBeVisible({ timeout: 30_000 })
		await expect(sidebar.getByText(EXIT_CLOSED, { exact: false })).toHaveCount(0)
		const exitInput = sidebar.getByTestId("chat-input")
		await expect(exitInput).toBeEnabled()
		await exitInput.fill(EXIT_RESUME_NOTE)
		await exitResume.click()
		await expect(sidebar.getByText(EXIT_RESUMED, { exact: true })).toBeVisible({ timeout: 60_000 })
		await expect(exitResume).toHaveCount(0)

		await sendWorkMessage(sidebar, FINISH_REQUEST)
		await expect.poll(() => server.getRequestCount(TARGET), { timeout: 30_000 }).toBe(11)
		const cancel = footer.getByText("Cancel", { exact: true })
		await expect(cancel).toBeVisible({ timeout: 30_000 })
		await cancel.click()
		const resume = footer.getByText("Resume", { exact: true })
		await expect(resume).toBeVisible({ timeout: 30_000 })
		await expect(sidebar.getByText(CANCELLED, { exact: false })).toHaveCount(0)
		const input = sidebar.getByTestId("chat-input")
		await input.fill(RESUME_NOTE)
		await resume.click()
		await expect(input).toHaveValue("")
		await expect(sidebar.getByText(RESUME_NOTE, { exact: true }).last()).toBeVisible()
		await expect(sidebar.locator('vscode-button[aria-label="Start New Task"]')).toBeVisible({
			timeout: 60_000,
		})
		const scrollToBottom = sidebar.getByRole("button", { name: "Scroll to bottom", exact: true })
		if (await scrollToBottom.isVisible()) await scrollToBottom.click()
		await expect(sidebar.getByText(COMPLETE, { exact: false }).last()).toBeVisible({ timeout: 30_000 })
		await expect(resume).toHaveCount(0)
		await expect(cancel).toHaveCount(0)

		await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
		await E2ETestHelper.dismissWhatsNewModal(sidebar)
		await page.getByRole("button", { name: "History", exact: true }).click()
		await E2ETestHelper.dismissWhatsNewModal(sidebar)
		const historyRow = sidebar.getByText(TASK_TEXT, { exact: true }).last()
		await expect(historyRow).toBeVisible({ timeout: 30_000 })
		await historyRow.click()
		await expect(sidebar.getByText(TASK_TEXT, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
		const historyScrollToBottom = sidebar.getByRole("button", { name: "Scroll to bottom", exact: true })
		if (await historyScrollToBottom.isVisible()) await historyScrollToBottom.click()
		await expect(sidebar.getByText(COMPLETE, { exact: false }).last()).toBeVisible({ timeout: 30_000 })
		await expect.poll(() => server.getRequestCount(TARGET)).toBe(12)
		const consumptions = server.getMockConsumptions(TARGET)
		expect(consumptions.map((entry) => entry.toolName)).toEqual([
			"qna_respond",
			"read_file",
			"qna_respond",
			"replace_text",
			"qna_respond",
			"execute_command",
			"qna_respond",
			"read_file",
			"qna_respond",
			"qna_respond",
			"attempt_completion",
			"attempt_completion",
		])
		expect(consumptions[2].requestToolResults.filter((result) => result.callId === "call_daily_read")).toHaveLength(1)
		expect(consumptions[4].requestToolResults.filter((result) => result.callId === "call_daily_replace")).toHaveLength(1)
		expect(consumptions[6].requestToolResults.filter((result) => result.callId === "call_daily_command")).toHaveLength(1)
		expect(consumptions[9].requestToolResults.filter((result) => result.callId === "call_daily_exit_read")).toHaveLength(1)
		expect(consumptions.every((entry) => entry.contractError === undefined)).toBe(true)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import {
	openWorkActivities,
	openWorkTab,
	prepareWorkSession,
	sendWorkMessage,
	setWorkAutoApproveAction,
} from "@e2e/utils/work/session"
import { expect, type Frame, type Locator, type Page } from "@playwright/test"

const PARENT_TARGET = "openai-compatible-chat" as const
const CHILD_TARGET = "openai-compatible-responses" as const
const AGENT_NAME = "work-daily-observer"
const TASK_TEXT = "WORK_DAILY_BACKGROUND_SUBAGENTS_TASK"
const FOREGROUND_COMMAND_REQUEST = "WORK_FOREGROUND_COMMAND_REQUEST"
const HANDOFF_COMMAND_REQUEST = "WORK_HANDOFF_COMMAND_REQUEST"
const DURING_COMMAND_INPUT = "WORK_DURING_BACKGROUND_COMMAND_INPUT"
const COLLECT_COMMAND_INPUT = "WORK_COLLECT_BACKGROUND_COMMAND_RESULT"
const FOREGROUND_SUBAGENT_REQUEST = "WORK_FOREGROUND_SUBAGENT_REQUEST"
const BACKGROUND_SUBAGENT_REQUEST = "WORK_BACKGROUND_SUBAGENT_REQUEST"
const DURING_SUBAGENT_INPUT = "WORK_DURING_BACKGROUND_SUBAGENT_INPUT"
const COLLECT_SUBAGENT_INPUT = "WORK_COLLECT_BACKGROUND_SUBAGENT_RESULT"
const FOREGROUND_CHILD_TASK = "WORK_FOREGROUND_SUBAGENT_CHILD_TASK"
const FOREGROUND_CHILD_CONTEXT = "Read README.md and return the foreground observation."
const FOREGROUND_CHILD_RESULT = "WORK_FOREGROUND_SUBAGENT_CHILD_OK"
const BACKGROUND_CHILD_TASK = "WORK_BACKGROUND_SUBAGENT_CHILD_TASK"
const BACKGROUND_CHILD_CONTEXT = "Read README.md, remain active briefly, and return the background observation."
const BACKGROUND_CHILD_RESULT = "WORK_BACKGROUND_SUBAGENT_CHILD_OK"
const COMPLETE = "WORK_DAILY_BACKGROUND_SUBAGENTS_COMPLETE"
const FOREGROUND_COMMAND = `node -e "console.log('WORK_FOREGROUND_COMMAND_START'); console.log('WORK_FOREGROUND_COMMAND_END')"`
const BACKGROUND_COMMAND = `node -e "console.log('WORK_BACKGROUND_COMMAND_START'); setTimeout(()=>console.log('WORK_BACKGROUND_COMMAND_END'),12000)"`

async function writeWorkSubagent(workspaceDir: string): Promise<void> {
	const directory = path.join(workspaceDir, ".agents", "subagents")
	await mkdir(directory, { recursive: true })
	await writeFile(
		path.join(directory, `${AGENT_NAME}.yml`),
		`---
name: ${AGENT_NAME}
description: Observe the work test workspace and report concise findings.
profile: ${E2E_PROFILE_NAMES.mockOpenAiResponses}
tools:
  - read_file
  - attempt_completion
---

Read the requested workspace file, then finish through attempt_completion.`,
		"utf8",
	)
}

async function configureTerminalHandoff(page: Page, sidebar: Frame): Promise<void> {
	await page.getByRole("button", { name: "Settings", exact: true }).click()
	await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible({ timeout: 30_000 })
	await sidebar.getByTestId("tab-terminal").click()
	const executionMode = sidebar.locator("#terminal-execution-mode")
	await executionMode.click()
	await sidebar.getByRole("option", { name: "Background Exec", exact: true }).click()
	await expect.poll(() => executionMode.evaluate((element) => (element as HTMLSelectElement).value)).toBe("backgroundExec")
	const handoffSeconds = sidebar.locator("#terminal-command-handoff input")
	await handoffSeconds.fill("1")
	await handoffSeconds.blur()
	await expect(handoffSeconds).toHaveValue("1")
	await sidebar.getByRole("button", { name: "Done", exact: true }).click()
	await expect(sidebar.getByTestId("chat-input")).toBeVisible()
}

async function approveSubagentIfRequested(sidebar: Frame, task: string): Promise<void> {
	const approve = sidebar.getByRole("contentinfo").getByText("Approve", { exact: true })
	const taskHeading = sidebar.getByRole("heading", { name: task, exact: true }).last()
	await expect(approve.or(taskHeading)).toBeVisible({ timeout: 60_000 })
	if (await approve.isVisible()) await approve.click()
}

async function expectCompletedSubagentCard(
	sidebar: Frame,
	task: string,
	contextMarker: string,
	result: string,
	executionMode: "Foreground" | "Background",
): Promise<Locator> {
	const taskHeading = sidebar.getByRole("heading", { name: task, exact: true }).last()
	await expect(taskHeading).toBeVisible({ timeout: 60_000 })
	const card = taskHeading.locator("xpath=ancestor::*[@data-testid='subagent-item'][1]")
	await expect(card.getByTestId("subagent-name")).toHaveText(AGENT_NAME)
	await expect(card.getByTestId("subagent-execution-mode")).toHaveText(executionMode)
	await expect(card.getByTestId("subagent-context-content")).toContainText(contextMarker)
	await expect(card.getByTestId("subagent-tool-step-name")).toHaveText(["read_file", "attempt_completion"])
	const showOutput = card.getByRole("button", { name: "Show subagent output", exact: true })
	if (await showOutput.isVisible()) await showOutput.click()
	await expect(card.getByTestId("subagent-output")).toContainText(result)
	return card
}

e2e(
	"daily background commands and subagents keep Activities and chat usable through foreground and background work",
	async ({ helper, page, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(600_000)
		await writeWorkSubagent(workspaceDir)
		await prepareWorkSession(sidebar, helper)
		await configureTerminalHandoff(page, sidebar)
		await setWorkAutoApproveAction(sidebar, "Execute safe commands", true)

		server.resetOpenAiMock()
		server.enqueueResponses(
			PARENT_TARGET,
			{
				type: "tool",
				id: "call_work_background_ready",
				name: "qna_respond",
				arguments: { response: "WORK_DAILY_BACKGROUND_READY" },
				expectedRequestIncludes: [TASK_TEXT],
			},
			{
				type: "tool",
				id: "call_work_foreground_command",
				name: "execute_command",
				arguments: {
					command: FOREGROUND_COMMAND,
					workdirectory: ".",
					requires_approval: false,
					synchronous: true,
					timeout: 60,
				},
				expectedRequestIncludes: [FOREGROUND_COMMAND_REQUEST],
			},
			{
				type: "tool",
				id: "call_work_foreground_command_done",
				name: "qna_respond",
				arguments: { response: "WORK_FOREGROUND_COMMAND_OK" },
				expectedToolResults: [
					{
						callId: "call_work_foreground_command",
						contentIncludes: ["WORK_FOREGROUND_COMMAND_START", "WORK_FOREGROUND_COMMAND_END"],
					},
				],
			},
			{
				type: "tool",
				id: "call_work_handoff_command",
				name: "execute_command",
				arguments: {
					command: BACKGROUND_COMMAND,
					workdirectory: ".",
					requires_approval: false,
					synchronous: true,
					timeout: 30,
				},
				expectedRequestIncludes: [HANDOFF_COMMAND_REQUEST],
			},
			{
				type: "tool",
				id: "call_work_handoff_ready",
				name: "qna_respond",
				arguments: { response: "WORK_BACKGROUND_COMMAND_HANDED_OFF" },
				expectedToolResults: [
					{
						callId: "call_work_handoff_command",
						contentIncludes: [
							"Command is running in the background",
							"Its final status will be available only in a later model request.",
						],
					},
				],
			},
			{
				type: "tool",
				id: "call_work_during_background_command",
				name: "qna_respond",
				arguments: { response: "WORK_DURING_BACKGROUND_COMMAND_OK" },
				expectedRequestIncludes: [DURING_COMMAND_INPUT],
			},
			{
				type: "tool",
				id: "call_work_background_command_result",
				name: "qna_respond",
				arguments: { response: "WORK_BACKGROUND_COMMAND_RESULT_OK" },
				expectedRequestIncludes: [
					COLLECT_COMMAND_INPUT,
					"# Background Results",
					"## Background Command Results",
					"WORK_BACKGROUND_COMMAND_START",
					"WORK_BACKGROUND_COMMAND_END",
				],
			},
			{
				type: "tool",
				id: "call_work_foreground_subagent",
				name: "use_subagent",
				arguments: {
					agent_name: AGENT_NAME,
					task: FOREGROUND_CHILD_TASK,
					context: FOREGROUND_CHILD_CONTEXT,
					timeout: 60,
				},
				expectedRequestIncludes: [FOREGROUND_SUBAGENT_REQUEST],
			},
			{
				type: "tool",
				id: "call_work_foreground_subagent_done",
				name: "qna_respond",
				arguments: { response: "WORK_FOREGROUND_SUBAGENT_OK" },
				expectedToolResults: [{ callId: "call_work_foreground_subagent", contentIncludes: FOREGROUND_CHILD_RESULT }],
			},
			{
				type: "tool",
				id: "call_work_background_subagent",
				name: "use_subagent",
				arguments: {
					agent_name: AGENT_NAME,
					task: BACKGROUND_CHILD_TASK,
					context: BACKGROUND_CHILD_CONTEXT,
					background: true,
					timeout: 60,
				},
				expectedRequestIncludes: [BACKGROUND_SUBAGENT_REQUEST],
			},
			{
				type: "tool",
				id: "call_work_background_subagent_started",
				name: "qna_respond",
				arguments: { response: "WORK_BACKGROUND_SUBAGENT_STARTED" },
				expectedToolResults: [
					{
						callId: "call_work_background_subagent",
						contentIncludes: [
							"Started background subagent job: subagent_",
							"Its final result will be available only in a later model request.",
						],
					},
				],
			},
			{
				type: "tool",
				id: "call_work_during_background_subagent",
				name: "qna_respond",
				arguments: { response: "WORK_DURING_BACKGROUND_SUBAGENT_OK" },
				expectedRequestIncludes: [DURING_SUBAGENT_INPUT, "# Background Subagents", BACKGROUND_CHILD_TASK],
			},
			{
				type: "tool",
				id: "call_work_background_subagent_complete",
				name: "attempt_completion",
				arguments: { result: COMPLETE },
				expectedRequestIncludes: [
					COLLECT_SUBAGENT_INPUT,
					"# Background Results",
					"## Background Subagent Results",
					BACKGROUND_CHILD_RESULT,
				],
			},
			{
				type: "error",
				status: 500,
				code: "unexpected_additional_request",
				message: "Unexpected request after daily background/subagents completion",
			},
		)
		server.enqueueResponses(
			CHILD_TARGET,
			{
				type: "tool",
				id: "call_work_foreground_child_read",
				name: "read_file",
				arguments: { path: "README.md" },
				expectedRequestIncludes: [FOREGROUND_CHILD_TASK, FOREGROUND_CHILD_CONTEXT],
			},
			{
				type: "tool",
				id: "call_work_foreground_child_complete",
				name: "attempt_completion",
				arguments: { result: FOREGROUND_CHILD_RESULT },
				expectedToolResults: [{ callId: "call_work_foreground_child_read", contentIncludes: "# Test Workspace" }],
			},
			{
				type: "tool",
				id: "call_work_background_child_read",
				name: "read_file",
				arguments: { path: "README.md" },
				expectedRequestIncludes: [BACKGROUND_CHILD_TASK, BACKGROUND_CHILD_CONTEXT],
			},
			{
				type: "tool",
				id: "call_work_background_child_complete",
				name: "attempt_completion",
				arguments: { result: BACKGROUND_CHILD_RESULT },
				delayMs: 8_000,
				expectedToolResults: [{ callId: "call_work_background_child_read", contentIncludes: "# Test Workspace" }],
			},
		)

		let taskStarted = false
		try {
			await sendWorkMessage(sidebar, TASK_TEXT)
			taskStarted = true
			await expect(sidebar.getByText("WORK_DAILY_BACKGROUND_READY", { exact: true })).toBeVisible({ timeout: 60_000 })

			await sendWorkMessage(sidebar, FOREGROUND_COMMAND_REQUEST)
			await expect(sidebar.getByText("WORK_FOREGROUND_COMMAND_OK", { exact: true })).toBeVisible({ timeout: 60_000 })
			const foregroundCard = sidebar.getByTestId("command-card").last()
			await expect(foregroundCard.getByTestId("command-execution-mode")).toHaveText("Foreground")
			await foregroundCard.getByRole("button", { name: FOREGROUND_COMMAND, exact: true }).click()
			await expect(foregroundCard.getByTestId("command-output-scroll")).toContainText("WORK_FOREGROUND_COMMAND_END")

			await sendWorkMessage(sidebar, HANDOFF_COMMAND_REQUEST)
			await expect(sidebar.getByTestId("command-execution-mode").last()).toHaveText("Foreground", { timeout: 60_000 })
			const footer = sidebar.getByRole("contentinfo")
			const continueInBackground = footer.locator('vscode-button[aria-label="Continue in Background"]')
			await expect(continueInBackground).toBeVisible({ timeout: 40_000 })
			await continueInBackground.click()
			await expect(sidebar.getByText("WORK_BACKGROUND_COMMAND_HANDED_OFF", { exact: true })).toBeVisible({
				timeout: 60_000,
			})
			await expect(sidebar.getByTestId("command-execution-mode").last()).toHaveText("Background", { timeout: 30_000 })

			let activities = await openWorkActivities(sidebar)
			const commandActivity = activities.filter({ hasText: BACKGROUND_COMMAND })
			await expect(commandActivity).toHaveCount(1, { timeout: 30_000 })
			await expect(commandActivity).toHaveAttribute("data-activity-status", "running")
			await openWorkTab(sidebar)
			await sendWorkMessage(sidebar, DURING_COMMAND_INPUT)
			await expect(sidebar.getByText("WORK_DURING_BACKGROUND_COMMAND_OK", { exact: true })).toBeVisible({ timeout: 60_000 })

			activities = await openWorkActivities(sidebar)
			await expect(commandActivity).toHaveAttribute("data-activity-status", "completed", { timeout: 60_000 })
			await openWorkTab(sidebar)
			await sendWorkMessage(sidebar, COLLECT_COMMAND_INPUT)
			await expect(sidebar.getByText("WORK_BACKGROUND_COMMAND_RESULT_OK", { exact: true })).toBeVisible({ timeout: 60_000 })

			await sendWorkMessage(sidebar, FOREGROUND_SUBAGENT_REQUEST)
			await approveSubagentIfRequested(sidebar, FOREGROUND_CHILD_TASK)
			await expect(sidebar.getByText("WORK_FOREGROUND_SUBAGENT_OK", { exact: true })).toBeVisible({ timeout: 60_000 })
			await expectCompletedSubagentCard(
				sidebar,
				FOREGROUND_CHILD_TASK,
				"Read README.md",
				FOREGROUND_CHILD_RESULT,
				"Foreground",
			)

			await sendWorkMessage(sidebar, BACKGROUND_SUBAGENT_REQUEST)
			await approveSubagentIfRequested(sidebar, BACKGROUND_CHILD_TASK)
			await expect(sidebar.getByText("WORK_BACKGROUND_SUBAGENT_STARTED", { exact: true })).toBeVisible({ timeout: 60_000 })
			const backgroundTaskHeading = sidebar.getByRole("heading", { name: BACKGROUND_CHILD_TASK, exact: true }).last()
			await expect(backgroundTaskHeading).toBeVisible()
			const backgroundCard = backgroundTaskHeading.locator("xpath=ancestor::*[@data-testid='subagent-item'][1]")
			await expect(backgroundCard.getByTestId("subagent-execution-mode")).toHaveText("Background")

			activities = await openWorkActivities(sidebar)
			const runningSubagentActivity = sidebar
				.locator('[data-testid="activity-item"][data-activity-status="running"]')
				.filter({ hasText: AGENT_NAME })
			await expect(runningSubagentActivity).toHaveCount(1, { timeout: 30_000 })
			await expect(runningSubagentActivity.getByTestId("activity-execution-mode")).toHaveText("Background")
			const subagentActivityId = await runningSubagentActivity.getAttribute("data-activity-id")
			if (!subagentActivityId) throw new Error("Running background subagent Activity did not expose an id")
			const subagentActivity = sidebar.locator(`[data-testid="activity-item"][data-activity-id="${subagentActivityId}"]`)
			await openWorkTab(sidebar)
			await sendWorkMessage(sidebar, DURING_SUBAGENT_INPUT)
			await expect(sidebar.getByText("WORK_DURING_BACKGROUND_SUBAGENT_OK", { exact: true })).toBeVisible({
				timeout: 60_000,
			})

			activities = await openWorkActivities(sidebar)
			await expect(subagentActivity).toHaveAttribute("data-activity-status", "completed", { timeout: 60_000 })
			await openWorkTab(sidebar)
			await sendWorkMessage(sidebar, COLLECT_SUBAGENT_INPUT)
			await expect(sidebar.getByText(COMPLETE, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expectCompletedSubagentCard(
				sidebar,
				BACKGROUND_CHILD_TASK,
				"Read README.md",
				BACKGROUND_CHILD_RESULT,
				"Background",
			)

			activities = await openWorkActivities(sidebar)
			await expect(activities.locator('[data-activity-status="running"]')).toHaveCount(0)
			await openWorkTab(sidebar)
			await expect.poll(() => server.getRequestCount(PARENT_TARGET)).toBe(13)
			await expect.poll(() => server.getRequestCount(CHILD_TARGET)).toBe(4)
			const parentConsumptions = server.getMockConsumptions(PARENT_TARGET)
			expect(parentConsumptions.map((entry) => entry.toolName)).toEqual([
				"qna_respond",
				"execute_command",
				"qna_respond",
				"execute_command",
				"qna_respond",
				"qna_respond",
				"qna_respond",
				"use_subagent",
				"qna_respond",
				"use_subagent",
				"qna_respond",
				"qna_respond",
				"attempt_completion",
			])
			const childConsumptions = server.getMockConsumptions(CHILD_TARGET)
			expect(childConsumptions.map((entry) => entry.toolName)).toEqual([
				"read_file",
				"attempt_completion",
				"read_file",
				"attempt_completion",
			])
			expect([...parentConsumptions, ...childConsumptions].every((entry) => entry.contractError === undefined)).toBe(true)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			if (taskStarted) {
				const closeTask = sidebar.getByRole("button", { name: "Close Task", exact: true })
				if (await closeTask.isVisible().catch(() => false)) await closeTask.click().catch(() => undefined)
			}
		}
	},
)

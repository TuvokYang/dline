import { mkdir, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { expect } from "@playwright/test"
import { E2E_PROFILE_NAMES } from "../utils/api-profile"
import { E2ETestHelper } from "../utils/helpers"
import { demo } from "./utils/demo-fixture"
import { STEP_SETTLE_MS, WINDOW_RECORDING } from "./utils/recording-presets"

const AGENT_NAME = "workspace-observer"
const PARENT_TASK = "Inspect the demo workspace with a subagent and summarize the activity."
const CHILD_TASK = "Read the workspace overview and verify the root files."
const CHILD_CONTEXT = "Read README.md, list the workspace root, and return a concise result."
const CHILD_RESULT = "Workspace inspection complete: README and root files verified."
const PARENT_RESULT = "Workspace activity review complete."
const FINAL_CHILD_DELAY_MS = 8_000

async function writeDemoSubagent(workspaceDir: string): Promise<void> {
	const directory = path.join(workspaceDir, ".agents", "subagents")
	await mkdir(directory, { recursive: true })
	await writeFile(
		path.join(directory, `${AGENT_NAME}.yml`),
		`---
name: ${AGENT_NAME}
description: Inspect the demo workspace and report concise findings.
profile: ${E2E_PROFILE_NAMES.mockOpenAiResponses}
tools:
  - read_file
  - list_files
  - attempt_completion
---

Read the requested file, inspect the workspace root, then finish through attempt_completion.`,
		"utf8",
	)
}

demo(
	"R4",
	async ({ finishRecording, focusCamera, helper, pace, registerRecording, server, sidebar, userDataDir, workspaceDir }) => {
		demo.setTimeout(180_000)
		await demo.step("record R4 activity panel", async () => {
			await writeDemoSubagent(workspaceDir)
			await helper.signin(sidebar)

			server.resetOpenAiMock()
			server.enqueueOpenAiResponses(
				{
					type: "tool",
					id: "call_r4_use_subagent",
					name: "use_subagent",
					arguments: {
						agent_name: AGENT_NAME,
						task: CHILD_TASK,
						context: CHILD_CONTEXT,
						timeout: 120,
					},
					usage: { inputTokens: 1_200, outputTokens: 120 },
					expectedRequestIncludes: [PARENT_TASK],
				},
				{
					type: "tool",
					id: "call_r4_parent_complete",
					name: "attempt_completion",
					arguments: { result: PARENT_RESULT },
					usage: { inputTokens: 1_600, outputTokens: 160 },
					expectedToolResults: [{ callId: "call_r4_use_subagent", contentIncludes: CHILD_RESULT }],
				},
			)
			server.enqueueResponses(
				"openai-compatible-responses",
				{
					type: "tool",
					id: "call_r4_child_read",
					name: "read_file",
					arguments: { path: "README.md" },
					reasoning: "First I will inspect the workspace overview.",
					usage: { inputTokens: 700, outputTokens: 80 },
					expectedRequestIncludes: [CHILD_TASK],
				},
				{
					type: "tool",
					id: "call_r4_child_list",
					name: "list_files",
					arguments: { path: ".", recursive: false },
					reasoning: "Next I will verify the root structure.",
					usage: { inputTokens: 900, outputTokens: 90 },
					expectedToolResults: [{ callId: "call_r4_child_read", contentIncludes: "# Test Workspace" }],
				},
				{
					type: "tool",
					id: "call_r4_child_complete",
					name: "attempt_completion",
					arguments: { result: CHILD_RESULT },
					reasoning: "The requested workspace checks are complete.",
					usage: { inputTokens: 1_000, outputTokens: 100 },
					delayMs: FINAL_CHILD_DELAY_MS,
					expectedToolResults: [{ callId: "call_r4_child_list", contentIncludes: "README.md" }],
				},
			)

			const input = sidebar.getByTestId("chat-input")
			await input.fill(PARENT_TASK)
			await input.press("Enter")
			await expect(input).toHaveValue("")

			const approveButton = sidebar.getByText("Approve", { exact: true })
			const childHeading = sidebar.getByRole("heading", { name: CHILD_TASK, exact: true }).last()
			await expect(approveButton.or(childHeading)).toBeVisible({ timeout: 60_000 })
			if (await approveButton.isVisible()) await approveButton.click()

			await expect
				.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 60_000 })
				.toBeGreaterThanOrEqual(2)
			await registerRecording("r4-activity-panel", WINDOW_RECORDING)
			const activitiesTab = sidebar.getByRole("tab", { name: /^Activities(?: \d+)?$/ })
			await focusCamera(activitiesTab, STEP_SETTLE_MS)
			await activitiesTab.click()
			await sidebar.getByTestId("activity-status-filter-all").click()

			const activity = sidebar.getByTestId("activity-item").filter({ hasText: AGENT_NAME })
			await expect(activity).toHaveCount(1)
			await expect(activity).toHaveAttribute("data-activity-status", "running")
			await activity.getByTestId("activity-toggle").click()

			const activityToolSteps = activity.getByTestId("subagent-tool-step")
			const readStep = activityToolSteps.filter({ hasText: "read_file" })
			const listStep = activityToolSteps.filter({ hasText: "list_files" })
			await expect(readStep).toHaveCount(1)
			await expect(listStep).toHaveCount(1)
			await expect(readStep.getByTestId("subagent-tool-step-status")).toHaveText(/Done$/)
			await expect(listStep.getByTestId("subagent-tool-step-status")).toHaveText(/Done$/)
			await expect(activity).toHaveAttribute("data-activity-status", "running")
			await focusCamera(activity, 0)
			await pace()

			await expect(activity).toHaveAttribute("data-activity-status", "completed", { timeout: 60_000 })
			await expect(activityToolSteps).toHaveCount(3)
			await expect(activity.getByTestId("subagent-tool-step-name")).toHaveText([
				"read_file",
				"list_files",
				"attempt_completion",
			])
			await expect(activity.getByTestId("subagent-tool-step-status")).toHaveText([/Done$/, /Done$/, /Done$/])
			await focusCamera(activity, 0)
			await pace(1_200)

			const workTab = sidebar.getByRole("tab", { name: "Work", exact: true })
			await focusCamera(workTab, STEP_SETTLE_MS)
			await workTab.click()
			await expect(sidebar.getByText(PARENT_RESULT, { exact: false }).last()).toBeVisible({ timeout: 60_000 })

			const taskHeaderToggle = sidebar.locator('[aria-label="Expand task header"], [aria-label="Collapse task header"]')
			await expect(taskHeaderToggle).toHaveCount(1)
			if ((await taskHeaderToggle.getAttribute("aria-label")) === "Expand task header") await taskHeaderToggle.click()

			const contextProgress = sidebar.getByTestId("context-window-segmented-progress")
			await expect(sidebar.getByTestId("context-window-indicator")).toBeVisible({ timeout: 30_000 })
			await expect(contextProgress).toHaveAttribute("data-context-window", /^[1-9]\d*$/)
			await expect(contextProgress).toHaveAttribute("aria-valuenow", /^[1-9]\d*$/)
			await focusCamera(sidebar.getByTestId("context-window-indicator"))
			await pace(1_000)

			const rateMetrics = sidebar.getByTestId("task-rate-metrics")
			await expect(rateMetrics).toHaveAttribute("aria-label", /View API rate history/, { timeout: 30_000 })
			await focusCamera(rateMetrics, STEP_SETTLE_MS)
			await rateMetrics.click()

			const dialog = sidebar.getByRole("dialog")
			await expect(dialog.getByRole("heading", { name: "API Rate History", exact: true })).toBeVisible()
			await dialog.getByRole("radio", { name: "TPM/RPM", exact: true }).click()
			await dialog.getByRole("radio", { name: "Bar", exact: true }).click()

			const chart = dialog.getByRole("img", { name: "Task metrics history chart", exact: true })
			await expect(chart).toBeVisible({ timeout: 30_000 })
			await expect(chart).toHaveAttribute("data-view", "rates")
			await expect(chart).toHaveAttribute("data-chart-type", "bar")
			await expect(dialog.locator('[data-testid^="task-metrics-bar-tpm-"]:not([height="0"])').first()).toBeVisible()
			await expect(dialog.locator('[data-testid^="task-metrics-bar-rpm-"]:not([height="0"])').first()).toBeVisible()
			await focusCamera(chart, 0)
			await pace()

			await dialog.getByRole("button", { name: "Close", exact: true }).click()
			await expect(dialog).toBeHidden()
			await expect(workTab).toHaveAttribute("aria-selected", "true")
			const subagentItem = sidebar.getByTestId("subagent-item").filter({ hasText: AGENT_NAME })
			await expect(subagentItem).toBeVisible()
			await focusCamera(subagentItem, 0)
			await pace(1_000)
			await finishRecording()

			const parentConsumptions = server.getMockConsumptions("openai-compatible-chat")
			const childConsumptions = server.getMockConsumptions("openai-compatible-responses")
			expect(parentConsumptions.map(({ toolName }) => toolName)).toEqual(["use_subagent", "attempt_completion"])
			expect(childConsumptions.map(({ toolName }) => toolName)).toEqual(["read_file", "list_files", "attempt_completion"])
			expect([...parentConsumptions, ...childConsumptions].every(({ contractError }) => contractError === undefined)).toBe(
				true,
			)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		})
	},
)

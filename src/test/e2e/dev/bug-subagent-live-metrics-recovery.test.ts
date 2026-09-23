import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Page, type TestInfo } from "@playwright/test"

interface PersistedSubagentMetrics {
	activityId: string
	status: string
	toolCalls: number
	inputTokens: number
	outputTokens: number
	contextTokens: number
	contextWindow: number
}

async function writeResponsesSubagent(workspaceDir: string, agentName: string): Promise<void> {
	const directory = path.join(workspaceDir, ".agents", "subagents")
	await mkdir(directory, { recursive: true })
	await writeFile(
		path.join(directory, `${agentName}.yml`),
		`---
name: ${agentName}
description: Reproduces live activity metrics after a Task recovery.
tools:
  - read_file
  - attempt_completion
profile: ${E2E_PROFILE_NAMES.mockOpenAiResponses}
---

Read the requested file repeatedly and finish only through attempt_completion.`,
		"utf8",
	)
}

async function submitMessage(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled()
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

async function closeCurrentTask(sidebar: Frame): Promise<void> {
	const closeButton = sidebar.getByRole("button", { name: "Close Task", exact: true })
	await expect(closeButton).toBeVisible({ timeout: 30_000 })
	await closeButton.click()
	await expect(closeButton).toHaveCount(0, { timeout: 30_000 })
	await expect(sidebar.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 })
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
}

async function cancelRunningTask(sidebar: Frame): Promise<void> {
	const taskFooter = sidebar.getByRole("contentinfo")
	const cancelButton = taskFooter.locator('vscode-button[aria-label="Cancel"]')
	await expect(cancelButton).toBeVisible({ timeout: 30_000 })
	await cancelButton.click()
	await expect(cancelButton).toHaveCount(0, { timeout: 30_000 })
	await expect(sidebar.getByTestId("chat-input")).toBeEnabled({ timeout: 30_000 })
}

async function reopenTask(page: Page, sidebar: Frame, taskText: string): Promise<void> {
	await page.getByRole("button", { name: "History", exact: true }).click()
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	const historyTask = sidebar.locator(".history-item").filter({ hasText: taskText })
	await expect(historyTask).toHaveCount(1)
	await historyTask.click()
	await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
	await expect(sidebar.getByText(taskText, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
}

async function onlyTaskId(dlineDocsDir: string): Promise<string> {
	return E2ETestHelper.waitForValue(async () => {
		const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true }).catch(() => [])
		const taskIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
		return taskIds.length === 1 ? taskIds[0] : undefined
	})
}

async function readPersistedSubagentMetrics(
	dlineDocsDir: string,
	taskId: string,
	minimumToolCalls: number,
): Promise<PersistedSubagentMetrics> {
	return E2ETestHelper.waitForValue(async () => {
		const activityPath = path.join(dlineDocsDir, "tasks", taskId, "activities.json")
		const persisted = await readFile(activityPath, "utf8").then(
			(value) =>
				JSON.parse(value) as {
					activities?: Array<{
						activityId?: string
						kind?: string
						status?: string
						metrics?: {
							toolCalls?: number
							inputTokens?: number
							outputTokens?: number
							contextTokens?: number
							contextWindow?: number
						}
					}>
				},
			() => undefined,
		)
		const activity = persisted?.activities?.find(
			(candidate) => candidate.kind === "subagent" && (candidate.metrics?.toolCalls ?? 0) >= minimumToolCalls,
		)
		if (!activity?.activityId || !activity.status || !activity.metrics) return undefined
		return {
			activityId: activity.activityId,
			status: activity.status,
			toolCalls: activity.metrics.toolCalls ?? 0,
			inputTokens: activity.metrics.inputTokens ?? 0,
			outputTokens: activity.metrics.outputTokens ?? 0,
			contextTokens: activity.metrics.contextTokens ?? 0,
			contextWindow: activity.metrics.contextWindow ?? 0,
		}
	}, 60_000)
}

async function flushWebviewRender(sidebar: Frame): Promise<void> {
	await sidebar.evaluate(
		() =>
			new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			}),
	)
}

async function attachEvidence(testInfo: TestInfo, evidence: Record<string, unknown>): Promise<void> {
	const evidencePath = testInfo.outputPath("subagent-live-metrics-recovery.json")
	await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8")
	await testInfo.attach("subagent-live-metrics-recovery", { path: evidencePath, contentType: "application/json" })
}

e2e(
	"Foreground subagent live metrics remain visible before a second Task recovery",
	async ({ dlineDocsDir, helper, page, server, sidebar, workspaceDir }, testInfo) => {
		e2e.setTimeout(240_000)
		const agentName = "e2e-live-metrics-recovery"
		const parentTask = "E2E_SUBAGENT_LIVE_METRICS_PARENT"
		const readyMarker = "E2E_SUBAGENT_LIVE_METRICS_READY"
		const resumeFeedback = "E2E_START_LIVE_METRICS_SUBAGENT"
		const childTask = "E2E_SUBAGENT_LIVE_METRICS_CHILD"
		const readToolCount = 4
		await writeResponsesSubagent(workspaceDir, agentName)

		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_live_metrics_ready",
				name: "qna_respond",
				arguments: { response: readyMarker },
			},
			{
				type: "tool",
				id: "call_live_metrics_subagent",
				name: "use_subagent",
				arguments: {
					agent_name: agentName,
					task: childTask,
					context: "Read README.md four times, then wait before completion so live metrics can be inspected.",
					timeout: 180,
				},
				expectedRequestIncludes: [resumeFeedback],
			},
		)
		server.enqueueResponses(
			"openai-compatible-responses",
			...Array.from({ length: readToolCount }, (_, index) => ({
				type: "tool" as const,
				id: `call_live_metrics_read_${index + 1}`,
				name: "read_file",
				arguments: { path: "README.md" },
				usage: { inputTokens: 10, outputTokens: 2 },
				...(index === 0
					? {}
					: {
							expectedToolResults: [
								{ callId: `call_live_metrics_read_${index}`, contentIncludes: "# Test Workspace" },
							],
						}),
			})),
			{
				type: "tool",
				id: "call_live_metrics_delayed_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_SUBAGENT_LIVE_METRICS_CHILD_DONE" },
				usage: { inputTokens: 10, outputTokens: 2 },
				expectedToolResults: [{ callId: `call_live_metrics_read_${readToolCount}`, contentIncludes: "# Test Workspace" }],
				delayMs: 120_000,
			},
		)

		await submitMessage(sidebar, parentTask)
		await expect(sidebar.getByText(readyMarker, { exact: true })).toBeVisible({ timeout: 60_000 })
		await closeCurrentTask(sidebar)

		// The first recovery recreates the Webview subscription while the Controller
		// is still binding the Task. The production bug leaves that subscription open
		// without attaching it to TaskActivityStore.
		await reopenTask(page, sidebar, parentTask)
		await submitMessage(sidebar, resumeFeedback)

		const approveButton = sidebar.getByText("Approve", { exact: true })
		const childHeading = sidebar.getByRole("heading", { name: childTask, exact: true }).last()
		await expect(approveButton.or(childHeading)).toBeVisible({ timeout: 60_000 })
		if (await approveButton.isVisible()) await approveButton.click()
		await expect(childHeading).toBeVisible({ timeout: 60_000 })

		const taskId = await onlyTaskId(dlineDocsDir)
		const persistedMetrics = await readPersistedSubagentMetrics(dlineDocsDir, taskId, readToolCount)
		expect(persistedMetrics).toMatchObject({
			toolCalls: readToolCount,
			inputTokens: readToolCount * 10,
			outputTokens: readToolCount * 2,
		})

		const liveCard = childHeading.locator("xpath=ancestor::*[@data-testid='subagent-item'][1]")
		const liveMetrics = liveCard.getByTestId("subagent-metrics")
		await expect(liveMetrics).toBeVisible()
		await flushWebviewRender(sidebar)
		const beforeSecondRecovery = await liveMetrics.innerText()
		const beforeScreenshot = testInfo.outputPath("subagent-live-metrics-before-second-recovery.png")
		await liveCard.screenshot({ path: beforeScreenshot })
		await testInfo.attach("subagent-live-metrics-before-second-recovery", {
			path: beforeScreenshot,
			contentType: "image/png",
		})

		await cancelRunningTask(sidebar)
		await closeCurrentTask(sidebar)
		await reopenTask(page, sidebar, parentTask)

		const recoveredCard = sidebar.getByTestId("subagent-item").filter({ hasText: agentName })
		await expect(recoveredCard).toHaveCount(1)
		const recoveredMetrics = recoveredCard.getByTestId("subagent-metrics")
		await expect(recoveredMetrics).toBeVisible({ timeout: 30_000 })
		// The restored chat row is visible before the Controller finishes binding
		// the Task. Wait through the terminal empty snapshot and the hook's bounded
		// re-attach delay for the hydrated activity snapshot instead of sampling the
		// zero-valued chat placeholder in the same render frame.
		await expect(recoveredMetrics).toContainText(`${readToolCount} tools`, { timeout: 30_000 })
		await expect(recoveredMetrics).toContainText(`In:${readToolCount * 10}`)
		await expect(recoveredMetrics).toContainText(`Out:${readToolCount * 2}`)
		await flushWebviewRender(sidebar)
		const afterSecondRecovery = await recoveredMetrics.innerText()

		await attachEvidence(testInfo, {
			taskId,
			persistedMetrics,
			beforeSecondRecovery,
			afterSecondRecovery,
			mockConsumptions: server
				.getMockConsumptions("openai-compatible-responses")
				.map(({ responseType, toolName, contractError, usage }) => ({ responseType, toolName, contractError, usage })),
		})

		// Both live and recovered cards must project the canonical activity metrics;
		// the persisted zero-valued chat placeholder is not an acceptable fallback.
		expect(beforeSecondRecovery).toContain(`${readToolCount} tools`)
		expect(beforeSecondRecovery).toContain(`In:${readToolCount * 10}`)
		expect(beforeSecondRecovery).toContain(`Out:${readToolCount * 2}`)
		expect(afterSecondRecovery).toContain(`${readToolCount} tools`)
		expect(afterSecondRecovery).toContain(`In:${readToolCount * 10}`)
		expect(afterSecondRecovery).toContain(`Out:${readToolCount * 2}`)
	},
)

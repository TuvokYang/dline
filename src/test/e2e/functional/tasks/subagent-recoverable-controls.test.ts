import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import type { MockApiConsumption } from "@e2e/fixtures/server"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Locator, type Page, type TestInfo } from "@playwright/test"

/** Mirrors SubagentRunner.MAX_INITIAL_STREAM_ATTEMPTS (one initial try plus five backoff retries). */
const MAX_INITIAL_STREAM_ATTEMPTS = 6
/** The OpenAI SDK retries a 5xx once internally, so one subagent attempt drains two queued responses. */
const SDK_REQUESTS_PER_ATTEMPT = 2

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled()
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

async function writeSubagent(workspaceDir: string, name: string, description: string, profile: string): Promise<void> {
	const directory = path.join(workspaceDir, ".agents", "subagents")
	await mkdir(directory, { recursive: true })
	await writeFile(
		path.join(directory, `${name}.yml`),
		`---
name: ${name}
description: ${description}
tools:
  - read_file
  - attempt_completion
profile: ${profile}
---

Preserve useful findings and finish only through attempt_completion.`,
		"utf8",
	)
}

async function writeResponsesSubagent(workspaceDir: string, name: string, description: string): Promise<void> {
	await writeSubagent(workspaceDir, name, description, E2E_PROFILE_NAMES.mockOpenAiResponses)
}

async function closeCurrentTask(sidebar: Frame): Promise<void> {
	const closeButton = sidebar.getByRole("button", { name: "Close Task", exact: true })
	await expect(closeButton).toBeVisible({ timeout: 30_000 })
	await closeButton.click()
	await expect(sidebar.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 })
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
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

async function readSubagentActivity(dlineDocsDir: string, taskId: string): Promise<Record<string, unknown>> {
	return E2ETestHelper.waitForValue(async () => {
		const persisted = JSON.parse(await readFile(path.join(dlineDocsDir, "tasks", taskId, "activities.json"), "utf8")) as {
			activities?: Array<Record<string, unknown>>
		}
		return persisted.activities?.find((activity) => activity.kind === "subagent")
	})
}

async function attachLocatorScreenshot(locator: Locator, testInfo: TestInfo, name: string): Promise<void> {
	const screenshotPath = testInfo.outputPath(`${name}.png`)
	await locator.screenshot({ path: screenshotPath })
	await testInfo.attach(name, { path: screenshotPath, contentType: "image/png" })
}

function requestToolNames(consumption: MockApiConsumption): string[] {
	const body = consumption.requestBody as {
		tools?: Array<{ name?: string; function?: { name?: string } }>
	}
	return (body.tools ?? [])
		.map((tool) => tool.name ?? tool.function?.name)
		.filter((name): name is string => typeof name === "string")
}

function countOccurrences(text: string, marker: string): number {
	return text.split(marker).length - 1
}

async function measureSubagentWorkGeometry(card: Locator) {
	return card.evaluate((element) => {
		const taskScroll = element.querySelector<HTMLElement>('[data-testid="subagent-task-scroll"]')
		const toolsScroll = element.querySelector<HTMLElement>('[data-testid="subagent-tools-scroll"]')
		const taskContent = taskScroll?.firstElementChild as HTMLElement | null
		const toolsContent = toolsScroll?.querySelector<HTMLElement>('[data-testid="subagent-tool-timeline"]')
		const taskSection = taskScroll?.parentElement
		const toolsSection = toolsScroll?.parentElement
		if (!taskScroll || !toolsScroll || !taskContent || !toolsContent || !taskSection || !toolsSection) {
			throw new Error("Expected complete subagent Work layout")
		}
		const trailingSpace = (scroll: HTMLElement, content: HTMLElement) => {
			const paddingBottom = Number.parseFloat(getComputedStyle(scroll).paddingBottom) || 0
			return scroll.getBoundingClientRect().bottom - paddingBottom - content.getBoundingClientRect().bottom
		}
		const cardStyle = getComputedStyle(element)
		return {
			cardHeight: element.getBoundingClientRect().height,
			maxHeight: Number.parseFloat(cardStyle.maxHeight),
			viewportHeight: window.innerHeight,
			taskClientHeight: taskScroll.clientHeight,
			taskScrollHeight: taskScroll.scrollHeight,
			taskSectionHeight: taskSection.getBoundingClientRect().height,
			taskTrailingSpace: trailingSpace(taskScroll, taskContent),
			toolsClientHeight: toolsScroll.clientHeight,
			toolsScrollHeight: toolsScroll.scrollHeight,
			toolsSectionHeight: toolsSection.getBoundingClientRect().height,
			toolsTrailingSpace: trailingSpace(toolsScroll, toolsContent),
		}
	})
}

e2e(
	"Subagent Work layout - short sections stay compact and a long Task receives the bounded space",
	async ({ helper, server, sidebar, userDataDir, workspaceDir }, testInfo) => {
		e2e.setTimeout(240_000)
		const agentName = "e2e-work-layout"
		const evidenceFileName = "e2e-subagent-work-layout.txt"
		const evidenceMarker = "E2E_SUBAGENT_WORK_LAYOUT_EVIDENCE"
		await writeResponsesSubagent(workspaceDir, agentName, "E2E Work card content sizing agent")
		await writeFile(path.join(workspaceDir, evidenceFileName), evidenceMarker, "utf8")
		await helper.signin(sidebar)

		const runCompletedSubagent = async ({
			runId,
			parentTask,
			childTask,
			childContext,
		}: {
			runId: string
			parentTask: string
			childTask: string
			childContext: string
		}) => {
			const childResult = `E2E_SUBAGENT_WORK_LAYOUT_CHILD_${runId}`
			const parentResult = `E2E_SUBAGENT_WORK_LAYOUT_PARENT_${runId}`
			const subagentCallId = `call_work_layout_subagent_${runId}`
			const readCallId = `call_work_layout_read_${runId}`
			server.resetOpenAiMock()
			server.enqueueOpenAiResponses(
				{
					type: "tool",
					id: subagentCallId,
					name: "use_subagent",
					arguments: {
						agent_name: agentName,
						task: childTask,
						context: childContext,
						timeout: 120,
					},
				},
				{
					type: "tool",
					id: `call_work_layout_parent_complete_${runId}`,
					name: "attempt_completion",
					arguments: { result: parentResult },
					expectedToolResults: [{ callId: subagentCallId, contentIncludes: childResult }],
				},
			)
			server.enqueueResponses(
				"openai-compatible-responses",
				{
					type: "tool",
					id: readCallId,
					name: "read_file",
					arguments: { path: evidenceFileName },
				},
				{
					type: "tool",
					id: `call_work_layout_child_complete_${runId}`,
					name: "attempt_completion",
					arguments: { result: childResult },
					expectedToolResults: [{ callId: readCallId, contentIncludes: evidenceMarker }],
				},
			)

			await sendTask(sidebar, parentTask)
			await expect(sidebar.getByText(parentResult, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			const taskMarker = childTask.split("\n", 1)[0]
			const taskHeading = sidebar.getByRole("heading", { name: new RegExp(taskMarker) }).last()
			await expect(taskHeading).toBeVisible()
			const card = taskHeading.locator("xpath=ancestor::*[@data-testid='subagent-item'][1]")
			await expect(card).toHaveCount(1)
			return card
		}

		const shortCard = await runCompletedSubagent({
			runId: "SHORT",
			parentTask: "Render a completed subagent with compact Work content.",
			childTask: "E2E_SUBAGENT_WORK_LAYOUT_SHORT_TASK",
			childContext: "Short context.",
		})
		await shortCard.evaluate((element) => {
			element.style.width = "900px"
		})
		await expect
			.poll(() => shortCard.evaluate((element) => element.getBoundingClientRect().width))
			.toBeGreaterThanOrEqual(899)
		const shortGeometry = await measureSubagentWorkGeometry(shortCard)
		await testInfo.attach("subagent-work-layout-short-geometry", {
			body: JSON.stringify(shortGeometry, null, 2),
			contentType: "application/json",
		})
		const shortGeometryMessage = JSON.stringify(shortGeometry)
		expect(Math.abs(shortGeometry.maxHeight - shortGeometry.viewportHeight * 0.3), shortGeometryMessage).toBeLessThanOrEqual(
			2,
		)
		expect(shortGeometry.cardHeight, shortGeometryMessage).toBeLessThan(shortGeometry.maxHeight - 4)
		expect(shortGeometry.taskScrollHeight, shortGeometryMessage).toBeLessThanOrEqual(shortGeometry.taskClientHeight + 1)
		expect(shortGeometry.toolsScrollHeight, shortGeometryMessage).toBeLessThanOrEqual(shortGeometry.toolsClientHeight + 1)
		expect(shortGeometry.taskTrailingSpace, shortGeometryMessage).toBeGreaterThanOrEqual(-1)
		expect(shortGeometry.taskTrailingSpace, shortGeometryMessage).toBeLessThanOrEqual(8)
		expect(shortGeometry.toolsTrailingSpace, shortGeometryMessage).toBeGreaterThanOrEqual(-1)
		expect(shortGeometry.toolsTrailingSpace, shortGeometryMessage).toBeLessThanOrEqual(8)
		await attachLocatorScreenshot(shortCard, testInfo, "subagent-work-layout-short")
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Subagent Work layout - long Task and short Tools remain independently scrollable without blank space",
	async ({ helper, server, sidebar, userDataDir, workspaceDir }, testInfo) => {
		e2e.setTimeout(180_000)
		const agentName = "e2e-work-layout-mixed"
		const evidenceFileName = "e2e-subagent-work-layout-mixed.txt"
		const evidenceMarker = "E2E_SUBAGENT_WORK_LAYOUT_MIXED_EVIDENCE"
		const childResult = "E2E_SUBAGENT_WORK_LAYOUT_CHILD_MIXED"
		const parentResult = "E2E_SUBAGENT_WORK_LAYOUT_PARENT_MIXED"
		const childTask = [
			"E2E_SUBAGENT_WORK_LAYOUT_LONG_TASK",
			...Array.from({ length: 48 }, (_, index) => `E2E_SUBAGENT_WORK_LAYOUT_LINE_${index + 1}`),
		].join("\n")
		await writeResponsesSubagent(workspaceDir, agentName, "E2E mixed Work card sizing agent")
		await writeFile(path.join(workspaceDir, evidenceFileName), evidenceMarker, "utf8")
		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_work_layout_subagent_MIXED",
				name: "use_subagent",
				arguments: {
					agent_name: agentName,
					task: childTask,
					context: "Keep the short tool timeline visible while Task scrolls.",
					timeout: 120,
				},
			},
			{
				type: "tool",
				id: "call_work_layout_parent_complete_MIXED",
				name: "attempt_completion",
				arguments: { result: parentResult },
				expectedToolResults: [{ callId: "call_work_layout_subagent_MIXED", contentIncludes: childResult }],
			},
		)
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_work_layout_read_MIXED",
				name: "read_file",
				arguments: { path: evidenceFileName },
			},
			{
				type: "tool",
				id: "call_work_layout_child_complete_MIXED",
				name: "attempt_completion",
				arguments: { result: childResult },
				expectedToolResults: [{ callId: "call_work_layout_read_MIXED", contentIncludes: evidenceMarker }],
			},
		)

		await sendTask(sidebar, "Render a completed subagent with a long Task and one tool.")
		await expect(sidebar.getByText(parentResult, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		const taskHeading = sidebar.getByRole("heading", { name: /E2E_SUBAGENT_WORK_LAYOUT_LONG_TASK/ }).last()
		await expect(taskHeading).toBeVisible()
		const mixedCard = taskHeading.locator("xpath=ancestor::*[@data-testid='subagent-item'][1]")
		await mixedCard.evaluate((element) => {
			element.style.width = "900px"
		})
		await expect
			.poll(() => mixedCard.evaluate((element) => element.getBoundingClientRect().width))
			.toBeGreaterThanOrEqual(899)
		const mixedGeometry = await measureSubagentWorkGeometry(mixedCard)
		const mixedGeometryMessage = JSON.stringify(mixedGeometry)
		expect(mixedGeometry.cardHeight, mixedGeometryMessage).toBeLessThanOrEqual(mixedGeometry.maxHeight + 2)
		expect(Math.abs(mixedGeometry.cardHeight - mixedGeometry.maxHeight), mixedGeometryMessage).toBeLessThanOrEqual(2)
		expect(mixedGeometry.taskScrollHeight, mixedGeometryMessage).toBeGreaterThan(mixedGeometry.taskClientHeight)
		expect(mixedGeometry.toolsScrollHeight, mixedGeometryMessage).toBeGreaterThan(mixedGeometry.toolsClientHeight)
		expect(mixedGeometry.toolsTrailingSpace, mixedGeometryMessage).toBeLessThanOrEqual(8)
		expect(mixedGeometry.taskSectionHeight, mixedGeometryMessage).toBeGreaterThan(mixedGeometry.toolsSectionHeight)
		await expect(mixedCard.getByTestId("subagent-tool-step").first()).toBeVisible()
		const mixedTaskScroll = mixedCard.getByTestId("subagent-task-scroll")
		await mixedTaskScroll.evaluate((element) => {
			element.scrollTop = element.scrollHeight
		})
		await expect.poll(() => mixedTaskScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
		const mixedToolsScroll = mixedCard.getByTestId("subagent-tools-scroll")
		await mixedToolsScroll.evaluate((element) => {
			element.scrollTop = element.scrollHeight
		})
		await expect.poll(() => mixedToolsScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
		await attachLocatorScreenshot(mixedCard, testInfo, "subagent-work-layout-mixed")
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Subagent recovery controls - Finish renders in Work and Activities and enforces completion-only recovery",
	async ({ helper, server, sidebar, userDataDir, workspaceDir }, testInfo) => {
		e2e.setTimeout(240_000)
		const agentName = "e2e-recoverable-finish"
		const taskMarker = "E2E_SUBAGENT_FINISH_TASK"
		const childTask = [
			taskMarker,
			...Array.from({ length: 48 }, (_, index) => `E2E_SUBAGENT_LONG_TASK_LINE_${index + 1}`),
		].join("\n")
		const childResult = "E2E_SUBAGENT_FINISH_CHILD_DONE"
		const evidenceFileName = "e2e-subagent-finish-evidence.txt"
		const evidenceMarker = "E2E_SUBAGENT_FINISH_TOOL_RESULT"
		const readToolCount = 12
		await writeResponsesSubagent(workspaceDir, agentName, "E2E soft Finish lifecycle agent")
		await writeFile(path.join(workspaceDir, evidenceFileName), evidenceMarker, "utf8")

		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_recoverable_finish_subagent",
				name: "use_subagent",
				arguments: {
					agent_name: agentName,
					task: childTask,
					context: "E2E_SUBAGENT_FINISH_CONTEXT\nKeep the current findings and wait for the user to request Finish.",
					timeout: 120,
				},
			},
			{
				type: "tool",
				id: "call_recoverable_finish_parent_complete",
				name: "attempt_completion",
				arguments: { result: "E2E_SUBAGENT_FINISH_PARENT_DONE" },
				expectedToolResults: [{ callId: "call_recoverable_finish_subagent", contentIncludes: childResult }],
			},
		)
		server.enqueueResponses(
			"openai-compatible-responses",
			...Array.from({ length: readToolCount }, (_, index) => ({
				type: "tool" as const,
				id: `call_recoverable_finish_read_${index + 1}`,
				name: "read_file",
				arguments: { path: evidenceFileName },
			})),
			{
				type: "tool",
				id: "call_recoverable_finish_interrupted_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_SUBAGENT_FINISH_INTERRUPTED_MUST_NOT_RENDER" },
				expectedToolResults: [
					{ callId: `call_recoverable_finish_read_${readToolCount}`, contentIncludes: evidenceMarker },
				],
				delayMs: 30_000,
			},
			{
				type: "tool",
				id: "call_recoverable_finish_child_complete",
				name: "attempt_completion",
				arguments: { result: childResult },
				expectedRequestIncludes: [
					"The user requested that the subagent finish now.",
					"Stop all further exploration.",
					"call attempt_completion with a non-empty result",
				],
			},
		)

		await sendTask(sidebar, "Start a subagent, then preserve its findings when Finish is requested.")

		const taskHeading = sidebar.getByRole("heading", { name: new RegExp(taskMarker) }).last()
		await expect(taskHeading).toBeVisible({ timeout: 60_000 })
		await expect
			.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 60_000 })
			.toBe(readToolCount + 1)
		const subagentCard = sidebar.getByTestId("subagent-item").filter({ hasText: agentName })
		await expect(subagentCard).toHaveCount(1)
		const workFinish = subagentCard.getByRole("button", { name: "Finish", exact: true })
		const workCancel = subagentCard.getByRole("button", { name: "Cancel", exact: true })
		const workMetrics = subagentCard.getByTestId("subagent-metrics")
		const workBody = subagentCard.getByTestId("subagent-item-body")
		const workTaskScroll = subagentCard.getByTestId("subagent-task-scroll")
		const workToolsScroll = subagentCard.getByTestId("subagent-tools-scroll")
		await expect(workFinish).toBeVisible()
		await expect(workCancel).toBeVisible()
		await expect(subagentCard.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0)
		await expect(workMetrics).toContainText(`${readToolCount} tools`)
		await expect(workMetrics).toContainText(/In:\S+/)
		await expect(workMetrics).toContainText(/Out:\S+/)
		await expect(workMetrics).toContainText(/\$/)
		await expect(subagentCard.getByTestId("subagent-tool-step")).toHaveCount(readToolCount)
		const workToolButton = subagentCard.getByTestId("subagent-tool-step").first().getByRole("button")
		await expect(workToolButton).toBeDisabled()
		await expect(workToolButton).not.toHaveAttribute("aria-expanded")
		await expect(subagentCard.getByText(evidenceMarker, { exact: false })).toHaveCount(0)
		const workLayout = await subagentCard.evaluate((element) => {
			const style = getComputedStyle(element)
			const body = element.querySelector<HTMLElement>('[data-testid="subagent-item-body"]')
			if (!body) throw new Error("Subagent Work body is missing")
			const taskScroll = element.querySelector<HTMLElement>('[data-testid="subagent-task-scroll"]')
			const toolsScroll = element.querySelector<HTMLElement>('[data-testid="subagent-tools-scroll"]')
			if (!taskScroll || !toolsScroll) throw new Error("Subagent Work sections are missing")
			return {
				maxHeight: Number.parseFloat(style.maxHeight),
				overflow: style.overflow,
				viewportHeight: window.innerHeight,
				bodyOverflowY: getComputedStyle(body).overflowY,
				taskOverflowY: getComputedStyle(taskScroll).overflowY,
				toolsOverflowY: getComputedStyle(toolsScroll).overflowY,
				taskClientHeight: taskScroll.clientHeight,
				taskScrollHeight: taskScroll.scrollHeight,
				toolsClientHeight: toolsScroll.clientHeight,
				toolsScrollHeight: toolsScroll.scrollHeight,
			}
		})
		expect(Math.abs(workLayout.maxHeight - workLayout.viewportHeight * 0.3)).toBeLessThanOrEqual(2)
		expect(workLayout.overflow).toBe("hidden")
		expect(workLayout.bodyOverflowY).toBe("hidden")
		expect(workLayout.taskOverflowY).toBe("auto")
		expect(workLayout.taskScrollHeight).toBeGreaterThan(workLayout.taskClientHeight)
		expect(await workTaskScroll.evaluate((element) => element.scrollTop)).toBe(0)
		await workTaskScroll.evaluate((element) => {
			element.scrollTop = element.scrollHeight
		})
		await expect.poll(() => workTaskScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
		expect(workLayout.toolsOverflowY).toBe("auto")
		expect(workLayout.toolsScrollHeight).toBeGreaterThan(workLayout.toolsClientHeight)
		await attachLocatorScreenshot(subagentCard, testInfo, "subagent-finish-work-card")

		await subagentCard.getByRole("button", { name: "Collapse subagent task" }).click()
		await expect(workTaskScroll).toHaveCount(0)
		await expect(workToolsScroll).toBeVisible()
		await subagentCard.getByRole("button", { name: "Expand subagent task" }).click()
		await expect(workTaskScroll).toBeVisible()
		await subagentCard.getByRole("button", { name: "Collapse subagent tools" }).click()
		await expect(workToolsScroll).toHaveCount(0)
		await expect(workTaskScroll).toBeVisible()
		await attachLocatorScreenshot(subagentCard, testInfo, "subagent-finish-work-sections-collapsed")
		await subagentCard.getByRole("button", { name: "Expand subagent tools" }).click()
		await expect(workToolsScroll).toBeVisible()

		await subagentCard.getByRole("button", { name: `Collapse subagent ${agentName}` }).click()
		await expect(workBody).toHaveCount(0)
		await expect(workMetrics).toBeVisible()
		await expect(workFinish).toBeVisible()
		await expect(workCancel).toBeVisible()
		await attachLocatorScreenshot(subagentCard, testInfo, "subagent-finish-work-card-collapsed")
		await subagentCard.getByRole("button", { name: `Expand subagent ${agentName}` }).click()
		await expect(workBody).toBeVisible()

		await sidebar.getByRole("tab", { name: /^Activities(?: \d+)?$/ }).click()
		await sidebar.getByRole("button", { name: "All", exact: true }).first().click()
		const activity = sidebar.getByTestId("activity-item").filter({ hasText: agentName })
		await expect(activity).toHaveCount(1)
		await expect(activity).toHaveAttribute("data-activity-status", "running")
		const activityFinish = activity.getByRole("button", { name: "Finish", exact: true })
		const activityCancel = activity.getByRole("button", { name: "Cancel", exact: true })
		const activityMetrics = activity.getByTestId("subagent-metrics")
		await expect(activityFinish).toBeVisible()
		await expect(activityCancel).toBeVisible()
		await expect(activity.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0)
		await expect(activityMetrics).toContainText(`${readToolCount} tools`)
		await expect(activityMetrics).toContainText(/In:\S+/)
		await expect(activityMetrics).toContainText(/Out:\S+/)
		await expect(activityMetrics).toContainText(/\$/)
		expect(await activityCancel.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(196, 43, 43)")
		await activity.getByTestId("activity-toggle").click()
		await expect(activity.getByTestId("subagent-activity-task")).toContainText(taskMarker)
		await expect(activity.getByTestId("subagent-activity-context")).toContainText("E2E_SUBAGENT_FINISH_CONTEXT")
		await expect(activity.getByText(/<task>|<context>/)).toHaveCount(0)
		const activityToolSteps = activity.getByTestId("subagent-tool-step")
		await expect(activityToolSteps).toHaveCount(readToolCount)
		const activityToolButton = activityToolSteps.first().getByRole("button")
		await expect(activityToolButton).toBeEnabled()
		await expect(activityToolButton).toHaveAttribute("aria-expanded", "false")
		await activityToolButton.click()
		await expect(activity.getByTestId("subagent-tool-step-details").first()).toContainText(evidenceMarker)
		await attachLocatorScreenshot(activity, testInfo, "subagent-finish-activity-card")

		await activityFinish.click()
		await expect(sidebar.getByText("E2E_SUBAGENT_FINISH_INTERRUPTED_MUST_NOT_RENDER", { exact: false })).toHaveCount(0)
		await expect
			.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 60_000 })
			.toBe(readToolCount + 2)
		await expect(activity).toHaveAttribute("data-activity-status", "completed", { timeout: 60_000 })
		await expect(activity.getByRole("button", { name: "Finish", exact: true })).toHaveCount(0)
		await expect(activity.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0)

		await sidebar.getByRole("tab", { name: "Work", exact: true }).click()
		await expect(sidebar.getByText("E2E_SUBAGENT_FINISH_PARENT_DONE", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await subagentCard.getByRole("button", { name: "Show subagent output" }).click()
		const workOutputScroll = subagentCard.getByTestId("subagent-output-scroll")
		await expect(workOutputScroll).toBeVisible()
		await expect(subagentCard.getByTestId("subagent-output")).toContainText(childResult)
		const outputLayout = await subagentCard.evaluate((element) => {
			const body = element.querySelector<HTMLElement>('[data-testid="subagent-item-body"]')
			const tools = element.querySelector<HTMLElement>('[data-testid="subagent-tools-scroll"]')
			const output = element.querySelector<HTMLElement>('[data-testid="subagent-output-scroll"]')
			if (!body || !tools || !output) throw new Error("Expected independent Work sections after completion")
			const task = element.querySelector<HTMLElement>('[data-testid="subagent-task-scroll"]')
			if (!task) throw new Error("Expected Task section after completion")
			return {
				bodyOverflowY: getComputedStyle(body).overflowY,
				cardHeight: element.getBoundingClientRect().height,
				viewportHeight: window.innerHeight,
				taskClientHeight: task.clientHeight,
				toolsClientHeight: tools.clientHeight,
				outputClientHeight: output.clientHeight,
				outputOverflowY: getComputedStyle(output).overflowY,
				toolsContainsOutput: tools.contains(output),
				outputContainsTools: output.contains(tools),
			}
		})
		expect(outputLayout.bodyOverflowY).toBe("hidden")
		expect(Math.abs(outputLayout.cardHeight - outputLayout.viewportHeight * 0.3)).toBeLessThanOrEqual(2)
		expect(outputLayout.taskClientHeight).toBeGreaterThan(0)
		expect(outputLayout.toolsClientHeight).toBeGreaterThan(0)
		expect(outputLayout.outputClientHeight).toBeGreaterThan(0)
		expect(outputLayout.outputOverflowY).toBe("auto")
		expect(outputLayout.toolsContainsOutput).toBe(false)
		expect(outputLayout.outputContainsTools).toBe(false)
		await attachLocatorScreenshot(subagentCard, testInfo, "subagent-finish-work-output")
		const childConsumptions = server.getMockConsumptions("openai-compatible-responses")
		expect(childConsumptions).toHaveLength(readToolCount + 2)
		expect(childConsumptions[readToolCount].abortedAtMs).toBeDefined()
		expect(childConsumptions.every((consumption) => consumption.contractError === undefined)).toBe(true)
		expect(requestToolNames(childConsumptions[readToolCount + 1])).toEqual(["attempt_completion"])
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Subagent recovery controls - usage-first provider failure remains replayable before semantic output",
	async ({ helper, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		const agentName = "e2e-usage-first-retry"
		const childResult = "E2E_SUBAGENT_USAGE_FIRST_RECOVERED"
		const diagnostic = "E2E_USAGE_FIRST_TRANSIENT_FAILURE"
		await writeSubagent(workspaceDir, agentName, "E2E usage-first retry agent", E2E_PROFILE_NAMES.mockAnthropic)

		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_usage_first_subagent",
				name: "use_subagent",
				arguments: {
					agent_name: agentName,
					task: "E2E_SUBAGENT_USAGE_FIRST_TASK",
					context: "Recover from a usage-only prefix followed by a transient stream error.",
					timeout: 120,
				},
			},
			{
				type: "tool",
				id: "call_usage_first_parent_complete",
				name: "attempt_completion",
				arguments: { result: "E2E_SUBAGENT_USAGE_FIRST_PARENT_DONE" },
				expectedToolResults: [
					{
						callId: "call_usage_first_subagent",
						contentIncludes: childResult,
					},
				],
			},
		)
		server.enqueueResponses(
			"anthropic-messages",
			{
				type: "usage-then-error",
				status: 503,
				code: "service_unavailable",
				message: diagnostic,
				requestId: "req_usage_first_1",
				usage: { inputTokens: 442_700, outputTokens: 0 },
			},
			{
				type: "tool",
				id: "call_usage_first_child_complete",
				name: "attempt_completion",
				arguments: { result: childResult },
			},
		)

		await sendTask(sidebar, "Start a subagent that must retry after a usage-only Provider prefix.")
		await expect(sidebar.getByText(childResult, { exact: false }).last()).toBeVisible({ timeout: 120_000 })
		await expect(sidebar.getByText("E2E_SUBAGENT_USAGE_FIRST_PARENT_DONE", { exact: false }).last()).toBeVisible({
			timeout: 120_000,
		})
		await expect.poll(() => server.getRequestCount("anthropic-messages"), { timeout: 120_000 }).toBe(2)
		const childConsumptions = server.getMockConsumptions("anthropic-messages")
		expect(childConsumptions[0]).toMatchObject({
			responseType: "usage-then-error",
			status: 503,
			usage: { inputTokens: 442_700, outputTokens: 0 },
		})
		expect(childConsumptions[1]).toMatchObject({ responseType: "tool", toolName: "attempt_completion" })
		expect(childConsumptions.every((entry) => entry.contractError === undefined)).toBe(true)
		await expect(sidebar.getByText(diagnostic, { exact: false })).toHaveCount(0)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [new RegExp(diagnostic)])
	},
)

e2e(
	"Subagent recovery controls - Task reopen restores Retry recipe and injects the recovered result once",
	async ({ dlineDocsDir, helper, page, server, sidebar, userDataDir, workspaceDir }, testInfo) => {
		e2e.setTimeout(360_000)
		const agentName = "e2e-recoverable-retry"
		const childTask = "E2E_SUBAGENT_RETRY_TASK"
		const recoveredResult = "E2E_SUBAGENT_RETRY_CHILD_RECOVERED"
		const sensitiveDiagnostic = "E2E_SENSITIVE_PROVIDER_DIAGNOSTIC_MUST_NOT_REACH_PARENT"
		await writeResponsesSubagent(workspaceDir, agentName, "E2E retryable failure recovery agent")

		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_recoverable_retry_subagent",
				name: "use_subagent",
				arguments: {
					agent_name: agentName,
					task: childTask,
					context: "Retry after bounded provider failures and return the recovered finding.",
					timeout: 180,
				},
			},
			{
				type: "tool",
				id: "call_recoverable_retry_ready",
				name: "qna_respond",
				arguments: { response: "E2E_SUBAGENT_RETRY_READY" },
				expectedToolResults: [
					{
						callId: "call_recoverable_retry_subagent",
						contentIncludes: "stopped without producing a result",
					},
				],
				expectedRequestIncludes: [
					"restart it with the Retry control on the subagent activity",
					"Do not treat this as a completed result",
				],
				expectedRequestExcludes: [sensitiveDiagnostic],
			},
			{
				type: "tool",
				id: "call_recoverable_retry_parent_complete",
				name: "attempt_completion",
				arguments: { result: "E2E_SUBAGENT_RETRY_PARENT_DONE" },
				expectedRequestIncludes: [
					"E2E_SUBAGENT_RETRY_FEEDBACK",
					"# Background Results",
					"## Background Subagent Results",
					recoveredResult,
				],
				expectedRequestExcludes: [sensitiveDiagnostic],
			},
			{
				type: "tool",
				id: "call_recoverable_retry_second_parent_complete",
				name: "attempt_completion",
				arguments: { result: "E2E_SUBAGENT_RETRY_SECOND_PARENT_DONE" },
				expectedRequestIncludes: ["E2E_SUBAGENT_RETRY_SECOND_FEEDBACK"],
				expectedRequestExcludes: [sensitiveDiagnostic],
			},
		)
		server.enqueueResponses(
			"openai-compatible-responses",
			...Array.from({ length: 6 }, (_, index) => ({
				type: "error" as const,
				status: 408,
				code: "e2e_subagent_retryable_failure",
				message: sensitiveDiagnostic,
				requestId: `req_subagent_retry_${index + 1}`,
			})),
			{
				type: "tool",
				id: "call_recoverable_retry_child_complete",
				name: "attempt_completion",
				arguments: { result: recoveredResult },
				delayMs: 2_000,
			},
		)

		await sendTask(sidebar, "Start a subagent that must expose Retry after bounded provider failures.")

		await expect(sidebar.getByText("E2E_SUBAGENT_RETRY_READY", { exact: true })).toBeVisible({ timeout: 180_000 })
		await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 180_000 }).toBe(6)
		const taskHeading = sidebar.getByRole("heading", { name: childTask, exact: true }).last()
		const subagentCard = taskHeading.locator("xpath=ancestor::*[@data-testid='subagent-item'][1]")
		await expect(taskHeading).toBeVisible()
		const workRetry = subagentCard.getByRole("button", { name: "Retry", exact: true })
		await expect(workRetry).toBeVisible()
		await expect(subagentCard.getByRole("button", { name: "Finish", exact: true })).toHaveCount(0)
		await subagentCard.getByRole("button", { name: "Show subagent output" }).click()
		const workRetryOutput = subagentCard.getByTestId("subagent-output-scroll")
		await expect(workRetryOutput.getByTestId("subagent-retry-attempt")).toHaveCount(5)
		await expect(workRetryOutput).toContainText("Retry 1/5")
		await expect(workRetryOutput).toContainText("wait 5s")
		await expect(workRetryOutput).toContainText("Retry 5/5")
		await expect(workRetryOutput).toContainText("wait 17s")
		await expect(workRetryOutput).toContainText("total 55s")
		await attachLocatorScreenshot(subagentCard, testInfo, "subagent-retry-work-card")

		await sidebar.getByRole("tab", { name: /^Activities(?: \d+)?$/ }).click()
		await sidebar.getByRole("button", { name: "All", exact: true }).first().click()
		const activity = sidebar.getByTestId("activity-item").filter({ hasText: agentName })
		await expect(activity).toHaveCount(1)
		await expect(activity).toHaveAttribute("data-activity-status", "failed")
		const activityRetry = activity.getByRole("button", { name: "Retry", exact: true })
		await expect(activityRetry).toBeVisible()
		await expect(activity.getByRole("button", { name: "Finish", exact: true })).toHaveCount(0)
		await activity.getByTestId("activity-toggle").click()
		const activityRetryTimeline = activity.getByTestId("subagent-retry-timeline")
		await expect(activityRetryTimeline.getByTestId("subagent-retry-attempt")).toHaveCount(5)
		await expect(activityRetryTimeline).toContainText("Retry 5/5")
		await expect(activityRetryTimeline).toContainText("total 55s")
		await attachLocatorScreenshot(activity, testInfo, "subagent-retry-activity-card")

		const taskId = await onlyTaskId(dlineDocsDir)
		const failedActivity = await readSubagentActivity(dlineDocsDir, taskId)
		expect(failedActivity).toMatchObject({
			status: "failed",
			currentAttempt: 1,
			retryRecipe: { kind: "subagent", schemaVersion: 1, retryable: true },
		})

		await sidebar.getByRole("tab", { name: "Work", exact: true }).click()
		const parentTaskText = "Start a subagent that must expose Retry after bounded provider failures."
		await closeCurrentTask(sidebar)
		await reopenTask(page, sidebar, parentTaskText)
		const reopenedCard = sidebar.getByTestId("subagent-item").filter({ hasText: agentName })
		await expect(reopenedCard.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: 30_000 })
		await sidebar.getByRole("tab", { name: /^Activities(?: \d+)?$/ }).click()
		await sidebar.getByRole("button", { name: "All", exact: true }).first().click()
		const reopenedActivity = sidebar.getByTestId("activity-item").filter({ hasText: agentName })
		await expect(reopenedActivity).toHaveAttribute("data-activity-status", "failed")
		const reopenedRetry = reopenedActivity.getByRole("button", { name: "Retry", exact: true })
		await expect(reopenedRetry).toBeVisible()

		await reopenedRetry.click()
		await expect(reopenedActivity).toHaveAttribute("data-activity-status", "running", { timeout: 30_000 })
		await expect(reopenedActivity.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0)
		await expect(reopenedActivity.getByRole("button", { name: "Finish", exact: true })).toBeVisible()
		await attachLocatorScreenshot(reopenedActivity, testInfo, "subagent-retry-running-activity-card")
		await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 60_000 }).toBe(7)
		await expect(reopenedActivity).toHaveAttribute("data-activity-status", "completed", { timeout: 60_000 })
		await expect(reopenedActivity.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0)
		await expect(reopenedActivity.getByRole("button", { name: "Finish", exact: true })).toHaveCount(0)
		await expect
			.poll(async () => Number((await readSubagentActivity(dlineDocsDir, taskId)).currentAttempt), { timeout: 30_000 })
			.toBe(2)

		await sidebar.getByRole("tab", { name: "Work", exact: true }).click()
		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_SUBAGENT_RETRY_FEEDBACK")
		await input.press("Enter")
		await expect(sidebar.getByText("E2E_SUBAGENT_RETRY_PARENT_DONE", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await input.fill("E2E_SUBAGENT_RETRY_SECOND_FEEDBACK")
		await input.press("Enter")
		await expect(sidebar.getByText("E2E_SUBAGENT_RETRY_SECOND_PARENT_DONE", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})

		const parentConsumptions = server.getMockConsumptions("openai-compatible-chat")
		expect(parentConsumptions).toHaveLength(4)
		const firstInjectionRequest = JSON.stringify(parentConsumptions[2].requestBody)
		const secondInjectionRequest = JSON.stringify(parentConsumptions[3].requestBody)
		expect(countOccurrences(firstInjectionRequest, "# Background Results")).toBe(1)
		expect(countOccurrences(secondInjectionRequest, "# Background Results")).toBe(1)
		expect(countOccurrences(secondInjectionRequest, recoveredResult)).toBe(1)
		expect(firstInjectionRequest).not.toContain(sensitiveDiagnostic)
		expect(secondInjectionRequest).not.toContain(sensitiveDiagnostic)
		const childConsumptions = server.getMockConsumptions("openai-compatible-responses")
		expect(childConsumptions).toHaveLength(7)
		expect(childConsumptions.slice(0, 6).every((entry) => entry.responseType === "error" && entry.status === 408)).toBe(true)
		expect(childConsumptions[6]).toMatchObject({ responseType: "tool", toolName: "attempt_completion" })
		expect(childConsumptions.every((entry) => entry.contractError === undefined)).toBe(true)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [
			/E2E_SENSITIVE_PROVIDER_DIAGNOSTIC_MUST_NOT_REACH_PARENT/,
		])
	},
)

// BUGFIX-022: reproduce the exact upstream gateway payload observed in the field.
// The `stream_read_error` code sits outside every previously enumerated retry
// allow-list, so the subagent used to fail on the first attempt with no Retry
// control at all. The whole backoff sequence must now run.
e2e(
	"Subagent recovery controls - upstream stream_read_error exhausts the backoff sequence and exposes Retry",
	async ({ helper, server, sidebar, userDataDir, workspaceDir }, testInfo) => {
		e2e.setTimeout(360_000)
		const agentName = "e2e-stream-read-error"
		const childTask = "E2E_STREAM_READ_ERROR_TASK"
		const recoveredResult = "E2E_STREAM_READ_ERROR_CHILD_RECOVERED"
		await writeResponsesSubagent(workspaceDir, agentName, "E2E upstream stream_read_error agent")

		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_stream_read_error_subagent",
				name: "use_subagent",
				arguments: {
					agent_name: agentName,
					task: childTask,
					context: "Survive the upstream stream_read_error and report the recovered finding.",
					timeout: 180,
				},
			},
			{
				type: "tool",
				id: "call_stream_read_error_ready",
				name: "qna_respond",
				arguments: { response: "E2E_STREAM_READ_ERROR_READY" },
				expectedToolResults: [
					{
						callId: "call_stream_read_error_subagent",
						contentIncludes: "stopped without producing a result",
					},
				],
				expectedRequestIncludes: ["Retry control"],
			},
			{
				type: "tool",
				id: "call_stream_read_error_parent_complete",
				name: "attempt_completion",
				arguments: { result: "E2E_STREAM_READ_ERROR_PARENT_DONE" },
				expectedRequestIncludes: ["E2E_STREAM_READ_ERROR_FEEDBACK", recoveredResult],
			},
		)
		// The real gateway emits `{"error":{"code":"stream_read_error",...},"sequence_number":0,"type":"error"}`
		// followed by `response.failed` with `upstream_error` and HTTP 502.
		//
		// The OpenAI SDK retries 5xx once on its own before the error surfaces to
		// SubagentRunner, so a single subagent attempt drains two queued errors.
		// Queue enough failures to starve all six subagent attempts, then assert the
		// product-visible backoff instead of the SDK-dependent request count.
		server.enqueueResponses(
			"openai-compatible-responses",
			...Array.from({ length: MAX_INITIAL_STREAM_ATTEMPTS * SDK_REQUESTS_PER_ATTEMPT }, (_, index) => ({
				type: "error" as const,
				status: 502,
				code: "stream_read_error",
				message: "stream_read_error",
				requestId: `req_stream_read_error_${index + 1}`,
			})),
		)

		await sendTask(sidebar, "Start a subagent that must survive an upstream stream_read_error.")

		await expect(sidebar.getByText("E2E_STREAM_READ_ERROR_READY", { exact: true })).toBeVisible({ timeout: 240_000 })

		const taskHeading = sidebar.getByRole("heading", { name: childTask, exact: true }).last()
		const subagentCard = taskHeading.locator("xpath=ancestor::*[@data-testid='subagent-item'][1]")
		await expect(taskHeading).toBeVisible()
		await expect(subagentCard.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
		await subagentCard.getByRole("button", { name: "Show subagent output" }).click()
		const retryOutput = subagentCard.getByTestId("subagent-output-scroll")
		await expect(retryOutput.getByTestId("subagent-retry-attempt")).toHaveCount(5)
		await expect(retryOutput).toContainText("total 55s")
		await attachLocatorScreenshot(subagentCard, testInfo, "subagent-stream-read-error-card")

		await sidebar.getByRole("tab", { name: /^Activities(?: \d+)?$/ }).click()
		await sidebar.getByRole("button", { name: "All", exact: true }).first().click()
		const activity = sidebar.getByTestId("activity-item").filter({ hasText: agentName })
		await expect(activity).toHaveAttribute("data-activity-status", "failed")
		const activityRetry = activity.getByRole("button", { name: "Retry", exact: true })
		await expect(activityRetry).toBeVisible()

		const failedRequestCount = server.getRequestCount("openai-compatible-responses")
		server.clearPendingResponses("openai-compatible-responses")
		server.enqueueResponses("openai-compatible-responses", {
			type: "tool",
			id: "call_stream_read_error_child_complete",
			name: "attempt_completion",
			arguments: { result: recoveredResult },
		})

		await activityRetry.click()
		await expect(activity).toHaveAttribute("data-activity-status", "completed", { timeout: 120_000 })
		await expect
			.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 120_000 })
			.toBe(failedRequestCount + 1)

		await sidebar.getByRole("tab", { name: "Work", exact: true }).click()
		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_STREAM_READ_ERROR_FEEDBACK")
		await input.press("Enter")
		await expect(sidebar.getByText("E2E_STREAM_READ_ERROR_PARENT_DONE", { exact: false }).last()).toBeVisible({
			timeout: 120_000,
		})

		const childConsumptions = server.getMockConsumptions("openai-compatible-responses")
		expect(childConsumptions).toHaveLength(failedRequestCount + 1)
		expect(
			childConsumptions
				.slice(0, failedRequestCount)
				.every((entry) => entry.responseType === "error" && entry.status === 502),
		).toBe(true)
		expect(childConsumptions.at(-1)).toMatchObject({ responseType: "tool", toolName: "attempt_completion" })
		expect(childConsumptions.every((entry) => entry.contractError === undefined)).toBe(true)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/stream_read_error/])
	},
)

// BUGFIX-022: a cancelled subagent produced no result, so the user must be able
// to restart it. Retry used to be reachable only from a `failed` activity.
e2e(
	"Subagent recovery controls - a cancelled subagent stays retryable and recovers its result",
	async ({ helper, server, sidebar, userDataDir, workspaceDir }, testInfo) => {
		e2e.setTimeout(300_000)
		const agentName = "e2e-cancel-retry"
		const childTask = "E2E_SUBAGENT_CANCEL_RETRY_TASK"
		const recoveredResult = "E2E_SUBAGENT_CANCEL_RETRY_RECOVERED"
		await writeResponsesSubagent(workspaceDir, agentName, "E2E cancelled subagent retry agent")

		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_cancel_retry_subagent",
				name: "use_subagent",
				arguments: {
					agent_name: agentName,
					task: childTask,
					context: "Stay active until the user cancels, then recover on Retry.",
					background: true,
					timeout: 180,
				},
			},
			{
				type: "tool",
				id: "call_cancel_retry_ready",
				name: "qna_respond",
				arguments: { response: "E2E_SUBAGENT_CANCEL_RETRY_READY" },
			},
			{
				type: "tool",
				id: "call_cancel_retry_parent_complete",
				name: "attempt_completion",
				arguments: { result: "E2E_SUBAGENT_CANCEL_RETRY_PARENT_DONE" },
				expectedRequestIncludes: ["E2E_SUBAGENT_CANCEL_RETRY_FEEDBACK", recoveredResult],
			},
		)
		server.enqueueResponses(
			"openai-compatible-responses",
			// Hold the child long enough to cancel it, but keep the delay well below
			// the test budget: the mock only releases its socket when the delay
			// elapses or the connection closes, and a multi-minute hold would stall
			// the retry request behind the abandoned one.
			{
				type: "tool",
				id: "call_cancel_retry_child_never_completes",
				name: "attempt_completion",
				arguments: { result: "E2E_SUBAGENT_CANCEL_RETRY_MUST_NOT_COMPLETE" },
				delayMs: 25_000,
			},
			{
				type: "tool",
				id: "call_cancel_retry_child_complete",
				name: "attempt_completion",
				arguments: { result: recoveredResult },
			},
		)

		await sendTask(sidebar, "Start a background subagent that must remain retryable after cancellation.")
		await expect(sidebar.getByText("E2E_SUBAGENT_CANCEL_RETRY_READY", { exact: true })).toBeVisible({ timeout: 180_000 })

		await sidebar.getByRole("tab", { name: /^Activities(?: \d+)?$/ }).click()
		await sidebar.getByRole("button", { name: "All", exact: true }).first().click()
		const activity = sidebar.getByTestId("activity-item").filter({ hasText: agentName })
		await expect(activity).toHaveAttribute("data-activity-status", "running", { timeout: 60_000 })
		await activity.getByRole("button", { name: "Cancel", exact: true }).click()
		await expect(activity).toHaveAttribute("data-activity-status", "cancelled", { timeout: 60_000 })

		// The regression: a cancelled subagent used to expose no recovery control.
		const activityRetry = activity.getByRole("button", { name: "Retry", exact: true })
		await expect(activityRetry).toBeVisible({ timeout: 30_000 })
		await attachLocatorScreenshot(activity, testInfo, "subagent-cancelled-retryable-activity")

		await activityRetry.click()
		await expect(activity).toHaveAttribute("data-activity-status", "completed", { timeout: 120_000 })

		await sidebar.getByRole("tab", { name: "Work", exact: true }).click()
		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_SUBAGENT_CANCEL_RETRY_FEEDBACK")
		await input.press("Enter")
		await expect(sidebar.getByText("E2E_SUBAGENT_CANCEL_RETRY_PARENT_DONE", { exact: false }).last()).toBeVisible({
			timeout: 120_000,
		})
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

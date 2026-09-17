import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

e2e.use({ installVsix: false })

interface TaskPromptContext {
	systemPrompt?: {
		frozen?: {
			text: string
			refreshedAt: number
			refreshReason: string
		}
	}
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

async function onlyTaskId(dlineDocsDir: string): Promise<string> {
	const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true })
	const taskIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
	expect(taskIds).toHaveLength(1)
	return taskIds[0]
}

async function readPromptContext(dlineDocsDir: string, taskId: string): Promise<TaskPromptContext> {
	return JSON.parse(await readFile(path.join(dlineDocsDir, "tasks", taskId, "context.json"), "utf8"))
}

e2e(
	"Task header - manual prompt refresh confirms durable context without starting an API turn",
	async ({ dlineDocsDir, helper, page, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		const capabilityMarker = "E2E_PROMPT_REFRESH_CAPABILITY_MARKER"
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				name: "attempt_completion",
				arguments: { result: "E2E_PROMPT_REFRESH_READY" },
			},
			{
				type: "tool",
				name: "qna_respond",
				arguments: { response: "E2E_PROMPT_CACHE_STILL_FROZEN" },
				expectedRequestExcludes: [capabilityMarker],
			},
			{
				type: "tool",
				name: "attempt_completion",
				arguments: { result: "E2E_PROMPT_REFRESH_APPLIED" },
				expectedRequestIncludes: [capabilityMarker, "E2E_PROMPT_REFRESH_FEEDBACK"],
			},
		)

		await sendTask(sidebar, "Create a completed task for manual prompt refresh.")
		await expect(sidebar.getByText("E2E_PROMPT_REFRESH_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		const taskId = await onlyTaskId(dlineDocsDir)
		await expect.poll(async () => Boolean((await readPromptContext(dlineDocsDir, taskId)).systemPrompt?.frozen)).toBe(true)
		const initialContext = await readPromptContext(dlineDocsDir, taskId)
		const before = initialContext.systemPrompt?.frozen
		if (!before) throw new Error("Initial task prompt cache was not persisted")
		expect(before.text).not.toContain(capabilityMarker)
		const refreshButton = sidebar.locator("button:has(svg.lucide-refresh-cw)").first()
		const freshnessWarning = refreshButton.getByTestId("prompt-freshness-warning")
		await expect(refreshButton).toBeVisible()
		await expect(freshnessWarning).toHaveCount(0)

		const subagentDirectory = path.join(workspaceDir, ".agents", "subagents")
		await mkdir(subagentDirectory, { recursive: true })
		await writeFile(
			path.join(subagentDirectory, "e2e-prompt-refresh.yml"),
			`---
name: e2e-prompt-refresh
description: ${capabilityMarker}
tools: read_file
---

Read only the files needed for the requested review.`,
			"utf8",
		)

		await sendTask(sidebar, "E2E_PROMPT_CACHE_BEFORE_MANUAL_REFRESH")
		await expect(sidebar.getByText("E2E_PROMPT_CACHE_STILL_FROZEN", { exact: true })).toBeVisible({ timeout: 60_000 })
		await expect.poll(() => server.openAiRequestCount).toBe(2)
		const frozenBeforeManualRefresh = await readPromptContext(dlineDocsDir, taskId)
		expect(frozenBeforeManualRefresh.systemPrompt?.frozen?.refreshedAt).toBe(before.refreshedAt)
		expect(frozenBeforeManualRefresh.systemPrompt?.frozen?.text).not.toContain(capabilityMarker)
		await expect(freshnessWarning).toBeVisible()
		await refreshButton.hover()
		const freshnessTooltip = sidebar.getByRole("tooltip").filter({ hasText: "Prompt update available" })
		await expect(freshnessTooltip).toContainText("The current task is still using its previous prompt and tool snapshot.")
		await expect(freshnessTooltip).toContainText("Subagents changed")
		await expect(freshnessTooltip).toContainText("Click to review and refresh.")

		const requestCount = server.openAiRequestCount
		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_PROMPT_REFRESH_DRAFT")

		await refreshButton.click()
		const dialog = sidebar.getByRole("dialog")
		await expect(dialog.getByRole("heading", { name: "Refresh Prompt Cache", exact: true })).toBeVisible()
		await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
		await expect(sidebar.getByRole("heading", { name: "Refresh Prompt Cache", exact: true })).not.toBeVisible()
		await expect(input).toHaveValue("E2E_PROMPT_REFRESH_DRAFT")
		const afterCancel = await readPromptContext(dlineDocsDir, taskId)
		expect(afterCancel.systemPrompt?.frozen?.refreshedAt).toBe(before.refreshedAt)
		expect(server.openAiRequestCount).toBe(requestCount)
		await expect(freshnessWarning).toBeVisible()

		await refreshButton.click()
		await dialog.getByRole("button", { name: "Confirm", exact: true }).click()
		await expect(sidebar.getByRole("heading", { name: "Refresh Prompt Cache", exact: true })).not.toBeVisible()
		await expect
			.poll(async () => {
				const context = await readPromptContext(dlineDocsDir, taskId)
				return context.systemPrompt?.frozen
			})
			.toMatchObject({ refreshReason: "manual" })
		const afterConfirm = await readPromptContext(dlineDocsDir, taskId)
		const refreshed = afterConfirm.systemPrompt?.frozen
		if (!refreshed) throw new Error("Manual prompt refresh did not persist a frozen prompt")
		expect(refreshed.refreshedAt).toBeGreaterThan(before.refreshedAt)
		expect(refreshed.text).toContain(capabilityMarker)
		await expect(freshnessWarning).toHaveCount(0)
		await expect(input).toHaveValue("E2E_PROMPT_REFRESH_DRAFT")
		await page.waitForTimeout(500)
		expect(server.openAiRequestCount).toBe(requestCount)

		await input.fill("E2E_PROMPT_REFRESH_FEEDBACK")
		await input.press("Enter")
		await expect(input).toHaveValue("")
		await expect(sidebar.getByText("E2E_PROMPT_REFRESH_APPLIED", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		await expect.poll(() => server.openAiRequestCount).toBe(3)
		expect(server.getMockConsumptions("openai-compatible-chat")[2].contractError).toBeUndefined()
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

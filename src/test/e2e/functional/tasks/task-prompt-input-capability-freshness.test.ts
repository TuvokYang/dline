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
	await expect(input).toBeEnabled()
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
	"Prompt input freshness - Rules changes mark the frozen prompt stale before another API request",
	async ({ dlineDocsDir, helper, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		await helper.signin(sidebar)

		const rulesV1 = "E2E_PROMPT_INPUT_RULES_V1"
		const rulesV2 = "E2E_PROMPT_INPUT_RULES_V2"
		const rulesDirectory = path.join(workspaceDir, ".agents", "rules")
		const rulesPath = path.join(rulesDirectory, "e2e-prompt-input-freshness.md")
		await mkdir(rulesDirectory, { recursive: true })
		await writeFile(rulesPath, `# Prompt input freshness\n\n${rulesV1}\n`, "utf8")

		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				name: "attempt_completion",
				arguments: { result: "E2E_PROMPT_INPUT_FRESHNESS_READY" },
				expectedRequestIncludes: [rulesV1],
				expectedRequestExcludes: [rulesV2],
			},
			{
				type: "tool",
				name: "qna_respond",
				arguments: { response: "E2E_PROMPT_INPUT_STILL_FROZEN" },
				expectedRequestIncludes: [rulesV1, "E2E_PROMPT_INPUT_BEFORE_REFRESH"],
				expectedRequestExcludes: [rulesV2],
			},
			{
				type: "tool",
				name: "attempt_completion",
				arguments: { result: "E2E_PROMPT_INPUT_REFRESH_APPLIED" },
				expectedRequestIncludes: [rulesV2, "E2E_PROMPT_INPUT_AFTER_REFRESH"],
				expectedRequestExcludes: [rulesV1],
			},
		)

		await sendTask(sidebar, "Create a frozen prompt using the first Rules version.")
		await expect(sidebar.getByText("E2E_PROMPT_INPUT_FRESHNESS_READY", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(1)

		const taskId = await onlyTaskId(dlineDocsDir)
		await expect.poll(async () => Boolean((await readPromptContext(dlineDocsDir, taskId)).systemPrompt?.frozen)).toBe(true)
		const initialContext = await readPromptContext(dlineDocsDir, taskId)
		const initialFrozen = initialContext.systemPrompt?.frozen
		if (!initialFrozen) throw new Error("Initial task prompt cache was not persisted")
		expect(initialFrozen.text).toContain(rulesV1)
		expect(initialFrozen.text).not.toContain(rulesV2)

		const refreshButton = sidebar.locator("button:has(svg.lucide-refresh-cw)").first()
		const freshnessWarning = refreshButton.getByTestId("prompt-freshness-warning")
		await expect(refreshButton).toBeVisible()
		await expect(freshnessWarning).toHaveCount(0)

		await writeFile(rulesPath, `# Prompt input freshness\n\n${rulesV2}\n`, "utf8")

		await expect(freshnessWarning).toBeVisible({ timeout: 30_000 })
		expect(server.getRequestCount("openai-compatible-chat")).toBe(1)
		const staleContext = await readPromptContext(dlineDocsDir, taskId)
		expect(staleContext.systemPrompt?.frozen?.refreshedAt).toBe(initialFrozen.refreshedAt)
		expect(staleContext.systemPrompt?.frozen?.text).toContain(rulesV1)
		expect(staleContext.systemPrompt?.frozen?.text).not.toContain(rulesV2)
		await refreshButton.hover()
		const freshnessTooltip = sidebar.getByRole("tooltip").filter({ hasText: "Prompt update available" })
		await expect(freshnessTooltip).toContainText("Rules changed")

		await sendTask(sidebar, "E2E_PROMPT_INPUT_BEFORE_REFRESH")
		await expect(sidebar.getByText("E2E_PROMPT_INPUT_STILL_FROZEN", { exact: true })).toBeVisible({ timeout: 60_000 })
		await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(2)
		expect(server.getMockConsumptions("openai-compatible-chat")[1]?.contractError).toBeUndefined()
		await expect(freshnessWarning).toBeVisible()
		const beforeManualRefresh = await readPromptContext(dlineDocsDir, taskId)
		expect(beforeManualRefresh.systemPrompt?.frozen?.refreshedAt).toBe(initialFrozen.refreshedAt)

		await refreshButton.click()
		const dialog = sidebar.getByRole("dialog")
		await expect(dialog.getByRole("heading", { name: "Refresh Prompt Cache", exact: true })).toBeVisible()
		await dialog.getByRole("button", { name: "Confirm", exact: true }).click()
		await expect(sidebar.getByRole("heading", { name: "Refresh Prompt Cache", exact: true })).not.toBeVisible()
		await expect
			.poll(async () => (await readPromptContext(dlineDocsDir, taskId)).systemPrompt?.frozen)
			.toMatchObject({ refreshReason: "manual" })

		const refreshedContext = await readPromptContext(dlineDocsDir, taskId)
		const refreshedFrozen = refreshedContext.systemPrompt?.frozen
		if (!refreshedFrozen) throw new Error("Manual prompt refresh did not persist a frozen prompt")
		expect(refreshedFrozen.refreshedAt).toBeGreaterThan(initialFrozen.refreshedAt)
		expect(refreshedFrozen.text).toContain(rulesV2)
		expect(refreshedFrozen.text).not.toContain(rulesV1)
		await expect(freshnessWarning).toHaveCount(0)
		expect(server.getRequestCount("openai-compatible-chat")).toBe(2)

		await sendTask(sidebar, "E2E_PROMPT_INPUT_AFTER_REFRESH")
		await expect(sidebar.getByText("E2E_PROMPT_INPUT_REFRESH_APPLIED", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(3)
		expect(server.getMockConsumptions("openai-compatible-chat")[2]?.contractError).toBeUndefined()
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

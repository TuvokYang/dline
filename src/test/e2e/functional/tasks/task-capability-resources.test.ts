import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Locator } from "@playwright/test"
import { parseTaskCapabilityToggles, type TaskCapabilityToggles } from "@shared/TaskCapabilityToggles"

e2e.use({ installVsix: false })

const SKILL_NAME = "e2e-live-skill"
const WORKFLOW_NAME = "e2e-live-workflow"
const SUBAGENT_NAME = "e2e-live-agent"
const MCP_NAME = "e2e-live-mcp"
const MCP_TOOL_NAME = "e2e_workspace_echo"

interface TaskPromptContext {
	systemPrompt?: {
		frozen?: {
			text: string
			refreshedAt: number
			refreshReason: string
		}
	}
}

interface CapabilityFiles {
	skill: string
	workflow: string
	subagent: string
	mcp: string
}

async function taskIds(dlineDocsDir: string): Promise<string[]> {
	const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true })
	return entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
}

async function onlyTaskId(dlineDocsDir: string): Promise<string> {
	const ids = await taskIds(dlineDocsDir)
	expect(ids).toHaveLength(1)
	return ids[0]
}

async function readTaskCapabilityToggles(dlineDocsDir: string, taskId: string): Promise<TaskCapabilityToggles> {
	const settings = JSON.parse(await readFile(path.join(dlineDocsDir, "tasks", taskId, "settings.json"), "utf8")) as {
		taskCapabilityToggles?: string
	}
	const toggles = parseTaskCapabilityToggles(settings.taskCapabilityToggles)
	if (!toggles) throw new Error("Task capability toggles were not persisted")
	return toggles
}

/**
 * Read the toggles once the task has actually flushed them.
 *
 * The task directory appears before settings.json is written, so a bare read
 * right after the id shows up races the flush and fails with ENOENT.
 */
async function waitForTaskCapabilityToggles(dlineDocsDir: string, taskId: string): Promise<TaskCapabilityToggles> {
	let toggles: TaskCapabilityToggles | undefined
	await expect
		.poll(
			async () => {
				try {
					toggles = await readTaskCapabilityToggles(dlineDocsDir, taskId)
					return true
				} catch {
					return false
				}
			},
			{ timeout: 30_000 },
		)
		.toBe(true)
	if (!toggles) throw new Error("Task capability toggles were not persisted")
	return toggles
}

async function readPromptContext(dlineDocsDir: string, taskId: string): Promise<TaskPromptContext> {
	return JSON.parse(await readFile(path.join(dlineDocsDir, "tasks", taskId, "context.json"), "utf8"))
}

function capabilityRow(sidebar: Frame, name: string): Locator {
	return sidebar.getByText(name, { exact: true }).locator("xpath=ancestor::div[contains(@class, 'mb-2.5')][1]")
}

function taskResourceId(filePath: string): string {
	return process.platform === "win32"
		? filePath.replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`)
		: filePath
}

async function expectToggle(sidebar: Frame, name: string, enabled: boolean): Promise<Locator> {
	const toggle = capabilityRow(sidebar, name).getByRole("switch")
	await expect(toggle).toHaveCount(1)
	await expect(toggle).toHaveAttribute("data-state", enabled ? "checked" : "unchecked")
	return toggle
}

async function setToggle(sidebar: Frame, name: string, enabled: boolean): Promise<void> {
	const toggle = await expectToggle(sidebar, name, !enabled)
	await toggle.click()
	await expect(toggle).toHaveAttribute("data-state", enabled ? "checked" : "unchecked")
}

async function openCapabilityModal(sidebar: Frame): Promise<void> {
	const button = sidebar.getByRole("button", { name: "Show Dline Rules & Workflows", exact: true }).first()
	await expect(button).toBeVisible()
	await button.click()
	await expect(sidebar.getByRole("button", { name: "Hide Dline Rules & Workflows", exact: true }).first()).toBeVisible()
}

async function closeCapabilityModal(sidebar: Frame): Promise<void> {
	await sidebar.getByRole("button", { name: "Hide Dline Rules & Workflows", exact: true }).first().click()
	await expect(sidebar.getByRole("button", { name: "Show Dline Rules & Workflows", exact: true }).first()).toBeVisible()
}

async function selectCapabilityTab(sidebar: Frame, name: "Workflows" | "Skills" | "Subagents"): Promise<void> {
	const tab = sidebar.getByRole("button", { name, exact: true })
	await tab.click()
	await expect(tab).toHaveAttribute("aria-pressed", "true")
}

async function openMcpModal(sidebar: Frame): Promise<void> {
	const button = sidebar.getByRole("button", { name: "Show MCP Servers", exact: true }).first()
	await expect(button).toBeVisible()
	await button.click()
	await expect(sidebar.getByRole("button", { name: "Hide MCP Servers", exact: true }).first()).toBeVisible()
}

async function closeMcpModal(sidebar: Frame): Promise<void> {
	await sidebar.getByRole("button", { name: "Hide MCP Servers", exact: true }).first().click()
	await expect(sidebar.getByRole("button", { name: "Show MCP Servers", exact: true }).first()).toBeVisible()
}

async function createPromptCapabilities(workspaceDir: string): Promise<Omit<CapabilityFiles, "mcp">> {
	const skillDirectory = path.join(workspaceDir, ".agents", "skills", SKILL_NAME)
	const workflowDirectory = path.join(workspaceDir, ".agents", "workflows")
	const subagentDirectory = path.join(workspaceDir, ".agents", "subagents")
	await Promise.all([
		mkdir(skillDirectory, { recursive: true }),
		mkdir(workflowDirectory, { recursive: true }),
		mkdir(subagentDirectory, { recursive: true }),
	])
	const skill = path.join(skillDirectory, "SKILL.md")
	const workflow = path.join(workflowDirectory, `${WORKFLOW_NAME}.md`)
	const subagent = path.join(subagentDirectory, `${SUBAGENT_NAME}.yml`)
	await Promise.all([
		writeFile(
			skill,
			[
				"---",
				`name: ${SKILL_NAME}`,
				"description: E2E live skill capability marker",
				"---",
				"Use this skill only for the focused E2E capability test.",
			].join("\n"),
			"utf8",
		),
		writeFile(
			workflow,
			[
				"---",
				`name: ${WORKFLOW_NAME}`,
				"description: E2E live workflow capability marker",
				"---",
				"Run the focused E2E capability workflow.",
			].join("\n"),
			"utf8",
		),
		writeFile(
			subagent,
			[
				"---",
				`name: ${SUBAGENT_NAME}`,
				"description: E2E live subagent capability marker",
				"tools:",
				"  - read_file",
				"skills: []",
				"---",
				"Read the requested file and report the result.",
			].join("\n"),
			"utf8",
		),
	])
	return { skill, workflow, subagent }
}

async function createMcpCapability(workspaceDir: string): Promise<string> {
	const descriptorDirectory = path.join(workspaceDir, ".agents", "mcp")
	await mkdir(descriptorDirectory, { recursive: true })
	const descriptorPath = path.join(descriptorDirectory, `${MCP_NAME}.json`)
	await writeFile(
		descriptorPath,
		JSON.stringify(
			{
				name: MCP_NAME,
				description: "E2E live workspace MCP capability marker",
				type: "stdio",
				command: process.execPath,
				args: [path.join(E2ETestHelper.E2E_TESTS_DIR, "fixtures", "workspace-mcp-server.mjs")],
			},
			null,
			2,
		),
		"utf8",
	)
	return descriptorPath
}

function expectCapabilityState(
	toggles: TaskCapabilityToggles,
	files: CapabilityFiles,
	mcpInternalName: string,
	enabled: boolean,
): void {
	expect({
		skills: toggles.localSkillsToggles,
		workflows: toggles.localWorkflowToggles,
		subagents: toggles.localSubagentsToggles,
		mcp: toggles.mcpServers,
	}).toEqual({
		skills: expect.objectContaining({ [taskResourceId(files.skill)]: enabled }),
		workflows: expect.objectContaining({ [taskResourceId(files.workflow)]: enabled }),
		subagents: expect.objectContaining({ [taskResourceId(files.subagent)]: enabled }),
		mcp: expect.objectContaining({ [mcpInternalName]: enabled }),
	})
}

e2e(
	"Task capability resources scan live, persist per task, and enter the prompt only after refresh",
	async ({ dlineDocsDir, helper, page, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(300_000)
		const webviewErrors: string[] = []
		page.on("console", (message) => {
			if (message.type() === "error") webviewErrors.push(message.text())
		})
		page.on("pageerror", (error) => webviewErrors.push(error.stack ?? error.message))
		await helper.signin(sidebar)

		const input = sidebar.getByTestId("chat-input")
		await input.fill("Verify task-local capability resources.")
		await openCapabilityModal(sidebar)

		const promptFiles = await createPromptCapabilities(workspaceDir)
		await selectCapabilityTab(sidebar, "Workflows")
		await expect(capabilityRow(sidebar, `${WORKFLOW_NAME}.md`)).toBeVisible({ timeout: 30_000 })
		await selectCapabilityTab(sidebar, "Skills")
		await expect(capabilityRow(sidebar, SKILL_NAME)).toBeVisible({ timeout: 30_000 })
		await selectCapabilityTab(sidebar, "Subagents")
		await expect(capabilityRow(sidebar, SUBAGENT_NAME)).toBeVisible({ timeout: 30_000 })

		await selectCapabilityTab(sidebar, "Workflows")
		await setToggle(sidebar, `${WORKFLOW_NAME}.md`, false)
		await selectCapabilityTab(sidebar, "Skills")
		await setToggle(sidebar, SKILL_NAME, false)
		await selectCapabilityTab(sidebar, "Subagents")
		await setToggle(sidebar, SUBAGENT_NAME, false)
		await closeCapabilityModal(sidebar)

		await openMcpModal(sidebar)
		await expect(sidebar.getByText(MCP_NAME, { exact: true })).toHaveCount(0)
		const mcp = await createMcpCapability(workspaceDir)
		await expect(capabilityRow(sidebar, MCP_NAME)).toBeVisible({ timeout: 30_000 })
		await setToggle(sidebar, MCP_NAME, false)
		await closeMcpModal(sidebar)

		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				name: "attempt_completion",
				arguments: { result: "E2E_CAPABILITY_TASK_READY" },
				expectedRequestExcludes: [SKILL_NAME, WORKFLOW_NAME, SUBAGENT_NAME, MCP_TOOL_NAME],
			},
			{
				type: "tool",
				name: "attempt_completion",
				arguments: { result: "E2E_CAPABILITY_REFRESH_APPLIED" },
				expectedRequestIncludes: [
					SKILL_NAME,
					WORKFLOW_NAME,
					SUBAGENT_NAME,
					MCP_TOOL_NAME,
					"E2E_CAPABILITY_REFRESH_FEEDBACK",
				],
			},
			{
				type: "tool",
				name: "attempt_completion",
				arguments: { result: "E2E_CAPABILITY_WORKSPACE_DEFAULT_TASK_READY" },
				expectedRequestIncludes: ["E2E_CAPABILITY_WORKSPACE_DEFAULT_TASK"],
				expectedRequestExcludes: [SKILL_NAME, WORKFLOW_NAME, SUBAGENT_NAME, MCP_TOOL_NAME],
			},
		)

		const sendButton = sidebar.getByTestId("send-button")
		await expect(input).toHaveValue("Verify task-local capability resources.")
		await expect(input).toHaveAttribute("placeholder", "Type your task here...")
		await expect(sendButton).toHaveCount(1)
		await expect(sendButton).not.toHaveClass(/disabled/)
		await sendButton.click()
		await expect(input, `Webview errors: ${webviewErrors.join("\n")}`).toHaveValue("", { timeout: 5_000 })
		await expect(sidebar.getByText("E2E_CAPABILITY_TASK_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		const taskId = await onlyTaskId(dlineDocsDir)
		const initialToggles = await waitForTaskCapabilityToggles(dlineDocsDir, taskId)
		const mcpInternalNames = Object.keys(initialToggles.mcpServers).filter((name) => name.startsWith(`${MCP_NAME}@`))
		expect(mcpInternalNames).toHaveLength(1)
		const mcpInternalName = mcpInternalNames[0]
		const files: CapabilityFiles = { ...promptFiles, mcp }
		expectCapabilityState(initialToggles, files, mcpInternalName, false)
		const initialPromptContext = await readPromptContext(dlineDocsDir, taskId)
		const initialFrozen = initialPromptContext.systemPrompt?.frozen
		if (!initialFrozen) throw new Error("Initial task system prompt was not persisted")
		const refreshButton = sidebar.locator("button:has(svg.lucide-refresh-cw)").first()
		const freshnessWarning = refreshButton.getByTestId("prompt-freshness-warning")
		await expect(refreshButton).toBeVisible()
		await expect(freshnessWarning).toHaveCount(0)

		await openCapabilityModal(sidebar)
		await selectCapabilityTab(sidebar, "Workflows")
		await setToggle(sidebar, `${WORKFLOW_NAME}.md`, true)
		await selectCapabilityTab(sidebar, "Skills")
		await setToggle(sidebar, SKILL_NAME, true)
		await selectCapabilityTab(sidebar, "Subagents")
		await setToggle(sidebar, SUBAGENT_NAME, true)
		await closeCapabilityModal(sidebar)
		await openMcpModal(sidebar)
		await setToggle(sidebar, MCP_NAME, true)
		await closeMcpModal(sidebar)

		await expect
			.poll(async () => readTaskCapabilityToggles(dlineDocsDir, taskId))
			.toEqual(expect.objectContaining({ mcpServers: expect.objectContaining({ [mcpInternalName]: true }) }))
		expectCapabilityState(await readTaskCapabilityToggles(dlineDocsDir, taskId), files, mcpInternalName, true)
		await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(1)
		await expect(freshnessWarning).toBeVisible({ timeout: 30_000 })
		await refreshButton.hover()
		const freshnessTooltip = sidebar.getByRole("tooltip").filter({ hasText: "Prompt update available" })
		await expect(freshnessTooltip).toContainText("Workflows changed")
		await expect(freshnessTooltip).toContainText("Skills changed")
		await expect(freshnessTooltip).toContainText("Subagents changed")
		await expect(freshnessTooltip).toContainText("MCP tools changed")

		const beforeRefresh = await readPromptContext(dlineDocsDir, taskId)
		const beforeFrozen = beforeRefresh.systemPrompt?.frozen
		if (!beforeFrozen) throw new Error("Stale task system prompt was not persisted")
		expect(beforeFrozen.refreshedAt).toBe(initialFrozen.refreshedAt)
		expect(beforeFrozen.text).not.toContain(SKILL_NAME)
		expect(beforeFrozen.text).not.toContain(WORKFLOW_NAME)
		expect(beforeFrozen.text).not.toContain(SUBAGENT_NAME)
		expect(beforeFrozen.text).not.toContain(MCP_TOOL_NAME)

		await refreshButton.click()
		const dialog = sidebar.getByRole("dialog")
		await dialog.getByRole("button", { name: "Confirm", exact: true }).click()
		await expect(sidebar.getByRole("heading", { name: "Refresh Prompt Cache", exact: true })).not.toBeVisible()
		await expect
			.poll(async () => (await readPromptContext(dlineDocsDir, taskId)).systemPrompt?.frozen?.refreshReason)
			.toBe("manual")
		const refreshed = (await readPromptContext(dlineDocsDir, taskId)).systemPrompt?.frozen
		if (!refreshed) throw new Error("Refreshed task system prompt was not persisted")
		expect(refreshed.refreshedAt).toBeGreaterThan(beforeFrozen.refreshedAt)
		expect(refreshed.text).toContain(SKILL_NAME)
		expect(refreshed.text).toContain(WORKFLOW_NAME)
		expect(refreshed.text).toContain(SUBAGENT_NAME)
		expect(refreshed.text).toContain(MCP_TOOL_NAME)
		await expect(freshnessWarning).toHaveCount(0)
		expect(server.getRequestCount("openai-compatible-chat")).toBe(1)

		await input.fill("E2E_CAPABILITY_REFRESH_FEEDBACK")
		await input.press("Enter")
		await expect(sidebar.getByText("E2E_CAPABILITY_REFRESH_APPLIED", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		expect(server.getMockConsumptions("openai-compatible-chat")[1].contractError).toBeUndefined()

		const startNewTask = sidebar.locator('vscode-button[aria-label="Start New Task"]')
		await expect(startNewTask).toBeVisible()
		// Start New Task closes the current task and returns to the RECENT
		// welcome screen; the user then explicitly submits the next task.
		await startNewTask.click()
		await expect(input).toHaveValue("")
		// Task termination can consume the full five-second backend fence before
		// the Webview receives the cleared Task state. Wait beyond that boundary
		// so the next submission cannot race the previous Task's shutdown.
		await expect(input).toHaveAttribute("placeholder", "Type your task here...", { timeout: 30_000 })
		await expect(input).toBeEnabled()
		await input.fill("E2E_CAPABILITY_WORKSPACE_DEFAULT_TASK")
		await input.press("Enter")
		await expect(sidebar.getByText("E2E_CAPABILITY_WORKSPACE_DEFAULT_TASK_READY", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		const newTaskIds = await taskIds(dlineDocsDir)
		expect(newTaskIds).toHaveLength(2)
		const newTaskId = newTaskIds.find((candidate) => candidate !== taskId)
		if (!newTaskId) throw new Error("Workspace-default capability task was not persisted")
		expectCapabilityState(await waitForTaskCapabilityToggles(dlineDocsDir, newTaskId), files, mcpInternalName, false)
		expect(server.getMockConsumptions("openai-compatible-chat")[2].contractError).toBeUndefined()

		await openCapabilityModal(sidebar)
		await selectCapabilityTab(sidebar, "Workflows")
		await expectToggle(sidebar, `${WORKFLOW_NAME}.md`, false)
		await selectCapabilityTab(sidebar, "Skills")
		await expectToggle(sidebar, SKILL_NAME, false)
		await selectCapabilityTab(sidebar, "Subagents")
		await expectToggle(sidebar, SUBAGENT_NAME, false)
		await closeCapabilityModal(sidebar)
		await openMcpModal(sidebar)
		await expectToggle(sidebar, MCP_NAME, false)
		await closeMcpModal(sidebar)

		await openCapabilityModal(sidebar)
		await Promise.all([rm(files.skill), rm(files.workflow), rm(files.subagent)])
		await selectCapabilityTab(sidebar, "Subagents")
		await expect(sidebar.getByText(SUBAGENT_NAME, { exact: true })).toHaveCount(0, { timeout: 30_000 })
		await selectCapabilityTab(sidebar, "Workflows")
		await expect(sidebar.getByText(`${WORKFLOW_NAME}.md`, { exact: true })).toHaveCount(0, { timeout: 30_000 })
		await selectCapabilityTab(sidebar, "Skills")
		await expect(sidebar.getByText(SKILL_NAME, { exact: true })).toHaveCount(0, { timeout: 30_000 })
		await closeCapabilityModal(sidebar)

		await openMcpModal(sidebar)
		await expect(sidebar.getByText(MCP_NAME, { exact: true })).toBeVisible()
		await rm(files.mcp)
		await expect(sidebar.getByText(MCP_NAME, { exact: true })).toHaveCount(0, { timeout: 30_000 })
		await closeMcpModal(sidebar)

		await expect
			.poll(async () => {
				const toggles = await readTaskCapabilityToggles(dlineDocsDir, newTaskId)
				return {
					skill: toggles.localSkillsToggles[taskResourceId(files.skill)],
					workflow: toggles.localWorkflowToggles[taskResourceId(files.workflow)],
					subagent: toggles.localSubagentsToggles[taskResourceId(files.subagent)],
					mcp: toggles.mcpServers[mcpInternalName],
				}
			})
			.toEqual({ skill: false, workflow: false, subagent: false, mcp: false })
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

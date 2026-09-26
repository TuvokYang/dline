import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { expect, type Frame } from "@playwright/test"
import { E2ETestHelper } from "../utils/helpers"
import { capabilityRow, toggleCapability } from "./scenarios/capabilities"
import { demo } from "./utils/demo-fixture"
import { dismissDemoNotifications } from "./utils/png-asset"

const RULE_NAME = "release-policy"
const SKILL_NAME = "release-checklist"
const WORKFLOW_NAME = "release-review"
const MCP_NAME = "release-tools"
const MCP_TOOL_NAME = "e2e_workspace_echo"
const TASK_TEXT = "Prepare a release review with only the capabilities needed for this task."
const COMPLETION_TEXT = "Release review started with this task's selected capabilities."

async function createDemoCapabilities(workspaceDir: string): Promise<string> {
	const ruleDirectory = path.join(workspaceDir, ".agents", "rules")
	const skillDirectory = path.join(workspaceDir, ".agents", "skills", SKILL_NAME)
	const workflowDirectory = path.join(workspaceDir, ".agents", "workflows")
	const mcpDirectory = path.join(workspaceDir, ".agents", "mcp")
	await Promise.all([
		mkdir(ruleDirectory, { recursive: true }),
		mkdir(skillDirectory, { recursive: true }),
		mkdir(workflowDirectory, { recursive: true }),
		mkdir(mcpDirectory, { recursive: true }),
	])

	const mcpDescriptor = path.join(mcpDirectory, `${MCP_NAME}.json`)
	await Promise.all([
		writeFile(
			path.join(ruleDirectory, `${RULE_NAME}.md`),
			"Keep release reviews focused on actionable risks and the next decision.\n",
			"utf8",
		),
		writeFile(
			path.join(skillDirectory, "SKILL.md"),
			[
				"---",
				`name: ${SKILL_NAME}`,
				"description: Review a release checklist and summarize remaining risks.",
				"---",
				"Review the requested release checklist and report actionable risks.",
			].join("\n"),
			"utf8",
		),
		writeFile(
			path.join(workflowDirectory, `${WORKFLOW_NAME}.md`),
			[
				"---",
				`name: ${WORKFLOW_NAME}`,
				"description: Run a focused release-readiness review.",
				"---",
				"Inspect release readiness, summarize findings, and identify the next action.",
			].join("\n"),
			"utf8",
		),
		writeFile(
			mcpDescriptor,
			`${JSON.stringify(
				{
					name: MCP_NAME,
					description: "Demo release tooling for task-scoped capability selection.",
					type: "stdio",
					command: process.execPath,
					args: [path.join(E2ETestHelper.E2E_TESTS_DIR, "fixtures", "workspace-mcp-server.mjs")],
				},
				null,
				2,
			)}\n`,
			"utf8",
		),
	])
	return mcpDescriptor
}

async function openCapabilityModal(sidebar: Frame): Promise<void> {
	const button = sidebar.getByRole("button", { name: "Show Dline Rules & Workflows", exact: true }).first()
	await expect(button).toBeVisible()
	await button.click()
	await expect(sidebar.getByRole("button", { name: "Hide Dline Rules & Workflows", exact: true }).first()).toBeVisible()
}

async function selectCapabilityTab(sidebar: Frame, name: "Rules" | "Workflows" | "Skills"): Promise<void> {
	const tab = sidebar.getByRole("button", { name, exact: true })
	await tab.click()
	await expect(tab).toHaveAttribute("aria-pressed", "true")
}

demo("R6", async ({ finishRecording, helper, pace, page, registerRecording, server, sidebar, userDataDir, workspaceDir }) => {
	demo.setTimeout(180_000)
	const mcpDescriptor = await createDemoCapabilities(workspaceDir)
	await helper.signin(sidebar)
	await dismissDemoNotifications(page)

	const showMcpButton = sidebar.getByRole("button", { name: "Show MCP Servers", exact: true }).first()
	await expect(showMcpButton).toBeVisible()
	await showMcpButton.click()
	await expect(sidebar.getByRole("button", { name: "Hide MCP Servers", exact: true }).first()).toBeVisible()
	await expect(capabilityRow(sidebar, MCP_NAME)).toBeVisible({ timeout: 30_000 })
	await sidebar.getByRole("button", { name: "Hide MCP Servers", exact: true }).first().click()

	server.resetOpenAiMock()
	server.enqueueOpenAiResponses({
		type: "tool",
		id: "call_r6_complete",
		name: "attempt_completion",
		arguments: { result: COMPLETION_TEXT },
		delayMs: 1_000,
		expectedRequestIncludes: [TASK_TEXT, RULE_NAME, MCP_TOOL_NAME],
		expectedRequestExcludes: [SKILL_NAME, WORKFLOW_NAME],
		matchRequestContract: true,
	})

	const input = sidebar.getByTestId("chat-input")
	await input.fill(TASK_TEXT)
	await openCapabilityModal(sidebar)
	await selectCapabilityTab(sidebar, "Rules")
	await expect(capabilityRow(sidebar, `${RULE_NAME}.md`)).toBeVisible({ timeout: 30_000 })
	await expect(capabilityRow(sidebar, `${RULE_NAME}.md`).getByRole("switch")).toHaveAttribute("data-state", "checked")
	await selectCapabilityTab(sidebar, "Skills")
	await expect(capabilityRow(sidebar, SKILL_NAME)).toBeVisible({ timeout: 30_000 })
	await expect(capabilityRow(sidebar, SKILL_NAME).getByRole("switch")).toHaveAttribute("data-state", "checked")

	await registerRecording("r6-capability-scopes")
	await pace(700)
	await toggleCapability(sidebar, SKILL_NAME, false)
	await pace(500)

	await selectCapabilityTab(sidebar, "Workflows")
	await expect(capabilityRow(sidebar, `${WORKFLOW_NAME}.md`)).toBeVisible({ timeout: 30_000 })
	await pace(500)
	await toggleCapability(sidebar, `${WORKFLOW_NAME}.md`, false)
	await pace(500)

	await sidebar.getByRole("button", { name: "Hide Dline Rules & Workflows", exact: true }).first().click()
	await expect(input).toHaveValue(TASK_TEXT)
	await pace(500)
	await input.press("Enter")
	await expect(input).toHaveValue("")
	await expect(sidebar.getByText(TASK_TEXT, { exact: false }).last()).toBeVisible({ timeout: 30_000 })
	await expect(sidebar.getByText(COMPLETION_TEXT, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
	await pace(900)

	await openCapabilityModal(sidebar)
	await selectCapabilityTab(sidebar, "Rules")
	await expect(capabilityRow(sidebar, `${RULE_NAME}.md`)).toBeVisible({ timeout: 30_000 })
	await pace(500)
	await toggleCapability(sidebar, `${RULE_NAME}.md`, false)
	await pace(500)
	await sidebar.getByRole("button", { name: "Hide Dline Rules & Workflows", exact: true }).first().click()

	await showMcpButton.click()
	await expect(sidebar.getByRole("button", { name: "Hide MCP Servers", exact: true }).first()).toBeVisible()
	await expect(capabilityRow(sidebar, MCP_NAME)).toBeVisible({ timeout: 30_000 })
	await pace(500)
	await toggleCapability(sidebar, MCP_NAME, false)
	await pace(500)
	await sidebar.getByRole("button", { name: "Hide MCP Servers", exact: true }).first().click()

	const refreshButton = sidebar.locator("button:has(svg.lucide-refresh-cw)").first()
	const freshnessWarning = refreshButton.getByTestId("prompt-freshness-warning")
	await expect(freshnessWarning).toBeVisible({ timeout: 30_000 })
	await refreshButton.hover()
	const freshnessTooltip = sidebar.getByRole("tooltip").filter({ hasText: "Prompt update available" })
	await expect(freshnessTooltip).toContainText("Rules changed")
	await expect(freshnessTooltip).toContainText("MCP tools changed")
	await pace(1_800)
	await finishRecording()

	const consumptions = server.getMockConsumptions("openai-compatible-chat")
	expect(consumptions).toHaveLength(1)
	expect(consumptions[0]).toMatchObject({ toolName: "attempt_completion", toolCallId: "call_r6_complete" })
	expect(consumptions[0].contractError).toBeUndefined()

	await showMcpButton.click()
	const hideMcpButton = sidebar.getByRole("button", { name: "Hide MCP Servers", exact: true }).first()
	await expect(hideMcpButton).toBeVisible()
	await rm(mcpDescriptor)
	await expect(sidebar.getByText(MCP_NAME, { exact: true })).toHaveCount(0, { timeout: 30_000 })
	await hideMcpButton.click()
	await page.waitForTimeout(2_000)
	await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
})

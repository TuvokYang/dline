import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { prepareWorkSession, setWorkAutoApproveAction } from "@e2e/utils/work/session"
import { expect, type Frame } from "@playwright/test"
import { createWorkspaceMcpScopeHash } from "@services/mcp/WorkspaceMcpRegistry"

const TARGET = "openai-compatible-chat" as const
const PROFILE_NAME = E2E_PROFILE_NAMES.mockOpenAi
const MCP_NAME = "work-smoke-mcp"
const MCP_TOOL_NAME = "e2e_workspace_echo"
const SKILL_NAME = "work-smoke-health"
const RULE_NAME = "work-smoke-rule.md"
const RULE_MARKER = "WORK_SMOKE_RULE_ACTIVE"
const SKILL_MARKER = "WORK_SMOKE_SKILL_ACTIVE"
const TASK_TEXT = "WORK_SMOKE_VALIDATE_CORE_CAPABILITIES"
const COMPLETION = "WORK_SMOKE_CORE_CAPABILITIES_OK"
const SMOKE_FILE = "work-smoke-checkpoint.txt"
const INITIAL_CHECKLIST = [
	"# Work Smoke Focus Chain",
	"- [x] Settings and Provider",
	"- [ ] Common programming tools",
	"- [x] Rules and Skills",
	"- [ ] MCP",
	"- [ ] Checkpoint",
].join("\n")
const COMMON_TOOLS_CHECKLIST_UPDATE = "- [x] Common programming tools"
const FINAL_CHECKLIST_UPDATE = ["- [x] MCP", "- [x] Checkpoint"].join("\n")
const COMMAND = `node -e "const fs=require('fs'); const value=fs.readFileSync('${SMOKE_FILE}','utf8').trim(); console.log('WORK_SMOKE_COMMAND_'+value)"`

function escapeForRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function seedSmokeCapabilities(workspaceDir: string, dlineDir: string): Promise<void> {
	const rulesDir = path.join(workspaceDir, ".agents", "rules")
	const skillDir = path.join(workspaceDir, ".agents", "skills", SKILL_NAME)
	const mcpDir = path.join(workspaceDir, ".agents", "mcp")
	await Promise.all([
		mkdir(rulesDir, { recursive: true }),
		mkdir(skillDir, { recursive: true }),
		mkdir(mcpDir, { recursive: true }),
	])
	await Promise.all([
		writeFile(
			path.join(rulesDir, RULE_NAME),
			`# ${RULE_MARKER}\nKeep the smoke capability markers in the request.\n`,
			"utf8",
		),
		writeFile(
			path.join(skillDir, "SKILL.md"),
			["---", `name: ${SKILL_NAME}`, "description: Verify the work smoke capability path.", "---", SKILL_MARKER].join("\n"),
			"utf8",
		),
		writeFile(
			path.join(mcpDir, `${MCP_NAME}.json`),
			`${JSON.stringify(
				{
					name: MCP_NAME,
					description: "Work smoke MCP server",
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
	const settingsPath = path.join(dlineDir, "data", "settings", "settings.json")
	const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>
	settings.enableCheckpointsSetting = true
	await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

async function verifySettings(page: import("@playwright/test").Page, sidebar: Frame): Promise<void> {
	await page.getByRole("button", { name: "Settings", exact: true }).click()
	await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible({
		timeout: 20_000,
	})
	const card = sidebar.getByTestId("api-profile-card").filter({
		has: sidebar.getByRole("button", {
			name: new RegExp(`^(Expand|Collapse) ${escapeForRegExp(PROFILE_NAME)}$`),
		}),
	})
	await expect(card).toHaveCount(1)
	const expand = card.getByRole("button", { name: `Expand ${PROFILE_NAME}` })
	if (await expand.isVisible()) await expand.click()
	await expect(card.getByRole("combobox", { name: "Provider" })).toHaveValue("openai")
	const modelConfiguration = card.getByRole("button", { name: "Model Configuration" })
	await expect(modelConfiguration).toBeVisible()
	const nativeTools = card.locator("vscode-checkbox").filter({ hasText: "Supports Native Tool Calls" })
	if (!(await nativeTools.isVisible())) await modelConfiguration.click()
	await expect(nativeTools).toBeVisible()
	const nativeToolsEnabled = () => nativeTools.evaluate((element) => Boolean((element as HTMLInputElement).checked))
	if (!(await nativeToolsEnabled())) await nativeTools.click()
	await expect.poll(nativeToolsEnabled).toBe(true)
	await sidebar.getByRole("button", { name: "Done", exact: true }).click()
	await expect(sidebar.getByRole("button", { name: "Select model" })).toHaveText(PROFILE_NAME)
}

async function verifyCapabilityDiscovery(sidebar: Frame): Promise<void> {
	await sidebar.getByRole("button", { name: "Show Dline Rules & Workflows", exact: true }).first().click()
	await expect(sidebar.getByText(RULE_NAME, { exact: true })).toBeVisible({ timeout: 20_000 })
	const skillsTab = sidebar.getByRole("button", { name: "Skills", exact: true })
	await skillsTab.click()
	await expect(sidebar.getByText(SKILL_NAME, { exact: true })).toBeVisible({ timeout: 20_000 })
	await sidebar.getByRole("button", { name: "Hide Dline Rules & Workflows", exact: true }).first().click()
	await sidebar.getByRole("button", { name: "Show MCP Servers", exact: true }).first().click()
	const mcpRow = sidebar.getByText(MCP_NAME, { exact: true }).locator("xpath=ancestor::div[contains(@class, 'mb-2.5')][1]")
	await expect(mcpRow).toBeVisible({ timeout: 30_000 })
	const mcpToggle = mcpRow.getByRole("switch")
	await expect(mcpToggle).toHaveCount(1)
	if ((await mcpToggle.getAttribute("data-state")) !== "checked") await mcpToggle.click()
	await expect(mcpToggle).toHaveAttribute("data-state", "checked")
	await sidebar.getByRole("button", { name: "Hide MCP Servers", exact: true }).first().click()
}

e2e(
	"work smoke validates settings and core capability paths",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		await seedSmokeCapabilities(workspaceDir, dlineDir)
		const mcpInternalName = `${MCP_NAME}@${createWorkspaceMcpScopeHash(workspaceDir)}`
		server.resetOpenAiMock()
		server.enqueueResponses(
			TARGET,
			{
				type: "tool",
				id: "call_work_smoke_list",
				name: "list_files",
				arguments: { path: ".", recursive: false, task_progress: INITIAL_CHECKLIST },
				expectedRequestIncludes: [TASK_TEXT, RULE_MARKER, SKILL_MARKER, mcpInternalName, MCP_TOOL_NAME],
			},
			{
				type: "tool",
				id: "call_work_smoke_search",
				name: "search_files",
				arguments: { path: ".", regex: "Test Workspace", file_pattern: "README.md" },
				expectedToolResults: [{ callId: "call_work_smoke_list", contentIncludes: "README.md" }],
			},
			{
				type: "tool",
				id: "call_work_smoke_read",
				name: "read_file",
				arguments: { path: "README.md" },
				expectedToolResults: [{ callId: "call_work_smoke_search", contentIncludes: "Test Workspace" }],
			},
			{
				type: "tool",
				id: "call_work_smoke_write",
				name: "write_to_file",
				arguments: { path: SMOKE_FILE, content: "WORK_SMOKE_CHECKPOINT_BEFORE\n" },
				expectedToolResults: [{ callId: "call_work_smoke_read", contentIncludes: "# Test Workspace" }],
			},
			{
				type: "tool",
				id: "call_work_smoke_replace",
				name: "replace_in_file",
				arguments: {
					path: SMOKE_FILE,
					diff: "------- SEARCH\nWORK_SMOKE_CHECKPOINT_BEFORE\n=======\nWORK_SMOKE_CHECKPOINT_OK\n+++++++ REPLACE",
					task_progress: COMMON_TOOLS_CHECKLIST_UPDATE,
				},
				expectedToolResults: [{ callId: "call_work_smoke_write", contentIncludes: "successfully saved" }],
			},
			{
				type: "tool",
				id: "call_work_smoke_command",
				name: "execute_command",
				arguments: {
					command: COMMAND,
					workdirectory: ".",
					requires_approval: false,
					synchronous: true,
					timeout: 60,
				},
				expectedToolResults: [{ callId: "call_work_smoke_replace", contentIncludes: "successfully replaced" }],
			},
			{
				type: "tool",
				id: "call_work_smoke_mcp",
				name: "use_mcp_tool",
				arguments: {
					server_name: mcpInternalName,
					tool_name: MCP_TOOL_NAME,
					arguments: JSON.stringify({ value: "WORK_SMOKE_MCP_OK" }),
					task_progress: FINAL_CHECKLIST_UPDATE,
				},
				expectedToolResults: [
					{ callId: "call_work_smoke_command", contentIncludes: "WORK_SMOKE_COMMAND_WORK_SMOKE_CHECKPOINT_OK" },
				],
			},
			{
				type: "tool",
				id: "call_work_smoke_complete",
				name: "attempt_completion",
				arguments: { result: COMPLETION },
				expectedToolResults: [{ callId: "call_work_smoke_mcp", contentIncludes: "WORK_SMOKE_MCP_OK" }],
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await prepareWorkSession(sidebar, helper)
			await verifySettings(page, sidebar)
			await verifyCapabilityDiscovery(sidebar)
			for (const label of ["Read project files", "Edit project files", "Execute safe commands", "Use MCP servers"]) {
				await setWorkAutoApproveAction(sidebar, label, true)
			}

			const input = sidebar.getByTestId("chat-input")
			await input.fill("/")
			const menu = sidebar.getByTestId("slash-commands-menu")
			await expect(menu).toBeVisible()
			await menu.getByText(SKILL_NAME, { exact: true }).click()
			await input.fill(`${await input.inputValue()}${TASK_TEXT}`)
			await sidebar.getByTestId("send-button").click()

			await expect(sidebar.getByText(COMPLETION, { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expect(sidebar.getByLabel("Expand focus chain")).toBeVisible({ timeout: 30_000 })
			await expect(sidebar.getByTitle("Work Smoke Focus Chain")).toContainText("5/5")
			await expect
				.poll(async () => (await readFile(path.join(workspaceDir, "work-smoke-checkpoint.txt"), "utf8")).trim())
				.toBe("WORK_SMOKE_CHECKPOINT_OK")
			await expect
				.poll(() => sidebar.getByText("Checkpoint", { exact: true }).count(), {
					timeout: 30_000,
				})
				.toBeGreaterThan(0)
			await expect.poll(() => server.getRequestCount(TARGET)).toBe(8)
			const consumptions = server.getMockConsumptions(TARGET)
			expect(consumptions.map((entry) => entry.toolName)).toEqual([
				"list_files",
				"search_files",
				"read_file",
				"write_to_file",
				"replace_in_file",
				"execute_command",
				"use_mcp_tool",
				"attempt_completion",
			])
			expect(consumptions.every((entry) => entry.contractError === undefined)).toBe(true)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

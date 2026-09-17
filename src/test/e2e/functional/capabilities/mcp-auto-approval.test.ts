import { mkdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

const MCP_NAME = "e2e-approval-mcp"
const MCP_TOOL_NAME = "e2e_workspace_echo"
const mcpSettingsPath = (dlineDocsDir: string) => path.join(dlineDocsDir, "settings", "mcp_settings.json")

interface StoredMcpSettings {
	mcpServers?: Record<string, Record<string, unknown>>
}

async function writeMcpSettings(dlineDocsDir: string): Promise<void> {
	const settingsPath = mcpSettingsPath(dlineDocsDir)
	await mkdir(path.dirname(settingsPath), { recursive: true })
	await writeFile(
		settingsPath,
		`${JSON.stringify(
			{
				mcpServers: {
					[MCP_NAME]: {
						disabled: false,
						timeout: 60,
						type: "stdio",
						command: process.execPath,
						args: [path.join(E2ETestHelper.E2E_TESTS_DIR, "fixtures", "workspace-mcp-server.mjs")],
					},
				},
			},
			null,
			2,
		)}\n`,
		"utf8",
	)
}

async function readMcpSettings(dlineDocsDir: string): Promise<StoredMcpSettings> {
	return JSON.parse(await readFile(mcpSettingsPath(dlineDocsDir), "utf8")) as StoredMcpSettings
}

async function setAutoApproveAction(sidebar: Frame, label: string, enabled: boolean): Promise<void> {
	await sidebar.getByLabel("Open auto-approve settings").click()
	const checkbox = sidebar.locator("vscode-checkbox").filter({ hasText: label })
	await expect(checkbox).toHaveCount(1)
	const isChecked = () => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
	if ((await isChecked()) !== enabled) {
		await sidebar.getByText(label, { exact: true }).click()
	}
	await expect.poll(isChecked).toBe(enabled)
	await sidebar.getByLabel("Close auto-approve settings").click()
}

async function openMcpConfigure(sidebar: Frame): Promise<void> {
	await sidebar.getByRole("button", { name: "Show MCP Servers", exact: true }).click()
	await sidebar.getByRole("button", { name: "Go to MCP server settings", exact: true }).click()
	await expect(sidebar.getByRole("heading", { name: "MCP Servers", exact: true })).toBeVisible()
	await expect(sidebar.getByText("Configure MCP Servers", { exact: true })).toBeVisible()
}

async function setToolAutoApprove(sidebar: Frame, enabled: boolean): Promise<void> {
	const serverRow = sidebar.getByText(MCP_NAME, { exact: true }).filter({ visible: true })
	await expect(serverRow).toHaveCount(1, { timeout: 60_000 })
	await serverRow.click()
	await expect(sidebar.getByText("Tools (1)", { exact: true })).toBeVisible({ timeout: 60_000 })
	const checkbox = sidebar.locator(`vscode-checkbox[data-tool="${MCP_TOOL_NAME}"]`)
	await expect(checkbox).toHaveCount(1)
	if ((await checkbox.isChecked()) !== enabled) {
		await checkbox.focus()
		await checkbox.press("Space")
	}
	await expect.poll(() => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))).toBe(enabled)
}

async function returnToChat(sidebar: Frame): Promise<void> {
	await sidebar.getByRole("button", { name: "Done", exact: true }).click()
	await expect(sidebar.getByTestId("chat-input")).toBeVisible()
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

async function closeCurrentTask(sidebar: Frame): Promise<void> {
	const closeTaskButton = sidebar.getByRole("button", { name: "Close Task", exact: true })
	await expect(closeTaskButton).toBeVisible({ timeout: 60_000 })
	await closeTaskButton.click()
	await expect(sidebar.getByTestId("chat-input")).toHaveAttribute("placeholder", "Type your task here...")
}

async function selectResponsesProfile(sidebar: Frame): Promise<void> {
	const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
	if ((await modelSwitcher.innerText()).trim() === E2E_PROFILE_NAMES.mockOpenAiResponses) return
	await modelSwitcher.click()
	await sidebar.getByRole("option").filter({ hasText: E2E_PROFILE_NAMES.mockOpenAiResponses }).click()
	await expect(modelSwitcher).toHaveText(E2E_PROFILE_NAMES.mockOpenAiResponses)
}

e2e(
	"MCP auto-approve - unconfigured tools default to allowed and Configure can disable one tool",
	async ({ dlineDocsDir, helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(240_000)
		await writeMcpSettings(dlineDocsDir)
		await helper.signin(sidebar)
		await selectResponsesProfile(sidebar)
		await expect(sidebar.getByRole("button", { name: "Show MCP Servers", exact: true })).toBeVisible({ timeout: 60_000 })

		await openMcpConfigure(sidebar)
		await setToolAutoApprove(sidebar, true)
		await returnToChat(sidebar)

		server.resetOpenAiMock()
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_mcp_default_allowed",
				name: "use_mcp_tool",
				arguments: {
					server_name: MCP_NAME,
					tool_name: MCP_TOOL_NAME,
					arguments: JSON.stringify({ value: "E2E_MCP_DEFAULT_ALLOWED" }),
				},
			},
			{
				type: "tool",
				id: "call_mcp_default_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_MCP_DEFAULT_ALLOWED_DONE" },
				expectedToolResults: [{ callId: "call_mcp_default_allowed", contentIncludes: "E2E_MCP_DEFAULT_ALLOWED" }],
			},
		)
		await sendTask(sidebar, "Use the configured MCP echo tool without asking me first.")
		await expect(sidebar.getByText("E2E_MCP_DEFAULT_ALLOWED_DONE", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect(sidebar.getByText("Approve", { exact: true })).toHaveCount(0)
		expect(server.getMockConsumptions("openai-compatible-responses").map((entry) => entry.toolName)).toEqual([
			"use_mcp_tool",
			"attempt_completion",
		])

		await openMcpConfigure(sidebar)
		await setToolAutoApprove(sidebar, false)
		await expect
			.poll(async () => (await readMcpSettings(dlineDocsDir)).mcpServers?.[MCP_NAME]?.disabledAutoApprove)
			.toEqual([MCP_TOOL_NAME])
		await returnToChat(sidebar)
		await closeCurrentTask(sidebar)

		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_mcp_disabled_waiting",
				name: "use_mcp_tool",
				arguments: {
					server_name: MCP_NAME,
					tool_name: MCP_TOOL_NAME,
					arguments: JSON.stringify({ value: "E2E_MCP_DISABLED_WAITING" }),
				},
			},
			{
				type: "tool",
				id: "call_mcp_disabled_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_MCP_DISABLED_DONE" },
				expectedToolResults: [{ callId: "call_mcp_disabled_waiting", contentIncludes: "E2E_MCP_DISABLED_WAITING" }],
			},
		)
		await sendTask(sidebar, "Use the MCP echo tool and wait for explicit approval.")
		await expect(sidebar.getByText("Approve", { exact: true })).toBeVisible({ timeout: 60_000 })
		expect(server.getRequestCount("openai-compatible-responses")).toBe(3)
		await sidebar.getByText("Approve", { exact: true }).click()
		await expect(sidebar.getByText("E2E_MCP_DISABLED_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		expect(server.getMockConsumptions("openai-compatible-responses").map((entry) => entry.toolName)).toEqual([
			"use_mcp_tool",
			"attempt_completion",
			"use_mcp_tool",
			"attempt_completion",
		])
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"MCP auto-approve - global Use MCP servers is a hard gate over an allowed tool",
	async ({ dlineDocsDir, helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await writeMcpSettings(dlineDocsDir)
		await helper.signin(sidebar)
		await selectResponsesProfile(sidebar)
		await setAutoApproveAction(sidebar, "Use MCP servers", false)
		await expect(sidebar.getByRole("button", { name: "Show MCP Servers", exact: true })).toBeVisible({ timeout: 60_000 })

		server.resetOpenAiMock()
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_mcp_global_gate",
				name: "use_mcp_tool",
				arguments: {
					server_name: MCP_NAME,
					tool_name: MCP_TOOL_NAME,
					arguments: JSON.stringify({ value: "E2E_MCP_GLOBAL_GATE" }),
				},
			},
			{
				type: "tool",
				id: "call_mcp_global_gate_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_MCP_GLOBAL_GATE_DONE" },
				expectedToolResults: [{ callId: "call_mcp_global_gate", contentIncludes: "E2E_MCP_GLOBAL_GATE" }],
			},
		)
		await sendTask(sidebar, "Use the MCP echo tool only after I approve the global gate.")
		await expect(sidebar.getByText("Approve", { exact: true })).toBeVisible({ timeout: 60_000 })
		expect(server.getRequestCount("openai-compatible-responses")).toBe(1)
		await sidebar.getByText("Approve", { exact: true }).click()
		await expect(sidebar.getByText("E2E_MCP_GLOBAL_GATE_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

const HANGING_MCP_NAME = "e2e-hanging-mcp"
const DELAYED_MCP_NAME = "e2e-delayed-mcp"

async function writeMcpSettings(
	dlineDocsDir: string,
	name: string,
	fixture: string,
	env?: Record<string, string>,
): Promise<void> {
	const settingsPath = path.join(dlineDocsDir, "settings", "mcp_settings.json")
	await mkdir(path.dirname(settingsPath), { recursive: true })
	await writeFile(
		settingsPath,
		`${JSON.stringify(
			{
				mcpServers: {
					[name]: {
						disabled: false,
						timeout: 60,
						type: "stdio",
						command: process.execPath,
						args: [path.join(E2ETestHelper.E2E_TESTS_DIR, "fixtures", fixture)],
						env,
					},
				},
			},
			null,
			2,
		)}\n`,
		"utf8",
	)
}

async function openMcpConfiguration(sidebar: Frame): Promise<void> {
	await sidebar.getByRole("button", { name: "Show MCP Servers", exact: true }).click()
	await sidebar.getByRole("button", { name: "Go to MCP server settings", exact: true }).click()
	await expect(sidebar.getByRole("heading", { name: "MCP Servers", exact: true })).toBeVisible()
}

e2e(
	"a hanging optional MCP server does not delay Sidebar hydration or the first Task request",
	async ({ dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		await writeMcpSettings(dlineDocsDir, HANGING_MCP_NAME, "hanging-mcp-server.mjs")
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses({
			type: "tool",
			id: "call_startup_dependency_done",
			name: "attempt_completion",
			arguments: { result: "E2E_STARTUP_DEPENDENCY_DONE" },
		})

		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await E2ETestHelper.dismissWhatsNewModal(sidebar)
			await helper.signin(sidebar)
			await expect(sidebar.getByTestId("chat-input")).toBeVisible({ timeout: 5_000 })

			await sidebar.getByTestId("chat-input").fill("E2E_STARTUP_DEPENDENCY_TASK")
			await sidebar.getByTestId("send-button").click()
			await expect.poll(() => server.getRequestCount("openai-compatible-chat"), { timeout: 8_000 }).toBe(1)
			await expect(sidebar.getByText("E2E_STARTUP_DEPENDENCY_DONE", { exact: false }).last()).toBeVisible({
				timeout: 30_000,
			})
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [
				/MCP connection timed out/,
				/Failed to connect to new MCP server/,
			])
		} finally {
			await app.close()
		}
	},
)

e2e(
	"a slow Docker-class MCP handshake initializes asynchronously and eventually connects",
	async ({ dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(120_000)
		await writeMcpSettings(dlineDocsDir, DELAYED_MCP_NAME, "delayed-mcp-server.mjs", {
			DLINE_E2E_MCP_STARTUP_DELAY_MS: "12000",
		})
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses({
			type: "tool",
			id: "call_delayed_mcp_done",
			name: "attempt_completion",
			arguments: { result: "E2E_DELAYED_MCP_TASK_DONE" },
		})

		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await E2ETestHelper.dismissWhatsNewModal(sidebar)
			await helper.signin(sidebar)
			await expect(sidebar.getByTestId("chat-input")).toBeVisible({ timeout: 5_000 })

			await sidebar.getByTestId("chat-input").fill("E2E_DELAYED_MCP_TASK")
			await sidebar.getByTestId("send-button").click()
			await expect.poll(() => server.getRequestCount("openai-compatible-chat"), { timeout: 8_000 }).toBe(1)
			await expect(sidebar.getByText("E2E_DELAYED_MCP_TASK_DONE", { exact: false }).last()).toBeVisible({
				timeout: 30_000,
			})

			await openMcpConfiguration(sidebar)
			const serverRow = sidebar.getByText(DELAYED_MCP_NAME, { exact: true }).filter({ visible: true })
			await expect(serverRow).toHaveCount(1, { timeout: 60_000 })
			await serverRow.click()
			await expect(sidebar.getByText("e2e_delayed_echo", { exact: true })).toBeVisible({ timeout: 60_000 })
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"StateManager startup failure renders a controlled recovery view instead of crashing SidebarProvider",
	async ({ dlineDir, helper, openVSCode, workspaceDir }) => {
		const settingsPath = path.join(dlineDir, "data", "settings", "settings.json")
		await rm(settingsPath, { recursive: true, force: true })
		await mkdir(settingsPath, { recursive: true })

		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await expect(sidebar.getByText("Dline storage initialization failed", { exact: true })).toBeVisible({
				timeout: 15_000,
			})
			await expect(page.getByText("An error occurred while loading view", { exact: false })).toHaveCount(0)
		} finally {
			await app.close()
		}
	},
)

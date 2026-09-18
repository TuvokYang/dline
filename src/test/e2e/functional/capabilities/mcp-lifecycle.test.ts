import { mkdir, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect } from "@playwright/test"
import type { ElectronApplication } from "playwright"

const MCP_NAME = "e2e-stable-mcp"
const mcpSettingsPath = (dlineDocsDir: string) => path.join(dlineDocsDir, "settings", "mcp_settings.json")

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

function countSpawns(output: string): number {
	return output.split(/\r?\n/).filter((line) => line.includes(`[MCP ${MCP_NAME}] spawning:`)).length
}

async function waitForConnectedMcp(sidebar: Awaited<ReturnType<E2ETestHelper["getSidebar"]>>): Promise<void> {
	await expect(sidebar.getByRole("button", { name: "Show MCP Servers", exact: true })).toBeVisible({ timeout: 60_000 })
	await sidebar.getByRole("button", { name: "Show MCP Servers", exact: true }).click()
	await expect(sidebar.getByText(MCP_NAME, { exact: true })).toBeVisible({ timeout: 60_000 })
	await expect(sidebar.getByRole("button", { name: "Hide MCP Servers", exact: true })).toBeVisible()
	await sidebar.getByRole("button", { name: "Hide MCP Servers", exact: true }).click()
}

e2e(
	"MCP lifecycle - opening panels and switching tasks does not respawn a healthy stdio server",
	async ({ dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		await writeMcpSettings(dlineDocsDir)
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_lifecycle_first",
				name: "attempt_completion",
				arguments: { result: "E2E_LIFECYCLE_FIRST_DONE" },
			},
			{
				type: "tool",
				id: "call_lifecycle_second",
				name: "attempt_completion",
				arguments: { result: "E2E_LIFECYCLE_SECOND_DONE" },
			},
		)

		const app: ElectronApplication = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await E2ETestHelper.dismissWhatsNewModal(sidebar)
			await helper.signin(sidebar)
			await waitForConnectedMcp(sidebar)
			await expect
				.poll(async () => countSpawns(await E2ETestHelper.readDlineOutput(userDataDir)), { timeout: 60_000 })
				.toBe(1)
			const initialOutput = await E2ETestHelper.readDlineOutput(userDataDir)
			const initialSpawnCount = countSpawns(initialOutput)
			expect(initialSpawnCount).toBe(1)

			await sidebar.getByRole("button", { name: "Show MCP Servers", exact: true }).click()
			await sidebar.getByRole("button", { name: "Go to MCP server settings", exact: true }).click()
			await expect(sidebar.getByRole("heading", { name: "MCP Servers", exact: true })).toBeVisible()
			await expect(sidebar.getByText("Configure MCP Servers", { exact: true })).toBeVisible()
			await sidebar.getByRole("button", { name: "Done", exact: true }).click()
			await expect(sidebar.getByTestId("chat-input")).toBeVisible()
			await expect.poll(async () => countSpawns(await E2ETestHelper.readDlineOutput(userDataDir))).toBe(initialSpawnCount)

			await sidebar.getByTestId("chat-input").fill("Create the first stable MCP lifecycle task.")
			await sidebar.getByTestId("send-button").click()
			await expect(sidebar.getByText("E2E_LIFECYCLE_FIRST_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect.poll(async () => countSpawns(await E2ETestHelper.readDlineOutput(userDataDir))).toBe(initialSpawnCount)

			await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
			await expect(sidebar.getByTestId("chat-input")).toHaveAttribute("placeholder", "Type your task here...")
			await waitForConnectedMcp(sidebar)
			await expect.poll(async () => countSpawns(await E2ETestHelper.readDlineOutput(userDataDir))).toBe(initialSpawnCount)

			await sidebar.getByTestId("chat-input").fill("Create the second stable MCP lifecycle task.")
			await sidebar.getByTestId("send-button").click()
			await expect(sidebar.getByText("E2E_LIFECYCLE_SECOND_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect.poll(async () => countSpawns(await E2ETestHelper.readDlineOutput(userDataDir))).toBe(initialSpawnCount)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

import { mkdir, rm, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

/**
 * Regression test: when MCP_DOCKER fails its first connection (e.g. the docker
 * gateway is still starting while a task begins), it must recover automatically
 * on a later reconcile — without any config change and without a manual
 * "Retry Connection" click.
 *
 * The user's real config shape is preserved (type/command/args/timeout), but
 * the command is routed through a launcher fixture whose success is controlled
 * by a marker file:
 *   - marker missing  -> the gateway process exits immediately (connection fails)
 *   - marker present  -> the launcher forwards to the real `docker mcp gateway
 *                        run --profile dline` and connects like production
 */

const SERVER_NAME = "MCP_DOCKER"

// ensureSettingsDirectoryExists() resolves to getDlineStorageDir("settings"),
// which is based on getDlineDocumentsPath() (DLINE_DOCS_DIR) — the dlineDocsDir
// fixture in the E2E environment.
const mcpSettingsPath = (dlineDocsDir: string) => path.join(dlineDocsDir, "settings", "mcp_settings.json")

async function writeMcpSettings(dlineDocsDir: string, markerPath: string): Promise<void> {
	const settingsPath = mcpSettingsPath(dlineDocsDir)
	await mkdir(path.dirname(settingsPath), { recursive: true })
	const settings = {
		mcpServers: {
			MCP_DOCKER: {
				disabled: false,
				timeout: 180,
				type: "stdio",
				command: process.execPath,
				args: [path.join(E2ETestHelper.E2E_TESTS_DIR, "fixtures", "mcp-docker-gateway-launcher.mjs")],
				env: { DLINE_E2E_MCP_MARKER: markerPath },
			},
			fetch: {
				disabled: true,
				timeout: 60,
				type: "stdio",
				command: "docker",
				args: ["run", "--rm", "-i", "mcp/fetch"],
			},
			vitest: {
				timeout: 60,
				command: "npx",
				args: ["-y", "@djankies/vitest-mcp"],
				type: "stdio",
				disabled: true,
			},
		},
	}
	await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
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

e2e(
	"MCP - a server that failed while the task started recovers automatically without config changes",
	async ({ dlineDocsDir, helper, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		const markerPath = path.join(workspaceDir, "mcp-gateway-marker")

		// Marker is intentionally absent: the first connection attempt must fail
		// (simulates the gateway still starting while the task begins).
		await rm(markerPath, { force: true })
		// The settings watcher only reacts to "change", and VS Code is already
		// running at this point. Write twice so the second write fires a change
		// event and the MCP server actually gets loaded.
		await writeMcpSettings(dlineDocsDir, markerPath)
		await writeMcpSettings(dlineDocsDir, markerPath)

		await helper.signin(sidebar)

		// First connection fails -> server shows disconnected with a retry action.
		await openMcpModal(sidebar)
		const row = sidebar.getByText(SERVER_NAME, { exact: true }).first()
		await expect(row).toBeVisible({ timeout: 60_000 })
		await expect(sidebar.getByRole("button", { name: "Retry Connection", exact: true })).toBeVisible({
			timeout: 60_000,
		})
		await closeMcpModal(sidebar)

		// Gateway becomes ready. Touch the settings file with identical content
		// so the watcher triggers a reconcile without any config change.
		await writeFile(markerPath, "ready", "utf8")
		await writeMcpSettings(dlineDocsDir, markerPath)
		await writeMcpSettings(dlineDocsDir, markerPath)

		// The failed connection must recover automatically on the next reconcile
		// (no manual retry). "Retry Connection" disappears once connected.
		await openMcpModal(sidebar)
		await expect(sidebar.getByRole("button", { name: "Retry Connection", exact: true })).toHaveCount(0, {
			timeout: 120_000,
		})
		await closeMcpModal(sidebar)

		// The compact chat modal intentionally disables server expansion. Open the
		// full MCP configuration view to verify the recovered server's tool catalog.
		await openMcpModal(sidebar)
		await sidebar.getByRole("button", { name: "Go to MCP server settings", exact: true }).click()
		await expect(sidebar.getByRole("heading", { name: "MCP Servers", exact: true })).toBeVisible()
		const recoveredServerRow = sidebar.getByText(SERVER_NAME, { exact: true }).filter({ visible: true })
		await expect(recoveredServerRow).toHaveCount(1, { timeout: 60_000 })
		await recoveredServerRow.click()
		await expect(sidebar.getByRole("tab", { name: /^Tools \([1-9]\d*\)$/, exact: true })).toBeVisible({
			timeout: 60_000,
		})
		await sidebar.getByRole("button", { name: "Done", exact: true }).click()
		await expect(sidebar.getByTestId("chat-input")).toBeVisible()

		// Disabled servers stay listed with their toggles off.
		await openMcpModal(sidebar)
		await expect(sidebar.getByText("fetch", { exact: true })).toBeVisible({ timeout: 30_000 })
		await expect(sidebar.getByText("vitest", { exact: true })).toBeVisible({ timeout: 30_000 })
		await closeMcpModal(sidebar)

		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [
			/Failed to connect to new MCP server/,
			/Failed to reconnect MCP server/,
			/MCP gateway not ready yet/,
		])
	},
)

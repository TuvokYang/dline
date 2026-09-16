import { mkdir, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { expect, type Frame } from "@playwright/test"
import { e2e } from "./utils/helpers"

/**
 * Searching a path the scan rules exclude.
 *
 * Two exclusions share one mechanism but not one authority. Repository rules
 * and the built-in directory floor prune the walk to bound its cost, so a
 * caller that names such a path has already bounded it. An `.agentignore`
 * entry states what the workspace forbids, and naming the path must not widen
 * it — otherwise a refusal only pushes the agent towards a shell command that
 * ignores the boundary entirely.
 *
 * Real ripgrep is what makes this worth an E2E: `--ignore-file` and ripgrep's
 * own reading of `.gitignore` are separate filters, and lifting one still
 * returns nothing. A stubbed process proves which arguments were chosen, not
 * that the search actually finds the file.
 */

const MARKER = "E2E_DESCENT_MARKER"
const VENDOR_DIRECTORY = "e2e-vendor"
const VENDOR_RELATIVE_PATH = `${VENDOR_DIRECTORY}/bundled.js`
const TRACKED_RELATIVE_PATH = "e2e-src/app.ts"
const VAULT_DIRECTORY = "e2e-vault"

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

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

/** Write the marker into a gitignored directory and a tracked one. */
async function seedWorkspace(workspaceDir: string): Promise<void> {
	await writeFile(path.join(workspaceDir, ".gitignore"), `${VENDOR_DIRECTORY}/\n`, "utf8")

	await mkdir(path.join(workspaceDir, VENDOR_DIRECTORY), { recursive: true })
	await writeFile(path.join(workspaceDir, VENDOR_RELATIVE_PATH), `const value = "${MARKER}"\n`, "utf8")

	await mkdir(path.join(workspaceDir, "e2e-src"), { recursive: true })
	await writeFile(path.join(workspaceDir, TRACKED_RELATIVE_PATH), `export const value = "${MARKER}"\n`, "utf8")
}

e2e(
	"search_files finds a match inside a gitignored directory the caller named",
	async ({ helper, server, sidebar, workspaceDir }) => {
		e2e.setTimeout(120_000)
		await seedWorkspace(workspaceDir)

		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Read project files", true)

		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_descend",
				name: "search_files",
				arguments: { path: VENDOR_DIRECTORY, regex: MARKER },
			},
			{
				type: "tool",
				id: "call_descend_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_DESCENT_FOUND" },
				// The file is reachable only because the caller named the directory,
				// and the result says so rather than reporting a bare zero.
				expectedToolResults: [{ callId: "call_descend", contentIncludes: "bundled.js" }],
			},
		)

		await sendTask(sidebar, "Search the vendor directory for the marker.")
		await expect(sidebar.getByText("E2E_DESCENT_FOUND", { exact: false }).last()).toBeVisible({ timeout: 60_000 })

		const consumptions = server.getMockConsumptions("openai-compatible-chat")
		expect(consumptions).toHaveLength(2)
		expect(consumptions[1]?.contractError).toBeUndefined()

		const searchResult = consumptions[1]?.requestToolResults.find((entry) => entry.callId === "call_descend")
		expect(searchResult?.content ?? "").toContain("bundled.js")
		// Silence would read as "absent"; the reason the path is unusual is stated.
		expect(searchResult?.content ?? "").toContain("normally pruned")
	},
)

e2e(
	"search_files keeps pruning that directory when the search starts above it",
	async ({ helper, server, sidebar, workspaceDir }) => {
		e2e.setTimeout(120_000)
		await seedWorkspace(workspaceDir)

		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Read project files", true)

		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_root_search",
				name: "search_files",
				arguments: { path: ".", regex: MARKER },
			},
			{
				type: "tool",
				id: "call_root_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_ROOT_SEARCH_PRUNED" },
				expectedToolResults: [{ callId: "call_root_search", contentIncludes: "app.ts" }],
			},
		)

		await sendTask(sidebar, "Search the whole workspace for the marker.")
		await expect(sidebar.getByText("E2E_ROOT_SEARCH_PRUNED", { exact: false }).last()).toBeVisible({ timeout: 60_000 })

		const consumptions = server.getMockConsumptions("openai-compatible-chat")
		expect(consumptions).toHaveLength(2)
		expect(consumptions[1]?.contractError).toBeUndefined()

		const searchResult = consumptions[1]?.requestToolResults.find((entry) => entry.callId === "call_root_search")
		expect(searchResult?.content ?? "").toContain("app.ts")
		// Widening one search must not widen the default walk.
		expect(searchResult?.content ?? "").not.toContain("bundled.js")
		expect(searchResult?.content ?? "").not.toContain("normally pruned")
	},
)

e2e(
	"search_files refuses an agentignore-restricted directory even when named directly",
	async ({ helper, server, sidebar, workspaceDir }) => {
		e2e.setTimeout(120_000)
		// `-s` removes the scan permission, which is the permission searching needs.
		await writeFile(path.join(workspaceDir, ".agentignore"), `${VAULT_DIRECTORY}/ -s\n`, "utf8")
		await mkdir(path.join(workspaceDir, VAULT_DIRECTORY), { recursive: true })
		await writeFile(path.join(workspaceDir, `${VAULT_DIRECTORY}/secret.txt`), `${MARKER}\n`, "utf8")

		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Read project files", true)

		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_restricted",
				name: "search_files",
				arguments: { path: VAULT_DIRECTORY, regex: MARKER },
			},
			{
				type: "tool",
				id: "call_restricted_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_RESTRICTED_REFUSED" },
				// The refusal must name the authority, so the model does not retry
				// through the terminal.
				expectedToolResults: [{ callId: "call_restricted", contentIncludes: ".agentignore" }],
			},
		)

		await sendTask(sidebar, "Search the vault directory for the marker.")
		await expect(sidebar.getByText("E2E_RESTRICTED_REFUSED", { exact: false }).last()).toBeVisible({ timeout: 60_000 })

		const consumptions = server.getMockConsumptions("openai-compatible-chat")
		expect(consumptions).toHaveLength(2)
		expect(consumptions[1]?.contractError).toBeUndefined()

		const searchResult = consumptions[1]?.requestToolResults.find((entry) => entry.callId === "call_restricted")
		expect(searchResult?.content ?? "").not.toContain("secret.txt")
		expect(searchResult?.content ?? "").toContain(".agentignore")
	},
)

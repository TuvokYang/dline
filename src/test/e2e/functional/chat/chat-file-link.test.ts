import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Page } from "@playwright/test"
import type { ElectronApplication } from "playwright"

const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

async function prepareLinkProfile(dlineDir: string): Promise<void> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as Array<{ name: string }>
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAi)
	if (!profile) throw new Error(`Missing E2E profile: ${E2E_PROFILE_NAMES.mockOpenAi}`)

	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
	settings.actModeProfile = profile.name
	settings.planModeProfile = profile.name
	settings.clineWebToolsEnabled = false
	await writeFile(settingsPath(dlineDir), `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

async function openSidebar(
	openVSCode: (workspacePath: string) => Promise<ElectronApplication>,
	workspaceDir: string,
	helper: E2ETestHelper,
): Promise<{ app: ElectronApplication; page: Page; sidebar: Frame }> {
	const app = await openVSCode(workspaceDir)
	const page = await app.firstWindow()
	await E2ETestHelper.openClineSidebar(page)
	const sidebar = await helper.getSidebar(page)
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	await helper.signin(sidebar)
	return { app, page, sidebar }
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

e2e(
	"Chat renders a project-relative PNG link that opens the file in the editor",
	async ({ dlineDir, dlineDocsDir, dlineHomeDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		expect(path.resolve(dlineHomeDir)).toBe(path.resolve(dlineDir))
		expect(path.resolve(dlineDocsDir)).not.toBe(path.resolve(dlineDir))
		await prepareLinkProfile(dlineDir)

		// A text file avoids the image-preview extension dependency: the E2E extension host
		// disables all extensions (including VS Code's built-in image preview).
		const fileName = "test-failed-1.md"
		await writeFile(path.join(workspaceDir, fileName), "# E2E file link target\n")

		// Trailing bidi control characters (as pasted from file explorers or logs) must not break the link.
		const linkText = `[${fileName}](${fileName}\u200e)`
		const completion = "E2E_LOCAL_FILE_LINK_OPEN_OK"
		server.enqueueResponses(
			"openai-compatible-chat",
			{
				type: "message",
				text: `Screenshot: ${linkText}\n\n${completion}`,
				delayMs: 250,
			},
			{
				type: "tools",
				tools: [{ id: "call_link_done", name: "attempt_completion", arguments: { result: completion } }],
			},
		)

		let app: ElectronApplication | undefined
		try {
			const opened = await openSidebar(openVSCode, workspaceDir, helper)
			app = opened.app
			await sendTask(opened.sidebar, "Open the screenshot file and finish.")

			// The assistant message renders the project-relative link.
			const link = opened.sidebar.getByRole("link", { name: fileName })
			await expect(link).toBeVisible({ timeout: 60_000 })
			await link.click()

			// The file service opens the workspace file in a VS Code editor tab.
			const fileTab = opened.page.getByRole("tab", { name: fileName })
			await expect(fileTab).toBeVisible({ timeout: 30_000 })
			await expect(opened.sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 30_000 })
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)

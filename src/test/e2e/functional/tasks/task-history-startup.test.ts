import path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { seedLegacyTaskHistory } from "@e2e/utils/task-history-store"
import { expect } from "@playwright/test"

e2e("Startup does not prompt to reconstruct an empty task history", async ({ page, sidebar }) => {
	await expect(sidebar.locator("body")).toBeVisible()
	await page.waitForTimeout(1_000)

	await expect(page.getByRole("button", { name: "Yes, Reconstruct", exact: true })).toHaveCount(0)
	await expect(page.getByText("This will rebuild your task history index", { exact: false })).toHaveCount(0)
})

e2e.describe("Initial state hydration", () => {
	e2e.use({ forceStaleInitialState: true })

	e2e(
		"hydrates when an unsent state build overtakes the first subscription snapshot",
		async ({ helper, sidebar, userDataDir }) => {
			await helper.signin(sidebar)
			await expect(sidebar.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 })
			await expect
				.poll(async () => (await E2ETestHelper.readDlineOutput(userDataDir)).includes("Delivered initial revision"))
				.toBe(true)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		},
	)
})

e2e(
	"Welcome history - first launch loads the default Workspace filter without toggling through All",
	async ({ dlineDocsDir, helper, openVSCode, userDataDir, workspaceDir }) => {
		const taskText = "E2E_WELCOME_WORKSPACE_INITIAL_LOAD"
		const baseTimestamp = Date.now() - 10_000
		const taskHistory = [
			{
				id: "e2e-welcome-workspace-initial-load",
				ts: baseTimestamp,
				task: taskText,
				cwdOnTaskInitialization: workspaceDir,
			},
			...Array.from({ length: 101 }, (_, index) => ({
				id: `e2e-other-workspace-${index}`,
				ts: baseTimestamp + index + 1,
				task: `E2E_OTHER_WORKSPACE_${index}`,
				cwdOnTaskInitialization: path.join(workspaceDir, "other-workspace"),
			})),
		]
		await seedLegacyTaskHistory(dlineDocsDir, taskHistory)
		const app = await openVSCode(workspaceDir)

		try {
			const page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await helper.signin(sidebar)
			await page.screenshot({ path: e2e.info().outputPath("welcome-first-launch.png") })

			const workspaceFilter = sidebar.getByRole("button", { name: "Workspace", exact: true })
			await expect(workspaceFilter).toHaveAttribute("aria-pressed", "true")
			await expect(sidebar.getByText(taskText, { exact: true })).toBeVisible({ timeout: 30_000 })
			await expect(sidebar.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "false")
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

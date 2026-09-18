import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

/** Enable one auto-approve action so the tools run without an approval prompt. */
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

e2e(
	"WS-061 tool group - search and read rows show their target, scope and scale with a full-path tooltip",
	async ({ helper, page, server, sidebar, userDataDir }, testInfo) => {
		e2e.setTimeout(150_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Read project files", true)
		server.resetOpenAiMock()

		const completionMarker = "E2E_TOOL_GROUP_ROWS_DONE"
		server.enqueueOpenAiResponses(
			{
				type: "tools",
				tools: [
					{ id: "call_group_read", name: "read_file", arguments: { path: "README.md" } },
					{
						id: "call_group_search",
						name: "search_files",
						arguments: { path: ".", regex: "Test|Workspace|extension|testing|coverage" },
					},
				],
			},
			{
				type: "tool",
				id: "call_group_completion",
				name: "attempt_completion",
				arguments: { result: completionMarker },
			},
		)

		await sendTask(sidebar, "Read the project README and search the workspace for a few terms.")
		await expect(sidebar.getByText(completionMarker, { exact: false }).last()).toBeVisible({ timeout: 90_000 })

		// The visible row exposes the complete search target through its accessible name;
		// responsive fitting of the button text is covered by the component-level width tests.
		const searchRow = sidebar.getByRole("button", {
			name: /^"Test \| Workspace \| extension \| testing \| coverage" in workspace\/ \(\d+\+? matches · \d+ files?\)$/,
		})
		await expect(searchRow).toBeVisible({ timeout: 30_000 })
		await expect(searchRow).toHaveAttribute(
			"aria-label",
			/^"Test \| Workspace \| extension \| testing \| coverage" in workspace\/ \(\d+\+? matches · \d+ files?\)$/,
		)

		// The read row exposes its complete target through the visible button's accessible name.
		await expect(sidebar.getByRole("button", { name: /^README\.md · lines \d+-\d+$/ })).toBeVisible()

		// Hovering a row reveals the untruncated text.
		await searchRow.hover()
		const tooltip = sidebar.locator('[data-slot="tooltip-content"]')
		await expect(tooltip.first()).toBeVisible({ timeout: 10_000 })
		await expect(tooltip.first()).toContainText('"Test | Workspace | extension | testing | coverage"')

		const screenshotPath = testInfo.outputPath("tool-group-rows.png")
		await page.screenshot({ path: screenshotPath, fullPage: false })
		await testInfo.attach("tool-group-rows.png", { path: screenshotPath, contentType: "image/png" })

		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/Error fetching OpenRouter models/])
	},
)

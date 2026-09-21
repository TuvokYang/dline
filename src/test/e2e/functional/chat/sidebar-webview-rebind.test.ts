import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Page } from "@playwright/test"

async function reacquireSidebar(page: Page, helper: E2ETestHelper): Promise<Frame> {
	helper.clearCachedFrame()
	const sidebar = await helper.getSidebar(page)
	await expect(sidebar.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 })
	await expect(sidebar.getByTestId("hydration-pending")).toHaveCount(0)
	await expect(sidebar.getByTestId("hydration-failed")).toHaveCount(0)
	return sidebar
}

async function hideAndRevealSidebar(page: Page, helper: E2ETestHelper): Promise<Frame> {
	const dlineTab = page.getByRole("tab", { name: /Dline/ })
	await page.keyboard.press("ControlOrMeta+B")
	await expect(dlineTab).toHaveAttribute("aria-expanded", "false")
	await page.keyboard.press("ControlOrMeta+B")
	await E2ETestHelper.openClineSidebar(page)
	return reacquireSidebar(page, helper)
}

e2e(
	"Sidebar lifecycle - repeated hide and reveal preserves hydration and interaction",
	async ({ helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(240_000)
		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses({
			type: "tool",
			id: "call_sidebar_rebind_first",
			name: "attempt_completion",
			arguments: { result: "E2E_SIDEBAR_REBIND_FIRST" },
		})
		server.enqueueOpenAiResponses({
			type: "tool",
			id: "call_sidebar_rebind_second",
			name: "attempt_completion",
			arguments: { result: "E2E_SIDEBAR_REBIND_SECOND" },
		})

		const input = sidebar.getByTestId("chat-input")
		await input.fill("Complete the first sidebar generation.")
		await sidebar.getByTestId("send-button").click()
		await expect(sidebar.getByText("E2E_SIDEBAR_REBIND_FIRST", { exact: true })).toBeVisible({ timeout: 60_000 })

		let reboundSidebar = sidebar
		for (let iteration = 0; iteration < 3; iteration++) {
			reboundSidebar = await hideAndRevealSidebar(page, helper)
			await expect(reboundSidebar.getByText("E2E_SIDEBAR_REBIND_FIRST", { exact: true })).toBeVisible({ timeout: 30_000 })
		}

		const reboundInput = reboundSidebar.getByTestId("chat-input")
		await reboundInput.fill("Complete after the sidebar view is rebound.")
		await reboundSidebar.getByTestId("send-button").click()
		await expect(reboundSidebar.getByText("E2E_SIDEBAR_REBIND_SECOND", { exact: true })).toBeVisible({ timeout: 60_000 })

		reboundSidebar = await hideAndRevealSidebar(page, helper)
		await expect(reboundSidebar.getByText("E2E_SIDEBAR_REBIND_SECOND", { exact: true })).toBeVisible({ timeout: 30_000 })
		await expect(reboundSidebar.getByTestId("chat-input")).toBeEnabled()

		expect(server.getRequestCount("openai-compatible-chat")).toBe(2)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

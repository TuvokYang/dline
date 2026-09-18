import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Page } from "@playwright/test"

async function selectProfile(sidebar: Frame, profileName: string): Promise<void> {
	const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
	if ((await modelSwitcher.innerText()).trim() === profileName) return

	await modelSwitcher.click()
	const profileOption = sidebar.getByRole("option").filter({ has: sidebar.getByText(profileName, { exact: true }) })
	await expect(profileOption).toHaveCount(1)
	await profileOption.click()
	await expect(modelSwitcher).toHaveText(profileName)
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

async function setBrowserToolEnabled(page: Page, sidebar: Frame, enabled: boolean): Promise<void> {
	await page.getByRole("button", { name: "Settings", exact: true }).click()
	await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible()
	await sidebar.getByTestId("tab-browser").click()
	await expect(sidebar.getByRole("heading", { name: "Browser Settings" })).toBeVisible()

	const disableBrowserTool = sidebar.locator("vscode-checkbox").filter({ hasText: "Disable browser tool usage" })
	await expect(disableBrowserTool).toHaveCount(1)
	const isDisabled = () => disableBrowserTool.evaluate((element) => Boolean((element as HTMLInputElement).checked))
	if ((await isDisabled()) === enabled) {
		await sidebar.getByText("Disable browser tool usage", { exact: true }).click()
	}
	await expect.poll(isDisabled).toBe(!enabled)
	await sidebar.getByRole("button", { name: "Done", exact: true }).click()
	await expect(sidebar.getByTestId("chat-input")).toBeVisible()
}

async function closeAndReopenTask(page: Page, sidebar: Frame, taskText: string): Promise<void> {
	const closeTask = sidebar.getByRole("button", { name: "Close Task", exact: true })
	await expect(closeTask).toBeVisible({ timeout: 30_000 })
	await closeTask.click()
	await expect(sidebar.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 })
	await page.getByRole("button", { name: "History", exact: true }).click()
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	const historyTask = sidebar.locator(".history-item").filter({ hasText: taskText })
	await expect(historyTask).toHaveCount(1)
	await historyTask.click()
	await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
	await expect(sidebar.getByText(taskText, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

e2e(
	"Completion rendering keeps earlier reasoning before the completed result without a stale streaming state",
	async ({ helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(150_000)
		await helper.signin(sidebar)
		await selectProfile(sidebar, E2E_PROFILE_NAMES.mockOpenAiResponses)

		const taskText = "Complete after showing one reasoning summary."
		const reasoningMarker = "E2E_REASONING_BEFORE_COMPLETION"
		const completionMarker = "E2E_REASONING_COMPLETION_DONE"
		server.resetOpenAiMock()
		server.enqueueResponses("openai-compatible-responses", {
			type: "tool",
			id: "call_reasoning_completion_order",
			name: "attempt_completion",
			arguments: { result: completionMarker },
			reasoning: reasoningMarker,
		})

		await sendTask(sidebar, taskText)
		const thinking = sidebar.getByRole("button", { name: "Thinking", exact: true }).last()
		const completion = sidebar.getByText(completionMarker, { exact: false }).last()
		await expect(thinking).toBeVisible({ timeout: 60_000 })
		await expect(completion).toBeVisible({ timeout: 60_000 })

		const reasoningPrecedesCompletion = await thinking.evaluate(
			(thinkingElement, completionElement) => {
				if (!(completionElement instanceof Node)) return false
				return Boolean(thinkingElement.compareDocumentPosition(completionElement) & Node.DOCUMENT_POSITION_FOLLOWING)
			},
			await completion.elementHandle(),
		)
		expect(reasoningPrecedesCompletion).toBe(true)
		await thinking.click()
		await expect(sidebar.getByText(reasoningMarker, { exact: false }).last()).toBeVisible()
		await expect(sidebar.getByText("Thinking...", { exact: true })).toHaveCount(0)
		await expect(sidebar.getByText("Waiting...", { exact: true })).toHaveCount(0)

		const requestsBeforeReopen = server.getRequestCount("openai-compatible-responses")
		await closeAndReopenTask(page, sidebar, taskText)
		const restoredThinking = sidebar.getByRole("button", { name: "Thinking", exact: true }).last()
		const restoredCompletion = sidebar.getByText(completionMarker, { exact: false }).last()
		await expect(restoredThinking).toBeVisible()
		await expect(restoredCompletion).toBeVisible()
		const restoredReasoningPrecedesCompletion = await restoredThinking.evaluate(
			(thinkingElement, completionElement) => {
				if (!(completionElement instanceof Node)) return false
				return Boolean(thinkingElement.compareDocumentPosition(completionElement) & Node.DOCUMENT_POSITION_FOLLOWING)
			},
			await restoredCompletion.elementHandle(),
		)
		expect(restoredReasoningPrecedesCompletion).toBe(true)
		expect(server.getRequestCount("openai-compatible-responses")).toBe(requestsBeforeReopen)
		await expect(sidebar.getByText("Thinking...", { exact: true })).toHaveCount(0)
		await expect(sidebar.getByText("Waiting...", { exact: true })).toHaveCount(0)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Browser Session keeps navigation at the frame top and ordinary reasoning and text outside the frame",
	async ({ helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await selectProfile(sidebar, E2E_PROFILE_NAMES.mockOpenAiResponses)
		await setBrowserToolEnabled(page, sidebar, true)
		await setAutoApproveAction(sidebar, "Use the browser", true)

		const taskText = "Use the local browser page, scroll down and up, then complete."
		const browserUrl = `${server.baseUrl}/mock/web-fetch/page`
		const reasoningMarker = "E2E_BROWSER_REASONING_OUTSIDE_FRAME"
		const responseMarker = "E2E_BROWSER_RESPONSE_OUTSIDE_FRAME"
		const completionMarker = "E2E_BROWSER_RENDERING_DONE"
		server.resetOpenAiMock()
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_browser_launch_rendering",
				name: "browser_action",
				arguments: { action: "launch", url: browserUrl },
			},
			{
				type: "tool",
				id: "call_browser_scroll_down_rendering",
				name: "browser_action",
				arguments: { action: "scroll_down" },
				reasoning: reasoningMarker,
			},
			{
				type: "message",
				text: responseMarker,
			},
			{
				type: "tool",
				id: "call_browser_scroll_up_rendering",
				name: "browser_action",
				arguments: { action: "scroll_up" },
			},
			{
				type: "tool",
				id: "call_browser_rendering_completion",
				name: "attempt_completion",
				arguments: { result: completionMarker },
				delayMs: 15_000,
			},
		)

		await sendTask(sidebar, taskText)
		await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 120_000 }).toBe(5)

		const frame = sidebar.getByTestId("browser-session-frame")
		const toolbar = sidebar.getByTestId("browser-session-toolbar")
		const previous = toolbar.getByRole("button", { name: "Previous browser step" })
		const screenshot = frame.getByRole("img", { name: "Browser screenshot" })
		const thinking = sidebar.getByRole("button", { name: "Thinking", exact: true }).last()
		const response = sidebar.getByText(responseMarker, { exact: false })
		await expect(frame).toBeVisible()
		await expect(toolbar).toBeVisible()
		await expect(previous).toBeVisible()
		await expect(screenshot).toBeVisible()
		await expect(thinking).toBeVisible()
		await expect(response).toHaveCount(1)
		await expect(frame.getByRole("button", { name: "Thinking", exact: true })).toHaveCount(0)
		await expect(frame.getByText(responseMarker, { exact: false })).toHaveCount(0)
		await thinking.click()
		const reasoning = sidebar.getByText(reasoningMarker, { exact: false })
		await expect(reasoning).toHaveCount(1)
		await expect(frame.getByText(reasoningMarker, { exact: false })).toHaveCount(0)

		const toolbarPrecedesScreenshot = await toolbar.evaluate(
			(toolbarElement, screenshotElement) => {
				if (!(screenshotElement instanceof Node)) return false
				return Boolean(toolbarElement.compareDocumentPosition(screenshotElement) & Node.DOCUMENT_POSITION_FOLLOWING)
			},
			await screenshot.elementHandle(),
		)
		expect(toolbarPrecedesScreenshot).toBe(true)
		const framePrecedesReasoning = await frame.evaluate(
			(frameElement, reasoningElement) => {
				if (!(reasoningElement instanceof Node)) return false
				return Boolean(frameElement.compareDocumentPosition(reasoningElement) & Node.DOCUMENT_POSITION_FOLLOWING)
			},
			await reasoning.elementHandle(),
		)
		expect(framePrecedesReasoning).toBe(true)

		await expect(sidebar.getByText(completionMarker, { exact: false }).last()).toBeVisible({ timeout: 120_000 })
		const consumptions = server.getMockConsumptions("openai-compatible-responses")
		expect(consumptions.every((entry) => entry.contractError === undefined)).toBe(true)
		expect(consumptions.slice(0, 2).map((entry) => entry.toolName)).toEqual(["browser_action", "browser_action"])
		await expect(sidebar.getByText(/Native tool 'browser_action' was not available/, { exact: false })).toHaveCount(0)

		const requestsBeforeReopen = server.getRequestCount("openai-compatible-responses")
		await closeAndReopenTask(page, sidebar, taskText)
		const restoredFrame = sidebar.getByTestId("browser-session-frame")
		const restoredToolbar = sidebar.getByTestId("browser-session-toolbar")
		await expect(restoredFrame).toBeVisible()
		await expect(restoredToolbar).toBeVisible()
		await expect(restoredToolbar.getByRole("button", { name: "Previous browser step" })).toBeVisible()
		await expect(restoredFrame.getByRole("button", { name: "Thinking", exact: true })).toHaveCount(0)
		await expect(restoredFrame.getByText(responseMarker, { exact: false })).toHaveCount(0)
		await expect(sidebar.getByText(responseMarker, { exact: false })).toHaveCount(1)
		expect(server.getRequestCount("openai-compatible-responses")).toBe(requestsBeforeReopen)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

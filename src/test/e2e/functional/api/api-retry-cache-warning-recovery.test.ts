import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

async function submitFeedback(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled()
	await input.fill(text)
	await input.press("Enter")
	await expect(input).toHaveValue("")
}

e2e(
	"API retry - Retry takes over an in-flight automatic retry and terminal failure renders once",
	async ({ helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "error",
				status: 500,
				code: "e2e_manual_takeover_initial",
				message: "Initial automatic retry failure",
			},
			{
				type: "error",
				status: 500,
				code: "e2e_manual_takeover_in_flight",
				message: "Manual takeover request failed",
				delayMs: 8_000,
			},
			{
				type: "tool",
				name: "attempt_completion",
				arguments: { result: "E2E_MANUAL_RETRY_RECOVERED" },
			},
		)
		await helper.signin(sidebar)
		await sendTask(sidebar, "Exercise manual takeover of automatic API retry.")

		await expect.poll(() => server.getRequestCount("openai-compatible-chat"), { timeout: 60_000 }).toBe(2)
		const retry = sidebar.locator('vscode-button[aria-label="Retry"]')
		await expect(retry).toBeVisible()
		await expect(retry).toBeEnabled()
		await retry.click()

		const errorCards = sidebar.locator(
			'[data-testid="api-error-box"], [data-testid="error-message-box"], [data-testid="error-presentation-box"], [data-testid="error-retry-box"]',
		)
		await expect(sidebar.getByText("Manual takeover request failed", { exact: true })).toHaveCount(1, {
			timeout: 30_000,
		})
		await expect(errorCards).toHaveCount(1)
		await expect(sidebar.getByText("Automatic retry stopped", { exact: true })).toHaveCount(0)
		expect(server.getRequestCount("openai-compatible-chat")).toBe(2)

		await expect(retry).toBeEnabled()
		await retry.click()
		await expect.poll(() => server.getRequestCount("openai-compatible-chat"), { timeout: 30_000 }).toBe(3)
		await expect(sidebar.getByText("E2E_MANUAL_RETRY_RECOVERED", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		await expect(errorCards).toHaveCount(0)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [
			/Initial automatic retry failure/,
			/Manual takeover request failed/,
		])
	},
)

e2e("Prompt cache warning - stalled cache warning has a close button", async ({ helper, server, sidebar, userDataDir }) => {
	e2e.setTimeout(180_000)
	server.resetOpenAiMock()
	const stalledUsage = { inputTokens: 9_000, outputTokens: 100, cacheReadTokens: 1_000, cacheWriteTokens: 0 }
	server.enqueueOpenAiResponses(
		{
			type: "tool",
			name: "qna_respond",
			arguments: { response: "E2E_CACHE_WARNING_ROUND_ONE" },
			usage: stalledUsage,
		},
		{
			type: "tool",
			name: "qna_respond",
			arguments: { response: "E2E_CACHE_WARNING_ROUND_TWO" },
			usage: stalledUsage,
		},
		{
			type: "tool",
			name: "attempt_completion",
			arguments: { result: "E2E_CACHE_WARNING_READY" },
			usage: stalledUsage,
		},
	)
	await helper.signin(sidebar)
	await sendTask(sidebar, "Exercise the prompt cache warning close action.")

	await expect(sidebar.getByText("E2E_CACHE_WARNING_ROUND_ONE", { exact: true })).toBeVisible({ timeout: 60_000 })
	await expect(sidebar.getByText("Prompt cache warming", { exact: false })).toHaveCount(0)

	await submitFeedback(sidebar, "E2E_CACHE_WARNING_FEEDBACK_ONE")
	await expect(sidebar.getByText("E2E_CACHE_WARNING_ROUND_TWO", { exact: true })).toBeVisible({ timeout: 60_000 })
	const warming = sidebar.getByRole("status").filter({ hasText: "Prompt cache warming (2/3)" })
	await expect(warming).toBeVisible()
	const warmingClose = warming.getByRole("button", { name: "Dismiss" })
	await expect(warmingClose).toBeVisible()
	await warmingClose.click()
	await expect(warming).toHaveCount(0)

	await submitFeedback(sidebar, "E2E_CACHE_WARNING_FEEDBACK_TWO")
	await expect(sidebar.getByText("E2E_CACHE_WARNING_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })

	const warning = sidebar.getByRole("alert").filter({ hasText: "Prompt cache is not improving" })
	await expect(warning).toBeVisible()
	const close = warning.getByRole("button", { name: "Dismiss" })
	await expect(close).toBeVisible()
	await close.click()
	await expect(warning).toHaveCount(0)
	await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
})

import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

const FAILURE_MARKER = "E2E_RETRY_CARD_IDENTITY_FAILURE"
const FAILURE_CODE = "e2e_retry_card_identity"

/**
 * Enough consecutive failures for one automatic sequence to exhaust itself and
 * for the manual Retry that follows to fail again, which is exactly when a
 * duplicated card becomes observable.
 */
function exhaustingFailures(count: number) {
	return Array.from({ length: count }, () => ({
		type: "error" as const,
		status: 503,
		code: FAILURE_CODE,
		message: FAILURE_MARKER,
	}))
}

async function waitForRetryAction(sidebar: Frame) {
	const retryButton = sidebar.locator('vscode-button[aria-label="Retry"]')
	await expect(retryButton).toBeVisible({ timeout: 180_000 })
	return retryButton
}

/**
 * The terminal text of one automatic sequence. Waiting for it, rather than for
 * the Retry action alone, proves the sequence actually finished: the Retry
 * action stays visible while the sequence is still counting down, and the
 * declared backoff spans roughly a minute of scheduled waiting.
 */
async function waitForExhaustedSequence(sidebar: Frame) {
	await expect(sidebar.getByTestId("error-retry-countdown")).toContainText("automatic attempts were used", {
		timeout: 240_000,
	})
}

/**
 * The retry card is one live presentation of the current failure, not an
 * append-only log. Every automatic attempt and every accepted manual Retry
 * replaces the card it supersedes, so the transcript never stacks two identical
 * `API Request Failed` cards for the same unresolved request.
 */
e2e(
	"API failure - a retried request replaces its failure card instead of stacking a duplicate",
	async ({ helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(420_000)

		await helper.signin(sidebar)
		server.resetOpenAiMock()
		// One automatic sequence, one manual Retry, and a second automatic
		// sequence all fail, so the Task reaches manual recovery twice.
		server.enqueueResponses("openai-compatible-chat", ...exhaustingFailures(40))

		const input = sidebar.getByTestId("chat-input")
		await expect(input).toBeEnabled()
		await input.fill("E2E_RETRY_CARD_IDENTITY_TASK")
		await sidebar.getByTestId("send-button").click()

		const retryCard = sidebar.getByTestId("error-retry-box")
		const retryButton = await waitForRetryAction(sidebar)

		// The first sequence must finish before Retry is meaningful.
		await waitForExhaustedSequence(sidebar)
		await expect(retryCard).toHaveCount(1)

		// The accepted Retry owns the next attempt, so the card it supersedes
		// must be retired rather than kept beside the new failure. The stale
		// card is observable directly: it still reports the terminal state of
		// the sequence the Retry already replaced.
		await retryButton.click()
		await expect(retryCard).toHaveCount(0, { timeout: 120_000 })

		// Manual Retry takes ownership of recovery, so the next failure opens
		// the canonical recovery action without starting a new automatic
		// sequence. The transcript therefore holds one failure, not one card
		// per recovery attempt.
		await waitForRetryAction(sidebar)
		await expect(sidebar.getByText("API Request Failed", { exact: true })).toHaveCount(1)
		await expect(retryCard).toHaveCount(0)

		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [new RegExp(FAILURE_MARKER), new RegExp(FAILURE_CODE)])
	},
)

/**
 * The automatic sequence owns a declared attempt budget, and each attempt must
 * present its own countdown. A card that reports a different budget than the
 * scheduler uses leaves earlier attempts without a visible countdown.
 */
e2e(
	"API failure - every automatic attempt reports the declared retry budget",
	async ({ helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(420_000)

		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueResponses("openai-compatible-chat", ...exhaustingFailures(40))

		const input = sidebar.getByTestId("chat-input")
		await expect(input).toBeEnabled()
		await input.fill("E2E_RETRY_BUDGET_TASK")
		await sidebar.getByTestId("send-button").click()

		const countdown = sidebar.getByTestId("error-retry-countdown")
		// The first attempt already reports the full budget, so the countdown is
		// visible from attempt one rather than only on the final attempt.
		await expect(countdown).toContainText("of 5", { timeout: 120_000 })

		await waitForRetryAction(sidebar)
		await waitForExhaustedSequence(sidebar)
		await expect(countdown).toHaveText("All 5 automatic attempts were used.")

		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [new RegExp(FAILURE_MARKER), new RegExp(FAILURE_CODE)])
	},
)

import { e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

/**
 * Reproduction for feedback text returning to the composer after it was sent.
 *
 * After attempt_completion the composer stays enabled so the user can reply.
 * Submitting clears the composer before the dispatch result is known, and a
 * dispatch reported as rejected restores the captured draft. The restore guard
 * only checks that the task matches and the composer is empty, so it cannot
 * tell a draft that never reached the backend from one that was already
 * accepted — and the composer, unlike the footer actions, has no local latch
 * that would stop a second submission from being dispatched against the
 * revision the first one just superseded.
 *
 * These tests pin the observable contract: one submission produces exactly one
 * feedback entry, and the composer never shows that text again afterwards.
 */

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

async function expectSingleUserFeedback(sidebar: Frame, text: string): Promise<void> {
	const feedback = sidebar.getByTestId(/^(?:user|queued)-input-markdown-scroll$/).filter({ hasText: text })
	await expect(feedback).toHaveCount(1)
}

/**
 * Watch for the submitted text being shown as feedback and sitting in the
 * composer at the same time.
 *
 * A final assertion alone would miss a rebound that is corrected on the next
 * state publication, yet the user still sees it. Observing mutations catches
 * the transient overlap as well.
 */
async function startReboundObserver(sidebar: Frame, marker: string): Promise<void> {
	await sidebar.evaluate((submittedText) => {
		const scope = window as typeof window & {
			__dlineReboundSeen?: boolean
			__dlineReboundObserver?: MutationObserver
		}
		scope.__dlineReboundObserver?.disconnect()
		scope.__dlineReboundSeen = false
		const check = () => {
			const input = document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')
			const echoed = Array.from(
				document.querySelectorAll('[data-testid="direct-user-input"], [data-testid="queued-user-input"]'),
			).some((element) => element.textContent?.includes(submittedText))
			if (echoed && input?.value.includes(submittedText)) {
				scope.__dlineReboundSeen = true
			}
		}
		const observer = new MutationObserver(check)
		observer.observe(document.body, { childList: true, characterData: true, subtree: true })
		scope.__dlineReboundObserver = observer
		check()
	}, marker)
}

async function stopReboundObserver(sidebar: Frame): Promise<{ inputValue: string; rebound: boolean }> {
	return sidebar.evaluate(() => {
		const scope = window as typeof window & {
			__dlineReboundSeen?: boolean
			__dlineReboundObserver?: MutationObserver
		}
		scope.__dlineReboundObserver?.disconnect()
		const result = {
			inputValue: document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')?.value ?? "",
			rebound: scope.__dlineReboundSeen === true,
		}
		delete scope.__dlineReboundObserver
		delete scope.__dlineReboundSeen
		return result
	})
}

/**
 * Press Enter twice without yielding to the event loop in between.
 *
 * Both key events are handled before React re-renders from the optimistic
 * clear, so the second submission captures the same draft and the same
 * interaction revision as the first. Driving this from the page is what makes
 * the race deterministic; two awaited Playwright presses would let the state
 * settle in between.
 */
async function pressEnterTwiceWithoutYielding(sidebar: Frame): Promise<void> {
	await sidebar.evaluate(() => {
		const input = document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')
		if (!input) throw new Error("chat input not found")
		input.focus()
		const press = () =>
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }))
		press()
		press()
	})
}

e2e(
	"Completion draft - a rejected duplicate submission does not restore already sent feedback",
	async ({ helper, server, sidebar }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				name: "attempt_completion",
				arguments: { result: "E2E_REBOUND_COMPLETION_READY" },
			},
			{
				type: "tool",
				name: "attempt_completion",
				arguments: { result: "E2E_REBOUND_CONTINUATION_OK" },
			},
			{
				type: "error",
				status: 500,
				code: "unexpected_additional_request",
				message: "Feedback was dispatched more than once",
			},
		)

		await sendTask(sidebar, "E2E_REBOUND_TASK")
		await expect(sidebar.getByText("E2E_REBOUND_COMPLETION_READY", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		const taskFooter = sidebar.getByRole("contentinfo")
		await expect(taskFooter.getByText("Start New Task", { exact: true })).toBeVisible()

		const marker = "E2E_REBOUND_FEEDBACK"
		const input = sidebar.getByTestId("chat-input")
		await expect(input).toBeEnabled()
		await input.fill(marker)
		await startReboundObserver(sidebar, marker)
		await pressEnterTwiceWithoutYielding(sidebar)

		// The accepted submission must reach the model exactly once; a second
		// dispatch of the same draft is a duplicate, not a new turn.
		await expect(sidebar.getByText("E2E_REBOUND_CONTINUATION_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.openAiRequestCount).toBe(2)
		await expectSingleUserFeedback(sidebar, marker)

		const { inputValue, rebound } = await stopReboundObserver(sidebar)
		expect(rebound).toBe(false)
		expect(inputValue).toBe("")
	},
)

e2e("Completion draft - an ordinary post-completion reply leaves the composer empty", async ({ helper, server, sidebar }) => {
	e2e.setTimeout(180_000)
	await helper.signin(sidebar)
	server.resetOpenAiMock()
	server.enqueueOpenAiResponses(
		{
			type: "tool",
			name: "attempt_completion",
			arguments: { result: "E2E_SINGLE_COMPLETION_READY" },
		},
		{
			type: "tool",
			name: "attempt_completion",
			arguments: { result: "E2E_SINGLE_CONTINUATION_OK" },
		},
		{
			type: "error",
			status: 500,
			code: "unexpected_additional_request",
			message: "Feedback was dispatched more than once",
		},
	)

	await sendTask(sidebar, "E2E_SINGLE_REBOUND_TASK")
	await expect(sidebar.getByText("E2E_SINGLE_COMPLETION_READY", { exact: false }).last()).toBeVisible({
		timeout: 60_000,
	})

	const marker = "E2E_SINGLE_FEEDBACK"
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled()
	await input.fill(marker)
	await startReboundObserver(sidebar, marker)
	await input.press("Enter")

	await expect(sidebar.getByText("E2E_SINGLE_CONTINUATION_OK", { exact: false }).last()).toBeVisible({
		timeout: 60_000,
	})
	await expectSingleUserFeedback(sidebar, marker)

	// The composer is checked after the next turn has fully settled: a
	// restore triggered by a late response would land after the reply is
	// already on screen, which is exactly when the user notices it.
	const { inputValue, rebound } = await stopReboundObserver(sidebar)
	expect(rebound).toBe(false)
	expect(inputValue).toBe("")
})

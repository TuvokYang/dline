import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

/**
 * Coverage for an ask that is answered the moment it becomes visible.
 *
 * Symptom: a task stops making progress and only a cancel followed by a resume
 * brings it back. Field logs showed an 8h43m window with no API request and no
 * error — the task was waiting for a response that had already been sent.
 *
 * Cause: the channel opened its receive window only after the question had
 * been pushed to the webview. A user can answer as soon as the question is on
 * screen, so an answer landing in that gap was refused, and nothing re-sends
 * it. The waiting side then had nothing left to wake it.
 *
 * A unit test can force that ordering directly, but it cannot show that a real
 * webview answering a real ask keeps the task moving. That is what this file
 * covers: the answer is sent as soon as the control appears, with no settling
 * delay that would hide the race.
 */

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

e2e(
	"Interaction response - a question answered as soon as it appears keeps the task running",
	async ({ helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(240_000)
		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_ask",
				name: "ask_followup_question",
				arguments: {
					question: "E2E_QUESTION_WHICH_PATH",
					options: '["E2E_OPTION_FIRST", "E2E_OPTION_SECOND"]',
				},
			},
			{
				type: "tool",
				id: "call_after_answer",
				name: "attempt_completion",
				arguments: { result: "E2E_INTERACTION_CONTINUED" },
			},
		)

		await sendTask(sidebar, "Ask which path to take, then finish.")

		// Answer the instant the option is on screen. Waiting for the UI to
		// settle first would step over the very window this covers.
		const option = sidebar.getByText("E2E_OPTION_FIRST", { exact: false }).first()
		await option.waitFor({ state: "visible", timeout: 60_000 })
		await option.click()

		// The task must reach the queued completion. Before the fix the answer
		// was refused and the task waited here indefinitely.
		await expect(sidebar.getByText("E2E_INTERACTION_CONTINUED", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect(sidebar.getByTestId("chat-input")).toBeEnabled()

		// The follow-up request must actually have been made: a task that looks
		// finished in the UI but never sent the next request is the same defect
		// wearing a different face.
		const consumptions = server.getMockConsumptions()
		expect(consumptions.length).toBeGreaterThanOrEqual(2)
		expect(consumptions.some((entry) => entry.toolName === "attempt_completion")).toBe(true)
		expect(consumptions.every((entry) => entry.contractError === undefined)).toBe(true)

		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Interaction response - an approval answered immediately does not strand the task",
	async ({ helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(240_000)
		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_write",
				name: "write_to_file",
				arguments: {
					path: "e2e-interaction-response.txt",
					content: "E2E interaction response delivery",
				},
			},
			{
				type: "tool",
				id: "call_write_done",
				name: "attempt_completion",
				arguments: { result: "E2E_APPROVAL_CONTINUED" },
			},
		)

		await sendTask(sidebar, "Write the interaction response file, then finish.")

		// Same shape as the question case, on the approval path: the decision is
		// made the moment the control is usable, not after the view settles.
		const approve = sidebar.getByText("Approve", { exact: true }).first()
		await approve.waitFor({ state: "visible", timeout: 60_000 })
		await approve.click()

		await expect(sidebar.getByText("E2E_APPROVAL_CONTINUED", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect(sidebar.getByText("Approve", { exact: true })).toHaveCount(0)
		await expect(sidebar.getByTestId("chat-input")).toBeEnabled()
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

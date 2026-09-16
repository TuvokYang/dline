import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { expect, type Frame } from "@playwright/test"
import { E2E_PROFILE_NAMES } from "./utils/api-profile"
import { E2ETestHelper, e2e } from "./utils/helpers"
import { startFooterActionStabilityObserver, stopFooterActionStabilityObserver } from "./utils/ui-stability"

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

async function submitWithEnter(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled()
	await input.fill(text)
	await input.press("Enter")
	await expect(input).toHaveValue("")
	await expectSingleUserFeedback(sidebar, text)
}

async function expectSingleUserFeedback(sidebar: Frame, text: string): Promise<void> {
	const feedback = sidebar.getByTestId(/^(?:user|queued)-input-markdown-scroll$/).filter({ hasText: text })
	await expect(feedback).toHaveCount(1)
	await expect(feedback).toHaveText(text)
}

async function startEchoOverlapObserver(sidebar: Frame, marker: string): Promise<void> {
	await sidebar.evaluate((submittedText) => {
		const scope = window as typeof window & {
			__dlineEchoOverlap?: boolean
			__dlineEchoObserver?: MutationObserver
		}
		scope.__dlineEchoObserver?.disconnect()
		scope.__dlineEchoOverlap = false
		const checkForOverlap = () => {
			const input = document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')
			const echoedFeedback = Array.from(
				document.querySelectorAll('[data-testid="direct-user-input"], [data-testid="queued-user-input"]'),
			).some((element) => element.textContent?.includes(submittedText))
			if (echoedFeedback && input?.value === submittedText) {
				scope.__dlineEchoOverlap = true
			}
		}
		const observer = new MutationObserver(checkForOverlap)
		observer.observe(document.body, { childList: true, characterData: true, subtree: true })
		scope.__dlineEchoObserver = observer
		checkForOverlap()
	}, marker)
}

async function stopEchoOverlapObserver(sidebar: Frame): Promise<{ inputValue: string; overlap: boolean }> {
	return sidebar.evaluate(() => {
		const scope = window as typeof window & {
			__dlineEchoOverlap?: boolean
			__dlineEchoObserver?: MutationObserver
		}
		scope.__dlineEchoObserver?.disconnect()
		const result = {
			inputValue: document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')?.value ?? "",
			overlap: scope.__dlineEchoOverlap === true,
		}
		delete scope.__dlineEchoObserver
		delete scope.__dlineEchoOverlap
		return result
	})
}

async function closeCurrentTask(sidebar: Frame): Promise<void> {
	const closeButton = sidebar.getByRole("button", { name: "Close Task", exact: true })
	await expect(closeButton).toBeVisible()
	await closeButton.click()
	await expect(sidebar.getByTestId("chat-input")).toBeVisible()
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
}

async function reopenTask(sidebar: Frame, taskText: string): Promise<void> {
	const historyTask = sidebar.getByText(taskText, { exact: true }).last()
	await expect(historyTask).toBeVisible({ timeout: 30_000 })
	await historyTask.click()
	await expect(sidebar.getByText(taskText, { exact: true }).first()).toBeVisible()
}

async function onlyTaskId(dlineDocsDir: string): Promise<string> {
	const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true })
	const taskIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
	if (taskIds.length !== 1 || !taskIds[0]) {
		throw new Error(`Expected exactly one persisted task, found ${taskIds.length}`)
	}
	return taskIds[0]
}

async function configureGpt56ResponsesProfile(dlineDir: string): Promise<void> {
	const profilesPath = path.join(dlineDir, "data", "settings", "api_profiles.json")
	const profiles = JSON.parse(await readFile(profilesPath, "utf8")) as Array<{
		name: string
		modelId?: string
		webToolsMode?: string
		openai?: { capabilities?: { contextWindow?: number } }
	}>
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	if (!profile?.openai?.capabilities) throw new Error("Missing configurable OpenAI Responses E2E profile")
	profile.modelId = "gpt-5.6-sol"
	profile.openai.capabilities.contextWindow = 372_000
	profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	await writeFile(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`, "utf8")
}

async function expectNoDecisionButtons(sidebar: Frame): Promise<void> {
	const taskFooter = sidebar.getByRole("contentinfo")
	for (const label of ["Resume", "Start New Task", "Approve", "Reject", "Acknowledge", "Stop"]) {
		await expect(taskFooter.getByText(label, { exact: true })).toHaveCount(0)
	}
}

async function expectNoConflictingDecisionButtons(sidebar: Frame): Promise<void> {
	const taskFooter = sidebar.getByRole("contentinfo")
	for (const label of ["Start New Task", "Approve", "Reject", "Acknowledge", "Stop"]) {
		await expect(taskFooter.getByText(label, { exact: true })).toHaveCount(0)
	}
}

async function selectProfile(sidebar: Frame, profileName: string): Promise<void> {
	const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
	if ((await modelSwitcher.innerText()).trim() === profileName) return
	await modelSwitcher.click()
	await expect(sidebar.getByText("Available Models", { exact: true })).toBeVisible()
	const profileOption = sidebar.getByRole("option").filter({ has: sidebar.getByText(profileName, { exact: true }) })
	await expect(profileOption).toHaveCount(1)
	await profileOption.click()
	await expect(modelSwitcher).toHaveText(profileName)
	await expect(sidebar.getByText("Available Models", { exact: true })).not.toBeVisible()
}

e2e(
	"Chat input - Ctrl+Z and Ctrl+Y preserve bounded edit history without sending",
	async ({ helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses({
			type: "tool",
			name: "attempt_completion",
			arguments: { result: "E2E_INPUT_HISTORY_SEND_OK" },
		})

		const input = sidebar.getByTestId("chat-input")
		await input.click()
		await input.pressSequentially("alpha", { delay: 20 })
		await page.waitForTimeout(1_000)
		await input.pressSequentially(" beta", { delay: 20 })

		await input.press("Control+z")
		await expect(input).toHaveValue("alpha")
		await input.press("Control+z")
		await expect(input).toHaveValue("")
		await input.press("Control+y")
		await expect(input).toHaveValue("alpha")
		await input.press("Control+y")
		await expect(input).toHaveValue("alpha beta")
		expect(server.openAiRequestCount).toBe(0)

		await input.press("Control+z")
		await input.pressSequentially(" branch", { delay: 20 })
		await input.press("Control+y")
		await expect(input).toHaveValue("alpha branch")

		await sidebar.getByTestId("send-button").click()
		await expect(sidebar.getByText("alpha branch", { exact: true }).first()).toBeVisible()
		await expect(sidebar.getByText("E2E_INPUT_HISTORY_SEND_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		await expect(input).toHaveValue("")
		await expect.poll(() => server.openAiRequestCount).toBe(1)

		await input.press("Control+z")
		await expect(input).toHaveValue("alpha branch")
		await input.press("Control+y")
		await expect(input).toHaveValue("")
		await page.waitForTimeout(500)
		expect(server.openAiRequestCount).toBe(1)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Chat input - an unsent draft stays local while a running task completes",
	async ({ helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				name: "attempt_completion",
				arguments: { result: "E2E_UNSENT_DRAFT_TASK_DONE" },
				delayMs: 5_000,
			},
			{
				type: "error",
				status: 500,
				code: "unexpected_unsent_draft_request",
				message: "An unsent draft triggered an API request",
			},
		)

		await sendTask(sidebar, "E2E_UNSENT_DRAFT_RUNNING_TASK")
		await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(1)
		await expect(sidebar.getByRole("button", { name: "Cancel", exact: true }).first()).toBeVisible({
			timeout: 30_000,
		})

		const unsentDraft = "E2E_DRAFT_MUST_STAY_IN_INPUT"
		const input = sidebar.getByTestId("chat-input")
		await input.fill(unsentDraft)
		await expect(input).toHaveValue(unsentDraft)

		await expect(sidebar.getByText("E2E_UNSENT_DRAFT_TASK_DONE", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await page.waitForTimeout(1_000)

		await expect(input).toHaveValue(unsentDraft)
		const submittedFeedback = sidebar.getByTestId(/^(?:direct|queued)-user-input$/).filter({ hasText: unsentDraft })
		await expect(submittedFeedback).toHaveCount(0)
		expect(server.openAiRequestCount).toBe(1)
		expect(JSON.stringify(server.getOpenAiRequestBodies())).not.toContain(unsentDraft)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Chat input - Enter, mouse, and keyboard send clear as soon as accepted feedback is echoed",
	async ({ helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{ type: "tool", name: "qna_respond", arguments: { response: "E2E_ECHO_CLEAR_ENTER_PROMPT" } },
			{ type: "tool", name: "qna_respond", arguments: { response: "E2E_ECHO_CLEAR_MOUSE_PROMPT" } },
			{ type: "tool", name: "qna_respond", arguments: { response: "E2E_ECHO_CLEAR_KEYBOARD_PROMPT" } },
			{ type: "tool", name: "attempt_completion", arguments: { result: "E2E_ECHO_CLEAR_DONE" } },
		)

		await sendTask(sidebar, "E2E_ECHO_CLEAR_TASK")
		await expect(sidebar.getByText("E2E_ECHO_CLEAR_ENTER_PROMPT", { exact: true })).toBeVisible({ timeout: 60_000 })

		const input = sidebar.getByTestId("chat-input")
		const enterFeedback = "E2E_ECHO_CLEAR_ENTER_FEEDBACK"
		await input.fill(enterFeedback)
		await startEchoOverlapObserver(sidebar, enterFeedback)
		await input.press("Enter")
		await expectSingleUserFeedback(sidebar, enterFeedback)
		const enterObservation = await stopEchoOverlapObserver(sidebar)

		await expect(sidebar.getByText("E2E_ECHO_CLEAR_MOUSE_PROMPT", { exact: true })).toBeVisible({ timeout: 60_000 })
		const mouseFeedback = "E2E_ECHO_CLEAR_MOUSE_FEEDBACK"
		await input.fill(mouseFeedback)
		await startEchoOverlapObserver(sidebar, mouseFeedback)
		await sidebar.getByTestId("send-button").click()
		await expectSingleUserFeedback(sidebar, mouseFeedback)
		const mouseObservation = await stopEchoOverlapObserver(sidebar)

		await expect(sidebar.getByText("E2E_ECHO_CLEAR_KEYBOARD_PROMPT", { exact: true })).toBeVisible({ timeout: 60_000 })
		const keyboardFeedback = "E2E_ECHO_CLEAR_KEYBOARD_FEEDBACK"
		await input.fill(keyboardFeedback)
		await startEchoOverlapObserver(sidebar, keyboardFeedback)
		const sendButton = sidebar.getByRole("button", { name: "Send message", exact: true })
		await input.press("Tab")
		await expect(sendButton).toBeFocused()
		await sendButton.press("Space")
		await expectSingleUserFeedback(sidebar, keyboardFeedback)
		const keyboardObservation = await stopEchoOverlapObserver(sidebar)

		expect(enterObservation).toEqual({ inputValue: "", overlap: false })
		expect(mouseObservation).toEqual({ inputValue: "", overlap: false })
		expect(keyboardObservation).toEqual({ inputValue: "", overlap: false })
		await expect(sidebar.getByText("E2E_ECHO_CLEAR_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Chat input - keyboard-typed draft stays local when a partial stream ends with attempt_completion",
	async ({ helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await selectProfile(sidebar, E2E_PROFILE_NAMES.mockDeepSeek)
		server.resetOpenAiMock()
		server.enqueueResponses(
			"deepseek-chat",
			{
				type: "tool",
				id: "call_unsent_draft_stream_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_UNSENT_DRAFT_STREAM_DONE" },
				reasoning: "E2E_UNSENT_DRAFT_PARTIAL_REASONING",
				afterReasoningDelayMs: 5_000,
			},
			{
				type: "error",
				status: 500,
				code: "unexpected_unsent_draft_stream_request",
				message: "An unsent draft triggered an extra request after a streamed turn end",
			},
		)

		await sendTask(sidebar, "E2E_UNSENT_DRAFT_STREAM_TASK")
		await expect(sidebar.getByText("E2E_UNSENT_DRAFT_PARTIAL_REASONING", { exact: false })).toHaveCount(1, {
			timeout: 60_000,
		})
		await expect.poll(() => server.getRequestCount("deepseek-chat")).toBe(1)
		await expect(sidebar.getByRole("button", { name: "Cancel", exact: true }).first()).toBeVisible()

		const unsentDraft = "E2E_STREAM_TURN_END_DRAFT_MUST_STAY_LOCAL"
		const input = sidebar.getByTestId("chat-input")
		await input.click()
		await input.pressSequentially(unsentDraft, { delay: 20 })
		await expect(input).toHaveValue(unsentDraft)

		await expect(sidebar.getByText("E2E_UNSENT_DRAFT_STREAM_DONE", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await page.waitForTimeout(1_000)

		await expect(input).toHaveValue(unsentDraft)
		const submittedFeedback = sidebar.getByTestId(/^(?:direct|queued)-user-input$/).filter({ hasText: unsentDraft })
		await expect(submittedFeedback).toHaveCount(0)
		expect(server.getRequestCount("deepseek-chat")).toBe(1)
		expect(JSON.stringify(server.getMockConsumptions("deepseek-chat").map((entry) => entry.requestBody))).not.toContain(
			unsentDraft,
		)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Chat input - turn-end rendering during typing never replays the previous input history",
	async ({ helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{ type: "tool", name: "qna_respond", arguments: { response: "E2E_HISTORY_RACE_TURN_END_0" } },
			{
				type: "tool",
				name: "qna_respond",
				arguments: { response: "E2E_HISTORY_RACE_TURN_END_1" },
				delayMs: 1_000,
			},
			{
				type: "tool",
				name: "qna_respond",
				arguments: { response: "E2E_HISTORY_RACE_TURN_END_2" },
				delayMs: 1_000,
			},
			{
				type: "tool",
				name: "attempt_completion",
				arguments: { result: "E2E_HISTORY_RACE_COMPLETION_3" },
				delayMs: 1_000,
			},
			{
				type: "error",
				status: 500,
				code: "unexpected_stale_input_history_request",
				message: "Turn-end rendering replayed input history without an explicit submit",
			},
		)

		await sendTask(sidebar, "E2E_HISTORY_RACE_TASK")
		await expect(sidebar.getByText("E2E_HISTORY_RACE_TURN_END_0", { exact: true })).toBeVisible({ timeout: 60_000 })
		await submitWithEnter(sidebar, "E2E_PREVIOUS_INPUT_HISTORY_0")

		const submittedHistory = ["E2E_PREVIOUS_INPUT_HISTORY_0"]
		const input = sidebar.getByTestId("chat-input")
		let finalDraft = ""
		for (let turn = 1; turn <= 3; turn++) {
			const expectedRequestCount = turn + 1
			await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(expectedRequestCount)

			finalDraft = `E2E_CURRENT_DRAFT_${turn}_MUST_STAY_LOCAL_WHILE_THE_TURN_END_TOOL_IS_RENDERING`
			const splitIndex = 12
			const prefix = finalDraft.slice(0, splitIndex)
			await input.click()
			await input.pressSequentially(prefix, { delay: 20 })
			const turnEndText = turn === 3 ? "E2E_HISTORY_RACE_COMPLETION_3" : `E2E_HISTORY_RACE_TURN_END_${turn}`
			await expect(sidebar.getByText(turnEndText, { exact: true })).toBeVisible({ timeout: 60_000 })
			await expect(input).toHaveValue(prefix)
			await input.pressSequentially(finalDraft.slice(splitIndex), { delay: 20 })
			await page.waitForTimeout(500)

			await expect(input).toHaveValue(finalDraft)
			expect(server.openAiRequestCount).toBe(expectedRequestCount)
			if (turn < 3) {
				await input.press("Enter")
				await expect(input).toHaveValue("")
				await expectSingleUserFeedback(sidebar, finalDraft)
				submittedHistory.push(finalDraft)
			}
		}

		const requestBodies = server.getOpenAiRequestBodies().map((body) => JSON.stringify(body))
		expect(requestBodies).toHaveLength(4)
		for (const [index, submitted] of submittedHistory.entries()) {
			expect(requestBodies[index + 1]).toContain(submitted)
		}
		expect(requestBodies.join("\n")).not.toContain(finalDraft)
		await expect(sidebar.getByTestId(/^(?:direct|queued)-user-input$/).filter({ hasText: finalDraft })).toHaveCount(0)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Chat input - keyboard-typed draft stays local across an automatic task turn",
	async ({ helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "message",
				text: "E2E_UNSENT_DRAFT_INTERMEDIATE_TURN",
				delayMs: 5_000,
			},
			{
				type: "tool",
				name: "attempt_completion",
				arguments: { result: "E2E_UNSENT_DRAFT_MULTI_TURN_DONE" },
				delayMs: 5_000,
			},
			{
				type: "error",
				status: 500,
				code: "unexpected_unsent_draft_multi_turn_request",
				message: "An unsent draft triggered an extra multi-turn API request",
			},
		)

		await sendTask(sidebar, "E2E_UNSENT_DRAFT_MULTI_TURN_TASK")
		await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(1)
		await expect(sidebar.getByRole("button", { name: "Cancel", exact: true }).first()).toBeVisible({
			timeout: 30_000,
		})

		const unsentDraft = "E2E_KEYBOARD_DRAFT_MUST_STAY_LOCAL"
		const input = sidebar.getByTestId("chat-input")
		await input.click()
		await input.pressSequentially(unsentDraft, { delay: 20 })
		await expect(input).toHaveValue(unsentDraft)

		await expect(sidebar.getByText("E2E_UNSENT_DRAFT_INTERMEDIATE_TURN", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(2)
		await expect(input).toHaveValue(unsentDraft)
		await expect(sidebar.getByText("E2E_UNSENT_DRAFT_MULTI_TURN_DONE", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await page.waitForTimeout(1_000)

		await expect(input).toHaveValue(unsentDraft)
		const submittedFeedback = sidebar.getByTestId(/^(?:direct|queued)-user-input$/).filter({ hasText: unsentDraft })
		await expect(submittedFeedback).toHaveCount(0)
		expect(server.openAiRequestCount).toBe(2)
		expect(JSON.stringify(server.getOpenAiRequestBodies())).not.toContain(unsentDraft)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

const waitingTurnEndDraftCases = [
	{
		name: "qna_respond",
		response: {
			type: "tool" as const,
			name: "qna_respond",
			arguments: { response: "E2E_UNSENT_QNA_TURN_END" },
		},
		visibleText: "E2E_UNSENT_QNA_TURN_END",
	},
	{
		name: "generate_report",
		response: {
			type: "tool" as const,
			name: "generate_report",
			arguments: { title: "E2E_UNSENT_REPORT_TURN_END", content: "E2E_UNSENT_REPORT_CONTENT" },
		},
		visibleText: "E2E_UNSENT_REPORT_TURN_END",
	},
	{
		name: "make_plan",
		response: {
			type: "tool" as const,
			name: "make_plan",
			arguments: { response: "E2E_UNSENT_PLAN_TURN_END", needs_more_exploration: false },
		},
		visibleText: "E2E_UNSENT_PLAN_TURN_END",
	},
	{
		name: "ask_followup_question",
		response: {
			type: "tool" as const,
			name: "ask_followup_question",
			arguments: {
				question: "E2E_UNSENT_FOLLOWUP_TURN_END",
				options: ["E2E_UNSENT_FOLLOWUP_OPTION_A", "E2E_UNSENT_FOLLOWUP_OPTION_B"],
			},
		},
		visibleText: "E2E_UNSENT_FOLLOWUP_TURN_END",
	},
] as const

for (const turnEndCase of waitingTurnEndDraftCases) {
	e2e(
		`Chat input - unsent draft stays local when ${turnEndCase.name} hands control back`,
		async ({ helper, page, server, sidebar, userDataDir }) => {
			e2e.setTimeout(180_000)
			await helper.signin(sidebar)
			server.resetOpenAiMock()
			server.enqueueOpenAiResponses(
				{ ...turnEndCase.response, delayMs: 5_000 },
				{
					type: "error",
					status: 500,
					code: `unexpected_unsent_${turnEndCase.name}_request`,
					message: `An unsent draft triggered a request after ${turnEndCase.name}`,
				},
			)

			await sendTask(sidebar, `E2E_UNSENT_${turnEndCase.name.toUpperCase()}_TASK`)
			await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(1)
			await expect(sidebar.getByRole("button", { name: "Cancel", exact: true }).first()).toBeVisible({
				timeout: 30_000,
			})

			const unsentDraft = `E2E_${turnEndCase.name.toUpperCase()}_DRAFT_MUST_STAY_LOCAL`
			const input = sidebar.getByTestId("chat-input")
			await input.click()
			await input.pressSequentially(unsentDraft, { delay: 20 })
			await expect(input).toHaveValue(unsentDraft)

			await expect(sidebar.getByText(turnEndCase.visibleText, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await page.waitForTimeout(1_000)

			await expect(input).toHaveValue(unsentDraft)
			const submittedFeedback = sidebar.getByTestId(/^(?:direct|queued)-user-input$/).filter({ hasText: unsentDraft })
			await expect(submittedFeedback).toHaveCount(0)
			expect(server.openAiRequestCount).toBe(1)
			expect(JSON.stringify(server.getOpenAiRequestBodies())).not.toContain(unsentDraft)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		},
	)
}

e2e(
	"Task lifecycle - Cancel, Resume, and a post-completion turn preserve draft ownership",
	async ({ helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				name: "attempt_completion",
				arguments: { result: "E2E_CANCELLED_RESPONSE_MUST_NOT_RENDER" },
				delayMs: 30_000,
			},
			{
				type: "tool",
				name: "attempt_completion",
				arguments: { result: "E2E_RESUME_CONTINUATION_OK" },
			},
			{
				type: "tool",
				name: "attempt_completion",
				arguments: { result: "E2E_POST_COMPLETION_TURN_OK" },
			},
			{
				type: "error",
				status: 500,
				code: "unexpected_additional_request",
				message: "Unexpected request after post-completion turn",
			},
		)

		await sendTask(sidebar, "E2E_CANCEL_RESUME_TASK")
		await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(1)
		const cancelButton = sidebar.getByRole("button", { name: "Cancel", exact: true }).first()
		await expect(cancelButton).toBeVisible({ timeout: 30_000 })
		await cancelButton.click()

		const resumeButton = sidebar.getByRole("button", { name: "Resume", exact: true }).first()
		await expect(resumeButton).toBeVisible({ timeout: 30_000 })
		const input = sidebar.getByTestId("chat-input")
		await expect(input).toBeEnabled()
		await input.fill("E2E_RESUME_DRAFT")
		await resumeButton.click()
		await expect(input).toHaveValue("")
		await expectSingleUserFeedback(sidebar, "E2E_RESUME_DRAFT")
		await expect(sidebar.getByText("E2E_RESUME_CONTINUATION_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		await expect(sidebar.getByText("E2E_CANCELLED_RESPONSE_MUST_NOT_RENDER", { exact: false })).toHaveCount(0)
		await expect.poll(() => server.openAiRequestCount).toBe(2)
		expect(JSON.stringify(server.getOpenAiRequestBodies()[1])).toContain("E2E_RESUME_DRAFT")
		await expect(resumeButton).not.toBeVisible()
		const taskFooter = sidebar.getByRole("contentinfo")
		await expect(taskFooter.getByText("Start New Task", { exact: true })).toBeVisible()

		await submitWithEnter(sidebar, "E2E_POST_COMPLETION_INPUT")
		await expect(sidebar.getByText("E2E_POST_COMPLETION_TURN_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		await expect.poll(() => server.openAiRequestCount).toBe(3)
		expect(JSON.stringify(server.getOpenAiRequestBodies()[2])).toContain("E2E_POST_COMPLETION_INPUT")
		await expect(taskFooter.getByText("Start New Task", { exact: true })).toBeVisible()

		await closeCurrentTask(sidebar)
		await reopenTask(sidebar, "E2E_CANCEL_RESUME_TASK")
		await expect(taskFooter.getByText("Start New Task", { exact: true })).toBeVisible({ timeout: 30_000 })
		await expect(taskFooter.getByText("Resume", { exact: true })).toHaveCount(0)
		await expect(sidebar.getByTestId("chat-input")).toBeEnabled()
		await page.waitForTimeout(500)
		expect(server.openAiRequestCount).toBe(3)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Task lifecycle - Cancel after a visible partial stream stops it and resumes exactly once",
	async ({ helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await selectProfile(sidebar, E2E_PROFILE_NAMES.mockDeepSeek)
		server.resetOpenAiMock()
		server.enqueueResponses(
			"deepseek-chat",
			{
				type: "tool",
				id: "call_stream_cancelled_before_delivery",
				name: "attempt_completion",
				arguments: { result: "E2E_STREAM_CANCELLED_TOOL_MUST_NOT_RENDER" },
				reasoning: "E2E_STREAM_PARTIAL_BEFORE_CANCEL",
				afterReasoningDelayMs: 30_000,
			},
			{
				type: "tool",
				id: "call_stream_cancel_resumed_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_STREAM_CANCEL_RESUME_OK" },
				expectedRequestIncludes: ["E2E_STREAM_CANCEL_RESUME_DRAFT"],
				expectedRequestExcludes: ["E2E_STREAM_CANCELLED_TOOL_MUST_NOT_RENDER"],
			},
		)

		await sendTask(sidebar, "E2E_STREAM_CANCEL_TASK")
		const partial = sidebar.getByText("E2E_STREAM_PARTIAL_BEFORE_CANCEL", { exact: false })
		await expect(partial).toHaveCount(1, { timeout: 60_000 })
		await expect.poll(() => server.getRequestCount("deepseek-chat")).toBe(1)

		const taskFooter = sidebar.getByRole("contentinfo")
		const cancelButton = taskFooter.getByText("Cancel", { exact: true })
		await expect(cancelButton).toBeVisible({ timeout: 30_000 })
		await startFooterActionStabilityObserver(sidebar, ["Cancel"])
		await sidebar.page().waitForTimeout(1_000)
		const footerStabilityEvents = await stopFooterActionStabilityObserver(sidebar)
		expect(footerStabilityEvents).toEqual([])
		await cancelButton.click()

		const resumeButton = taskFooter.getByText("Resume", { exact: true })
		await expect(resumeButton).toBeVisible({ timeout: 30_000 })
		await expect(cancelButton).toHaveCount(0)
		await expect(sidebar.getByText("E2E_STREAM_CANCELLED_TOOL_MUST_NOT_RENDER", { exact: false })).toHaveCount(0)
		await expect(partial).toHaveCount(1)
		expect(server.getRequestCount("deepseek-chat")).toBe(1)

		const input = sidebar.getByTestId("chat-input")
		await expect(input).toBeEnabled()
		await input.fill("E2E_STREAM_CANCEL_RESUME_DRAFT")
		await resumeButton.click()
		await expect(input).toHaveValue("")
		await expectSingleUserFeedback(sidebar, "E2E_STREAM_CANCEL_RESUME_DRAFT")
		await expect(sidebar.getByText("E2E_STREAM_CANCEL_RESUME_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.getRequestCount("deepseek-chat")).toBe(2)
		expect(server.getMockConsumptions("deepseek-chat")[1].contractError).toBeUndefined()
		const thinkingButton = sidebar.getByRole("button", { name: "Thinking", exact: true }).last()
		await expect(thinkingButton).toBeVisible()
		await thinkingButton.click()
		await expect(partial).toHaveCount(1)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Turn-end interactions - consecutive QNA and report feedback submit with Enter",
	async ({ helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{ type: "tool", name: "qna_respond", arguments: { response: "E2E_QNA_FIRST" } },
			{ type: "tool", name: "qna_respond", arguments: { response: "E2E_QNA_SECOND" } },
			{
				type: "tool",
				name: "generate_report",
				arguments: { title: "E2E_REPORT_TITLE", content: "E2E_REPORT_CONTENT" },
			},
			{ type: "tool", name: "attempt_completion", arguments: { result: "E2E_TURN_END_INPUT_OK" } },
			{
				type: "error",
				status: 500,
				code: "unexpected_additional_request",
				message: "Unexpected request after turn-end input test",
			},
		)

		await sendTask(sidebar, "E2E_TURN_END_INPUT_TASK")
		await expect(sidebar.getByText("E2E_QNA_FIRST", { exact: true })).toBeVisible({ timeout: 60_000 })
		await expectNoConflictingDecisionButtons(sidebar)
		await closeCurrentTask(sidebar)
		await reopenTask(sidebar, "E2E_TURN_END_INPUT_TASK")
		await expect(sidebar.getByText("E2E_QNA_FIRST", { exact: true })).toBeVisible()
		await expectNoConflictingDecisionButtons(sidebar)
		await expect(sidebar.getByTestId("chat-input")).toBeEnabled()
		expect(server.openAiRequestCount).toBe(1)
		await submitWithEnter(sidebar, "E2E_QNA_FIRST_FEEDBACK")
		await expect(sidebar.getByText("E2E_QNA_SECOND", { exact: true })).toBeVisible({ timeout: 60_000 })
		await expectNoConflictingDecisionButtons(sidebar)
		await submitWithEnter(sidebar, "E2E_QNA_SECOND_FEEDBACK")
		await expect(sidebar.getByText("E2E_REPORT_TITLE", { exact: true })).toBeVisible({ timeout: 60_000 })
		await expect(sidebar.getByText("E2E_REPORT_CONTENT", { exact: true })).toBeVisible()
		await expectNoConflictingDecisionButtons(sidebar)
		await closeCurrentTask(sidebar)
		await reopenTask(sidebar, "E2E_TURN_END_INPUT_TASK")
		await expect(sidebar.getByText("E2E_REPORT_TITLE", { exact: true })).toBeVisible()
		await expect(sidebar.getByText("E2E_REPORT_CONTENT", { exact: true })).toBeVisible()
		await expectNoConflictingDecisionButtons(sidebar)
		await expect(sidebar.getByTestId("chat-input")).toBeEnabled()
		expect(server.openAiRequestCount).toBe(3)
		await submitWithEnter(sidebar, "E2E_REPORT_FEEDBACK")
		await expect(sidebar.getByText("E2E_TURN_END_INPUT_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		await expect(sidebar.getByRole("contentinfo").getByText("Start New Task", { exact: true })).toBeVisible()

		await expect.poll(() => server.openAiRequestCount).toBe(4)
		const requestBodies = server.getOpenAiRequestBodies().map((body) => JSON.stringify(body))
		expect(requestBodies[1]).toContain("E2E_QNA_FIRST_FEEDBACK")
		expect(requestBodies[2]).toContain("E2E_QNA_SECOND_FEEDBACK")
		expect(requestBodies[3]).toContain("E2E_REPORT_FEEDBACK")
		await page.waitForTimeout(500)
		expect(server.openAiRequestCount).toBe(4)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Follow-up options - History restore preserves selection and combines the current draft",
	async ({ helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_followup_history",
				name: "ask_followup_question",
				arguments: {
					question: "E2E_FOLLOWUP_HISTORY_QUESTION",
					options: ["E2E_FOLLOWUP_OPTION_A", "E2E_FOLLOWUP_OPTION_B"],
				},
			},
			{
				type: "tool",
				id: "call_followup_qna",
				name: "qna_respond",
				arguments: { response: "E2E_FOLLOWUP_SELECTION_ACCEPTED" },
				expectedToolResults: [
					{
						callId: "call_followup_history",
						contentIncludes: ["E2E_FOLLOWUP_OPTION_B", "E2E_FOLLOWUP_DRAFT_NOTE"],
					},
				],
			},
			{
				type: "tool",
				id: "call_followup_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_FOLLOWUP_HISTORY_OK" },
				expectedRequestIncludes: ["E2E_FOLLOWUP_QNA_FEEDBACK"],
			},
		)

		const taskText = "E2E_FOLLOWUP_HISTORY_TASK"
		await sendTask(sidebar, taskText)
		await expect(sidebar.getByText("E2E_FOLLOWUP_HISTORY_QUESTION", { exact: true })).toBeVisible({ timeout: 60_000 })
		await expect(sidebar.getByText("E2E_FOLLOWUP_OPTION_A", { exact: true })).toBeVisible()
		await expect(sidebar.getByText("E2E_FOLLOWUP_OPTION_B", { exact: true })).toBeVisible()
		await expectNoDecisionButtons(sidebar)

		await closeCurrentTask(sidebar)
		await reopenTask(sidebar, taskText)
		await expect(sidebar.getByText("E2E_FOLLOWUP_HISTORY_QUESTION", { exact: true })).toBeVisible()
		await expect(sidebar.getByText("E2E_FOLLOWUP_OPTION_A", { exact: true })).toBeVisible()
		const selectedOption = sidebar.getByRole("button", { name: "E2E_FOLLOWUP_OPTION_B", exact: true })
		await expect(selectedOption).toBeEnabled()
		await expectNoDecisionButtons(sidebar)
		await expect(sidebar.getByTestId("chat-input")).toBeEnabled()
		await page.waitForTimeout(500)
		expect(server.openAiRequestCount).toBe(1)

		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_FOLLOWUP_DRAFT_NOTE")
		await selectedOption.click()
		await expect(input).toHaveValue("")
		await expect(sidebar.getByText("E2E_FOLLOWUP_SELECTION_ACCEPTED", { exact: true })).toBeVisible({ timeout: 60_000 })
		await expectSingleUserFeedback(sidebar, "E2E_FOLLOWUP_OPTION_B: E2E_FOLLOWUP_DRAFT_NOTE")
		await expect(selectedOption).toHaveAttribute("aria-pressed", "true")
		await expect.poll(() => server.openAiRequestCount).toBe(2)

		await closeCurrentTask(sidebar)
		await reopenTask(sidebar, taskText)
		await expectSingleUserFeedback(sidebar, "E2E_FOLLOWUP_OPTION_B: E2E_FOLLOWUP_DRAFT_NOTE")
		await expect(selectedOption).toHaveAttribute("aria-pressed", "true")
		expect(server.openAiRequestCount).toBe(2)

		await submitWithEnter(sidebar, "E2E_FOLLOWUP_QNA_FEEDBACK")
		await expect(sidebar.getByText("E2E_FOLLOWUP_HISTORY_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		await expect.poll(() => server.openAiRequestCount).toBe(3)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Follow-up replies - option and free-text Enter render once and match tool results",
	async ({ helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_followup_option_only",
				name: "ask_followup_question",
				arguments: {
					question: "E2E_FOLLOWUP_OPTION_ONLY_QUESTION",
					options: ["E2E_FOLLOWUP_OPTION_ONLY_A", "E2E_FOLLOWUP_OPTION_ONLY_B"],
				},
			},
			{
				type: "tool",
				id: "call_followup_free_text",
				name: "ask_followup_question",
				arguments: {
					question: "E2E_FOLLOWUP_FREE_TEXT_QUESTION",
					options: ["E2E_FOLLOWUP_FREE_TEXT_A", "E2E_FOLLOWUP_FREE_TEXT_B"],
				},
				expectedToolResults: [
					{
						callId: "call_followup_option_only",
						contentIncludes: ["E2E_FOLLOWUP_OPTION_ONLY_B"],
					},
				],
			},
			{
				type: "tool",
				id: "call_followup_visible_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_FOLLOWUP_VISIBLE_FEEDBACK_OK" },
				expectedToolResults: [
					{
						callId: "call_followup_free_text",
						contentIncludes: ["E2E_FOLLOWUP_CUSTOM_FEEDBACK"],
					},
				],
			},
		)

		const taskText = "E2E_FOLLOWUP_VISIBLE_FEEDBACK_TASK"
		await sendTask(sidebar, taskText)
		await expect(sidebar.getByText("E2E_FOLLOWUP_OPTION_ONLY_QUESTION", { exact: true })).toBeVisible({ timeout: 60_000 })

		await sidebar.getByRole("button", { name: "E2E_FOLLOWUP_OPTION_ONLY_B", exact: true }).click()
		await expect(sidebar.getByText("E2E_FOLLOWUP_FREE_TEXT_QUESTION", { exact: true })).toBeVisible({ timeout: 60_000 })
		await expectSingleUserFeedback(sidebar, "E2E_FOLLOWUP_OPTION_ONLY_B")

		await submitWithEnter(sidebar, "E2E_FOLLOWUP_CUSTOM_FEEDBACK")
		await expect(sidebar.getByText("E2E_FOLLOWUP_VISIBLE_FEEDBACK_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expectSingleUserFeedback(sidebar, "E2E_FOLLOWUP_CUSTOM_FEEDBACK")
		await expect.poll(() => server.openAiRequestCount).toBe(3)

		await closeCurrentTask(sidebar)
		await reopenTask(sidebar, taskText)
		await expectSingleUserFeedback(sidebar, "E2E_FOLLOWUP_OPTION_ONLY_B")
		await expectSingleUserFeedback(sidebar, "E2E_FOLLOWUP_CUSTOM_FEEDBACK")
		expect(server.getMockConsumptions("openai-compatible-chat").every((entry) => entry.contractError === undefined)).toBe(
			true,
		)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Status acknowledgment - restored Acknowledge and Stop buttons render and carry the current draft",
	async ({ helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_status_acknowledge",
				name: "status_update",
				arguments: { response: "E2E_STATUS_ACKNOWLEDGE", requires_acknowledgment: true },
			},
			{
				type: "tool",
				id: "call_status_read",
				name: "read_file",
				arguments: { path: "README.md" },
				expectedToolResults: [
					{
						callId: "call_status_acknowledge",
						contentIncludes: ["User acknowledged", "E2E_STATUS_ACK_DRAFT"],
					},
				],
			},
			{
				type: "tool",
				id: "call_status_stop",
				name: "status_update",
				arguments: { response: "E2E_STATUS_STOP", requires_acknowledgment: true },
				expectedToolResults: [{ callId: "call_status_read", contentIncludes: "# Test Workspace" }],
			},
			{
				type: "tool",
				id: "call_status_qna",
				name: "qna_respond",
				arguments: { response: "E2E_STATUS_STOP_ACCEPTED" },
				expectedToolResults: [
					{
						callId: "call_status_stop",
						contentIncludes: ["User chose to stop", "E2E_STATUS_STOP_DRAFT"],
					},
				],
			},
			{
				type: "tool",
				id: "call_status_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_STATUS_ACKNOWLEDGMENT_OK" },
				expectedRequestIncludes: ["E2E_STATUS_QNA_FEEDBACK"],
			},
		)

		const taskText = "E2E_STATUS_ACKNOWLEDGMENT_TASK"
		await sendTask(sidebar, taskText)
		await expect(sidebar.getByText("E2E_STATUS_ACKNOWLEDGE", { exact: true })).toBeVisible({ timeout: 60_000 })
		await expect(sidebar.getByRole("contentinfo").getByText("Acknowledge", { exact: true })).toBeVisible()
		await expect(sidebar.getByRole("contentinfo").getByText("Stop", { exact: true })).toBeVisible()

		await closeCurrentTask(sidebar)
		await reopenTask(sidebar, taskText)
		const input = sidebar.getByTestId("chat-input")
		await expect(input).toBeEnabled()
		await expect(sidebar.getByRole("contentinfo").getByText("Acknowledge", { exact: true })).toBeVisible()
		await input.fill("E2E_STATUS_ACK_DRAFT")
		await sidebar.getByRole("contentinfo").getByText("Acknowledge", { exact: true }).click()
		await expect(input).toHaveValue("")
		await expect(sidebar.getByText("E2E_STATUS_STOP", { exact: true })).toBeVisible({ timeout: 60_000 })
		await expectSingleUserFeedback(sidebar, "E2E_STATUS_ACK_DRAFT")

		await input.fill("E2E_STATUS_STOP_DRAFT")
		await sidebar.getByRole("contentinfo").getByText("Stop", { exact: true }).click()
		await expect(input).toHaveValue("")
		await expect(sidebar.getByText("E2E_STATUS_STOP_ACCEPTED", { exact: true })).toBeVisible({ timeout: 60_000 })
		await expectSingleUserFeedback(sidebar, "E2E_STATUS_STOP_DRAFT")
		await submitWithEnter(sidebar, "E2E_STATUS_QNA_FEEDBACK")
		await expect(sidebar.getByText("E2E_STATUS_ACKNOWLEDGMENT_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		await expect.poll(() => server.openAiRequestCount).toBe(5)
		await page.waitForTimeout(500)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"OpenAI Responses - completed make_plan stops post-tool reasoning before handing control back",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await configureGpt56ResponsesProfile(dlineDir)
		server.resetOpenAiMock()

		const planText = "E2E_TURN_END_PLAN_READY"
		const forbiddenReasoning = "E2E_REASONING_AFTER_COMPLETED_MAKE_PLAN_MUST_NOT_STREAM"
		server.enqueueResponses("openai-compatible-responses", {
			type: "tool-with-completion-snapshots",
			id: "call_completed_make_plan",
			name: "make_plan",
			arguments: { response: planText, needs_more_exploration: false },
			reasoning: "E2E_REASONING_BEFORE_MAKE_PLAN",
			afterToolCompletionReasoning: forbiddenReasoning,
			afterToolCompletionDelayMs: 2_000,
			afterToolCompletionHoldMs: 30_000,
		})

		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await E2ETestHelper.dismissWhatsNewModal(sidebar)
			await helper.signin(sidebar)
			await selectProfile(sidebar, E2E_PROFILE_NAMES.mockOpenAiResponses)

			await sendTask(sidebar, "E2E_COMPLETED_MAKE_PLAN_STOPS_STREAM_TASK")
			await expect(sidebar.getByText(planText, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect
				.poll(() => server.getMockConsumptions("openai-compatible-responses")[0]?.abortedAtMs, { timeout: 10_000 })
				.not.toBeUndefined()
			await expect(sidebar.getByTestId("chat-input")).toBeEnabled({ timeout: 30_000 })
			await page.waitForTimeout(750)
			await expect(sidebar.getByText(forbiddenReasoning, { exact: false })).toHaveCount(0)
			const consumption = server.getMockConsumptions("openai-compatible-responses")[0]
			expect(consumption?.requestBody).toMatchObject({ model: "gpt-5.6-sol" })
			expect(consumption?.contractError).toBeUndefined()
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Task history - reopening an awaiting make_plan preserves stores without rewriting them",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await configureGpt56ResponsesProfile(dlineDir)
		server.resetOpenAiMock()

		const taskText = "E2E_MAKE_PLAN_READ_ONLY_REOPEN_TASK"
		const reasoningText = "E2E_MAKE_PLAN_PERSISTED_REASONING"
		const planText = "E2E_MAKE_PLAN_PERSISTED_RESPONSE"
		server.enqueueResponses("openai-compatible-responses", {
			type: "tool-with-completion-snapshots",
			id: "call_persisted_make_plan",
			name: "make_plan",
			arguments: { response: planText, needs_more_exploration: false },
			reasoning: reasoningText,
		})

		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await E2ETestHelper.dismissWhatsNewModal(sidebar)
			await helper.signin(sidebar)
			await selectProfile(sidebar, E2E_PROFILE_NAMES.mockOpenAiResponses)

			await sendTask(sidebar, taskText)
			await expect(sidebar.getByText(planText, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect(sidebar.getByTestId("chat-input")).toBeEnabled({ timeout: 30_000 })
			const taskId = await onlyTaskId(dlineDocsDir)
			const taskDir = path.join(dlineDocsDir, "tasks", taskId)
			const uiPath = path.join(taskDir, "ui_messages.jsonl")
			const apiPath = path.join(taskDir, "api_conversation_history.jsonl")
			await expect.poll(async () => (await readFile(apiPath, "utf8")).includes(planText), { timeout: 30_000 }).toBe(true)
			await closeCurrentTask(sidebar)

			const [uiBefore, apiBefore, uiStatBefore, apiStatBefore] = await Promise.all([
				readFile(uiPath, "utf8"),
				readFile(apiPath, "utf8"),
				stat(uiPath),
				stat(apiPath),
			])
			expect(uiBefore).toContain(reasoningText)
			expect(uiBefore).toContain(planText)
			expect(apiBefore).toContain(reasoningText)
			expect(apiBefore).toContain(planText)

			await page.waitForTimeout(25)
			await reopenTask(sidebar, taskText)
			await expect(sidebar.getByText(planText, { exact: false }).last()).toBeVisible({ timeout: 30_000 })
			await page.waitForTimeout(1_250)

			const [uiAfter, apiAfter, uiStatAfter, apiStatAfter] = await Promise.all([
				readFile(uiPath, "utf8"),
				readFile(apiPath, "utf8"),
				stat(uiPath),
				stat(apiPath),
			])
			expect(uiAfter).toBe(uiBefore)
			expect(apiAfter).toBe(apiBefore)
			expect(uiStatAfter.mtimeMs).toBe(uiStatBefore.mtimeMs)
			expect(apiStatAfter.mtimeMs).toBe(apiStatBefore.mtimeMs)

			await sidebar.getByRole("button", { name: "Thinking", exact: true }).last().click()
			await expect(sidebar.getByText(reasoningText, { exact: false }).last()).toBeVisible({ timeout: 30_000 })
			const consumption = server.getMockConsumptions("openai-compatible-responses")[0]
			expect(consumption?.requestBody).toMatchObject({ model: "gpt-5.6-sol" })
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Thinking restore - gpt-5.6-sol survives cancel, close, reopen, and explicit resume without losing reasoning",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		await configureGpt56ResponsesProfile(dlineDir)
		server.resetOpenAiMock()

		const firstReasoning = "E2E_GPT56_REASONING_BEFORE_CANCEL"
		const secondReasoning = "E2E_GPT56_REASONING_BEFORE_CLOSE"
		const intermediateDraft = "E2E_GPT56_CANCEL_RESUME_DRAFT"
		const finalDraft = "E2E_GPT56_HISTORY_RESUME_DRAFT"
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool-with-completion-snapshots",
				id: "call_gpt56_cancelled_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_GPT56_CANCELLED_RESPONSE_MUST_NOT_RENDER" },
				reasoning: firstReasoning,
				afterReasoningDelayMs: 30_000,
			},
			{
				type: "tool-with-completion-snapshots",
				id: "call_gpt56_closed_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_GPT56_CLOSED_RESPONSE_MUST_NOT_RENDER" },
				reasoning: secondReasoning,
				afterReasoningDelayMs: 30_000,
				expectedRequestIncludes: [intermediateDraft],
			},
			{
				type: "tool-with-completion-snapshots",
				id: "call_gpt56_restored_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_GPT56_HISTORY_RESUME_OK" },
				expectedRequestIncludes: ["The previous task session was closed and has now been restored.", finalDraft],
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await E2ETestHelper.dismissWhatsNewModal(sidebar)
			await helper.signin(sidebar)
			await selectProfile(sidebar, E2E_PROFILE_NAMES.mockOpenAiResponses)

			const taskText = "E2E_GPT56_CANCEL_CLOSE_HISTORY_TASK"
			await sendTask(sidebar, taskText)
			await expect(sidebar.getByText(firstReasoning, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(1)

			const taskFooter = sidebar.getByRole("contentinfo")
			const cancelButton = taskFooter.getByText("Cancel", { exact: true })
			await expect(cancelButton).toBeVisible({ timeout: 30_000 })
			await cancelButton.click()
			await expect
				.poll(() => server.getMockConsumptions("openai-compatible-responses")[0]?.abortedAtMs, { timeout: 30_000 })
				.not.toBeUndefined()

			const resumeAfterCancel = taskFooter.getByText("Resume", { exact: true })
			await expect(resumeAfterCancel).toBeVisible({ timeout: 30_000 })
			const input = sidebar.getByTestId("chat-input")
			await input.fill(intermediateDraft)
			await resumeAfterCancel.click()
			await expect(input).toHaveValue("")
			await expectSingleUserFeedback(sidebar, intermediateDraft)
			await expect(sidebar.getByText(secondReasoning, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(2)

			const taskId = await onlyTaskId(dlineDocsDir)
			const taskDir = path.join(dlineDocsDir, "tasks", taskId)
			const uiPath = path.join(taskDir, "ui_messages.jsonl")
			const apiPath = path.join(taskDir, "api_conversation_history.jsonl")
			await closeCurrentTask(sidebar)
			await expect
				.poll(() => server.getMockConsumptions("openai-compatible-responses")[1]?.abortedAtMs, { timeout: 30_000 })
				.not.toBeUndefined()
			await expect
				.poll(async () => (await readFile(apiPath, "utf8")).includes(secondReasoning), { timeout: 30_000 })
				.toBe(true)

			const [uiBefore, apiBefore, uiStatBefore, apiStatBefore] = await Promise.all([
				readFile(uiPath, "utf8"),
				readFile(apiPath, "utf8"),
				stat(uiPath),
				stat(apiPath),
			])
			expect(uiBefore).toContain(firstReasoning)
			expect(uiBefore).toContain(secondReasoning)
			expect(apiBefore).toContain(firstReasoning)
			expect(apiBefore).toContain(secondReasoning)
			expect(apiBefore.match(/Response interrupted by user/g)?.length).toBe(2)

			await reopenTask(sidebar, taskText)
			const resumeAfterClose = sidebar.getByRole("contentinfo").getByText("Resume", { exact: true })
			await expect(resumeAfterClose).toBeVisible({ timeout: 30_000 })
			await expect(sidebar.getByText("E2E_GPT56_CANCELLED_RESPONSE_MUST_NOT_RENDER", { exact: false })).toHaveCount(0)
			await expect(sidebar.getByText("E2E_GPT56_CLOSED_RESPONSE_MUST_NOT_RENDER", { exact: false })).toHaveCount(0)
			await page.waitForTimeout(1_250)

			const [uiAfter, apiAfter, uiStatAfter, apiStatAfter] = await Promise.all([
				readFile(uiPath, "utf8"),
				readFile(apiPath, "utf8"),
				stat(uiPath),
				stat(apiPath),
			])
			// Reopen may append the one durable resume interaction it presents, but
			// every byte from the pre-reopen timeline must remain an unchanged prefix.
			expect(uiAfter.startsWith(uiBefore)).toBe(true)
			const appendedUiMessages = uiAfter
				.slice(uiBefore.length)
				.split(/\r?\n/)
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>)
			expect(appendedUiMessages).toHaveLength(1)
			expect(appendedUiMessages[0]).toMatchObject({ type: "ask", ask: "resume_task", text: "" })
			expect(appendedUiMessages[0].interactionId).toEqual(expect.any(String))
			expect(uiStatAfter.size).toBeGreaterThan(uiStatBefore.size)
			expect(apiAfter).toBe(apiBefore)
			expect(apiStatAfter.mtimeMs).toBe(apiStatBefore.mtimeMs)

			const thinkingButtons = sidebar.getByRole("button", { name: "Thinking", exact: true })
			await expect(thinkingButtons).toHaveCount(2)
			await thinkingButtons.first().click()
			await expect(sidebar.getByText(firstReasoning, { exact: false }).last()).toBeVisible({ timeout: 30_000 })
			await thinkingButtons.last().click()
			await expect(sidebar.getByText(secondReasoning, { exact: false }).last()).toBeVisible({ timeout: 30_000 })

			await input.fill(finalDraft)
			await resumeAfterClose.click()
			await expect(input).toHaveValue("")
			await expectSingleUserFeedback(sidebar, finalDraft)
			await expect(sidebar.getByText("E2E_GPT56_HISTORY_RESUME_OK", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(3)
			const consumptions = server.getMockConsumptions("openai-compatible-responses")
			expect(consumptions).toHaveLength(3)
			for (const consumption of consumptions) {
				expect(consumption.requestBody).toMatchObject({ model: "gpt-5.6-sol" })
				expect(consumption.contractError).toBeUndefined()
			}
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

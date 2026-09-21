import { writeFile } from "node:fs/promises"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type TestInfo } from "@playwright/test"

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled()
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

async function attachDiagnostic(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
	const diagnosticPath = testInfo.outputPath(`${name}.json`)
	await writeFile(diagnosticPath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
	await testInfo.attach(name, { path: diagnosticPath, contentType: "application/json" })
}

e2e("Close Task click and detach", async ({ helper, server, sidebar, userDataDir }, testInfo) => {
	e2e.setTimeout(150_000)
	await helper.signin(sidebar)
	server.resetOpenAiMock()
	server.enqueueOpenAiResponses(
		{ type: "tool", name: "qna_respond", arguments: { response: "E2E_CLOSE_WAITING_FOR_FEEDBACK" } },
		{ type: "message", text: "E2E_CLOSE_STREAM_MUST_STOP", afterChatContentDelayMs: 20_000 },
	)

	const observations: Array<Record<string, unknown>> = []
	for (const [index, taskText] of ["E2E_CLOSE_WAITING_TASK", "E2E_CLOSE_STREAMING_TASK"].entries()) {
		await sendTask(sidebar, taskText)
		if (index === 0) {
			await expect(sidebar.getByText("E2E_CLOSE_WAITING_FOR_FEEDBACK", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
		} else {
			await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(2)
		}
		const closeButton = sidebar.getByRole("button", { name: "Close Task", exact: true })
		await expect(closeButton).toBeVisible()
		await expect(closeButton).toBeEnabled()
		await sidebar.evaluate(() => {
			const scope = window as typeof window & { __dlineCloseClicks?: string[]; __dlineCloseEventsInstalled?: boolean }
			scope.__dlineCloseClicks = []
			if (scope.__dlineCloseEventsInstalled) return
			scope.__dlineCloseEventsInstalled = true
			for (const eventName of ["pointerdown", "pointerup", "click"]) {
				document.addEventListener(
					eventName,
					(event) => {
						if ((event.target as Element).closest('[aria-label="Close Task"]'))
							scope.__dlineCloseClicks?.push(eventName)
					},
					{ capture: true },
				)
			}
		})
		const startedAt = Date.now()
		await closeButton.click()
		let closed = false
		try {
			await expect(closeButton).toHaveCount(0, { timeout: 8_000 })
			await expect(sidebar.getByTestId("chat-input")).toHaveAttribute("placeholder", "Type your task here...")
			closed = true
		} finally {
			observations.push({
				taskText,
				closed,
				elapsedMs: Date.now() - startedAt,
				clickEvents: await sidebar.evaluate(
					() => (window as typeof window & { __dlineCloseClicks?: string[] }).__dlineCloseClicks ?? [],
				),
				closeButtonCount: await closeButton.count(),
				mockConsumptions: server.getMockConsumptions().map(({ responseType, abortedAtMs, contractError }) => ({
					responseType,
					aborted: abortedAtMs !== undefined,
					contractError,
				})),
			})
			await attachDiagnostic(testInfo, "close-task-observations", {
				observations,
				closeStages: (await E2ETestHelper.readDlineOutput(userDataDir))
					.split(/\r?\n/)
					.filter((line) => line.includes("ControllerClosePerf")),
			})
		}
		expect(observations.at(-1)?.clickEvents).toContain("click")
	}
	await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/Dline instance aborted/i])
})

e2e("Turn-end feedback and next interaction", async ({ helper, server, sidebar, userDataDir }, testInfo) => {
	e2e.setTimeout(150_000)
	await helper.signin(sidebar)
	server.resetOpenAiMock()
	server.enqueueOpenAiResponses(
		{ type: "tool", name: "qna_respond", arguments: { response: "E2E_TURN_END_FIRST" } },
		{
			type: "tool",
			name: "qna_respond",
			arguments: { response: "E2E_TURN_END_SECOND" },
			delayMs: 1_500,
			expectedRequestIncludes: ["E2E_TURN_END_FEEDBACK"],
		},
		{
			type: "tool",
			name: "attempt_completion",
			arguments: { result: "E2E_TURN_END_DONE" },
			expectedRequestIncludes: ["E2E_TURN_END_SECOND_FEEDBACK"],
		},
		{
			type: "error",
			status: 500,
			code: "unexpected_additional_request",
			message: "Turn-end draft was submitted more than once",
		},
	)

	await sendTask(sidebar, "E2E_TURN_END_DIAGNOSTIC_TASK")
	await expect(sidebar.getByText("E2E_TURN_END_FIRST", { exact: true })).toBeVisible({ timeout: 60_000 })
	const feedback = "E2E_TURN_END_FEEDBACK"
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled()
	await input.fill(feedback)
	await sidebar.evaluate((marker) => {
		const scope = window as typeof window & { __dlineTurnEndProbe?: { timeline: unknown[]; timer: number } }
		const timeline: unknown[] = []
		const sample = () => {
			const composer = document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')
			const echoes = Array.from(
				document.querySelectorAll('[data-testid="direct-user-input"], [data-testid="queued-user-input"]'),
			).filter((element) => element.textContent?.includes(marker)).length
			const secondAskVisible = document.body.textContent?.includes("E2E_TURN_END_SECOND") ?? false
			const next = {
				atMs: Date.now(),
				text: composer?.value ?? null,
				echoes,
				secondAskVisible,
				sendDisabled: document.querySelector('[data-testid="send-button"]')?.getAttribute("disabled") !== null,
			}
			const previous = timeline.at(-1) as typeof next | undefined
			if (
				!previous ||
				previous.text !== next.text ||
				previous.echoes !== next.echoes ||
				previous.secondAskVisible !== next.secondAskVisible ||
				previous.sendDisabled !== next.sendDisabled
			)
				timeline.push(next)
		}
		sample()
		scope.__dlineTurnEndProbe = { timeline, timer: window.setInterval(sample, 16) }
	}, feedback)

	await input.press("Enter")
	await expect(sidebar.getByText("E2E_TURN_END_SECOND", { exact: true })).toBeVisible({ timeout: 60_000 })
	await expect(sidebar.getByTestId(/^(?:user|queued)-input-markdown-scroll$/).filter({ hasText: feedback })).toHaveCount(1)
	const timeline = await sidebar.evaluate(() => {
		const scope = window as typeof window & { __dlineTurnEndProbe?: { timeline: unknown[]; timer: number } }
		if (!scope.__dlineTurnEndProbe) throw new Error("Turn-end probe was not installed")
		window.clearInterval(scope.__dlineTurnEndProbe.timer)
		return scope.__dlineTurnEndProbe.timeline as Array<{
			atMs: number
			text: string | null
			echoes: number
			secondAskVisible: boolean
			sendDisabled: boolean
		}>
	})
	const consumptions = server
		.getMockConsumptions()
		.map(({ responseType, toolName, contractError }) => ({ responseType, toolName, contractError }))
	await attachDiagnostic(testInfo, "turn-end-input-observations", { timeline, consumptions })
	expect(timeline.some(({ echoes, text }) => echoes > 0 && text?.includes(feedback))).toBe(false)
	expect(consumptions.every(({ contractError }) => contractError === undefined)).toBe(true)
	await expect(input).toHaveValue("")
	await input.fill("E2E_TURN_END_SECOND_FEEDBACK")
	await input.press("Enter")
	await expect(sidebar.getByText("E2E_TURN_END_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
	await expect.poll(() => server.openAiRequestCount).toBe(3)
	await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
})

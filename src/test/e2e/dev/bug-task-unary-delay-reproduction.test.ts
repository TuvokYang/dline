import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

function delayUnary(method: "clearTask" | "dispatchInteraction", action: "delay" | "delayRequest", delayMs: number) {
	return JSON.stringify({ action, service: "dline.TaskService", method, occurrence: 1, delayMs, markerName: `unary-${method}` })
}

async function marker(dlineDir: string, method: string): Promise<string> {
	return readFile(path.join(dlineDir, "e2e-markers", `unary-${method}`), "utf8").catch(() => "missing")
}

e2e.describe("A delayed Close Task request", () => {
	e2e.use({ grpcUnaryFaults: delayUnary("clearTask", "delayRequest", 6_000) })

	e2e("Close Task during delayed RPC", async ({ dlineDir, helper, server, sidebar, userDataDir }, testInfo) => {
		e2e.setTimeout(90_000)
		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses({ type: "tool", name: "qna_respond", arguments: { response: "E2E_DELAYED_CLOSE_ASK" } })
		await sendTask(sidebar, "E2E_DELAYED_CLOSE_TASK")
		await expect(sidebar.getByText("E2E_DELAYED_CLOSE_ASK", { exact: true })).toBeVisible({ timeout: 60_000 })
		const button = sidebar.getByRole("button", { name: "Close Task", exact: true })
		await button.click()
		await expect.poll(() => marker(dlineDir, "clearTask")).toBe("started")
		const whileDelayed = {
			buttonVisible: await button.isVisible(),
			buttonEnabled: await button.isEnabled(),
			buttonBusy: await button.getAttribute("aria-busy"),
			taskStillVisible: await sidebar.getByText("E2E_DELAYED_CLOSE_TASK", { exact: true }).first().isVisible(),
			closeStages: (await E2ETestHelper.readDlineOutput(userDataDir))
				.split(/\r?\n/)
				.filter((line) => line.includes("ControllerClosePerf") && line.includes("panel_state_clear")),
		}
		const diagnosticPath = testInfo.outputPath("delayed-close-task.json")
		await writeFile(diagnosticPath, `${JSON.stringify(whileDelayed, null, 2)}\n`, "utf8")
		await testInfo.attach("delayed-close-task", { path: diagnosticPath, contentType: "application/json" })
		expect(whileDelayed).toMatchObject({
			buttonVisible: true,
			buttonEnabled: false,
			buttonBusy: "true",
			taskStillVisible: true,
		})
		await expect.poll(() => marker(dlineDir, "clearTask"), { timeout: 10_000 }).toBe("released")
		await expect(button).toHaveCount(0, { timeout: 10_000 })
	})
})

e2e.describe("An accepted turn-end with a delayed unary response", () => {
	e2e.use({ grpcUnaryFaults: delayUnary("dispatchInteraction", "delay", 32_000) })

	e2e("Accepted feedback stays clear after Resume", async ({ dlineDir, helper, server, sidebar, userDataDir }, testInfo) => {
		e2e.setTimeout(120_000)
		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{ type: "tool", name: "qna_respond", arguments: { response: "E2E_DELAYED_TURN_END_ASK" } },
			{
				type: "tool",
				name: "attempt_completion",
				arguments: { result: "E2E_DELAYED_TURN_END_ACCEPTED" },
				expectedRequestIncludes: ["E2E_DELAYED_TURN_END_FEEDBACK"],
			},
		)
		await sendTask(sidebar, "E2E_DELAYED_TURN_END_TASK")
		await expect(sidebar.getByText("E2E_DELAYED_TURN_END_ASK", { exact: true })).toBeVisible({ timeout: 60_000 })
		const input = sidebar.getByTestId("chat-input")
		const feedback = "E2E_DELAYED_TURN_END_FEEDBACK"
		await input.fill(feedback)
		await input.press("Enter")
		await expect.poll(() => marker(dlineDir, "dispatchInteraction")).toBe("started")
		await expect(sidebar.getByText("E2E_DELAYED_TURN_END_ACCEPTED", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect(sidebar.getByTestId(/^(?:user|queued)-input-markdown-scroll$/).filter({ hasText: feedback })).toHaveCount(1)
		await expect.poll(() => server.openAiRequestCount).toBe(2)
		await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
		await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toHaveCount(0)
		const historicalTask = sidebar.getByText("E2E_DELAYED_TURN_END_TASK", { exact: true }).last()
		await expect(historicalTask).toBeVisible({ timeout: 10_000 })
		await historicalTask.click()
		await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 10_000 })
		await expect(input).toHaveValue("", { timeout: 10_000 })
		// The injected response is released after the 30-second Webview unary timeout.
		// This marker fences the old RPC settlement without a speculative wait.
		await expect.poll(() => marker(dlineDir, "dispatchInteraction"), { timeout: 45_000 }).toBe("released")
		await expect(input).toHaveValue("")
		const diagnostic = {
			backendAcceptedBeforeCloseAndResume: true,
			feedbackEchoCount: await sidebar
				.getByTestId(/^(?:user|queued)-input-markdown-scroll$/)
				.filter({ hasText: feedback })
				.count(),
			composerValue: await input.inputValue(),
			unaryFault: await marker(dlineDir, "dispatchInteraction"),
			requests: server
				.getMockConsumptions()
				.map(({ responseType, toolName, contractError }) => ({ responseType, toolName, contractError })),
			unexpectedErrors: (await E2ETestHelper.readDlineOutput(userDataDir))
				.split(/\r?\n/)
				.filter((line) => line.includes("Unary RPC") || line.includes("Protobus error")),
		}
		const diagnosticPath = testInfo.outputPath("accepted-turn-end-after-resume.json")
		await writeFile(diagnosticPath, `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8")
		await testInfo.attach("accepted-turn-end-after-resume", { path: diagnosticPath, contentType: "application/json" })
		expect(diagnostic).toMatchObject({
			backendAcceptedBeforeCloseAndResume: true,
			feedbackEchoCount: 1,
			composerValue: "",
		})
	})
})

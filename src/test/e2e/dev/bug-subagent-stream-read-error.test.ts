import { mkdir, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

async function writeResponsesSubagent(workspaceDir: string, agentName: string): Promise<void> {
	const directory = path.join(workspaceDir, ".agents", "subagents")
	await mkdir(directory, { recursive: true })
	await writeFile(
		path.join(directory, `${agentName}.yml`),
		`---
name: ${agentName}
description: Reproduces an upstream Responses stream_read_error before observable output.
tools:
  - attempt_completion
profile: ${E2E_PROFILE_NAMES.mockOpenAiResponses}
---

Return the requested marker through attempt_completion.`,
		"utf8",
	)
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled()
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

async function startReboundObserver(sidebar: Frame, marker: string): Promise<void> {
	await sidebar.evaluate((submittedText) => {
		const scope = window as typeof window & {
			__dlineStreamErrorReboundSeen?: boolean
			__dlineStreamErrorReboundObserver?: MutationObserver
		}
		scope.__dlineStreamErrorReboundObserver?.disconnect()
		scope.__dlineStreamErrorReboundSeen = false
		const check = () => {
			const input = document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')
			const echoed = Array.from(
				document.querySelectorAll('[data-testid="direct-user-input"], [data-testid="queued-user-input"]'),
			).some((element) => element.textContent?.includes(submittedText))
			if (echoed && input?.value.includes(submittedText)) {
				scope.__dlineStreamErrorReboundSeen = true
			}
		}
		const observer = new MutationObserver(check)
		observer.observe(document.body, { childList: true, characterData: true, subtree: true })
		scope.__dlineStreamErrorReboundObserver = observer
		check()
	}, marker)
}

async function stopReboundObserver(sidebar: Frame): Promise<{ inputValue: string; rebound: boolean }> {
	return sidebar.evaluate(() => {
		const scope = window as typeof window & {
			__dlineStreamErrorReboundSeen?: boolean
			__dlineStreamErrorReboundObserver?: MutationObserver
		}
		scope.__dlineStreamErrorReboundObserver?.disconnect()
		const result = {
			inputValue: document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')?.value ?? "",
			rebound: scope.__dlineStreamErrorReboundSeen === true,
		}
		delete scope.__dlineStreamErrorReboundObserver
		delete scope.__dlineStreamErrorReboundSeen
		return result
	})
}

async function approveAndPressEnterWithoutYielding(sidebar: Frame): Promise<void> {
	await sidebar.evaluate(() => {
		const input = document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')
		const approve = Array.from(document.querySelectorAll<HTMLElement>('[role="button"]')).find(
			(element) => element.textContent?.trim() === "Approve",
		)
		if (!input) throw new Error("chat input not found")
		if (!approve) throw new Error("Approve button not found")
		input.focus()
		approve.click()
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }))
	})
}

e2e(
	"Subagent stream_read_error diagnostic retries the real SSE failure instead of exiting",
	async ({ helper, server, sidebar, userDataDir, workspaceDir }, testInfo) => {
		e2e.setTimeout(120_000)
		const agentName = "e2e-stream-read-error-diagnostic"
		const childTask = "E2E_STREAM_READ_ERROR_DIAGNOSTIC_CHILD"
		const childResult = "E2E_STREAM_READ_ERROR_DIAGNOSTIC_RECOVERED"
		const parentResult = "E2E_STREAM_READ_ERROR_DIAGNOSTIC_PARENT_DONE"
		const approvalFeedback = "E2E_STREAM_READ_ERROR_APPROVAL_FEEDBACK"
		const approvalFilePath = path.join(workspaceDir, "stream-error-approval.txt")
		await writeResponsesSubagent(workspaceDir, agentName)

		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_stream_read_error_approval_boundary",
				name: "write_to_file",
				arguments: {
					absolutePath: approvalFilePath,
					content: "approval boundary reached\n",
				},
			},
			{
				type: "tool",
				id: "call_stream_read_error_diagnostic_subagent",
				name: "use_subagent",
				arguments: {
					agent_name: agentName,
					task: childTask,
					context: "Recover from the upstream stream_read_error and return the diagnostic marker.",
					timeout: 90,
				},
			},
			{
				type: "tool",
				id: "call_stream_read_error_diagnostic_parent_complete",
				name: "attempt_completion",
				arguments: { result: parentResult },
				expectedToolResults: [
					{
						callId: "call_stream_read_error_diagnostic_subagent",
						contentIncludes: childResult,
					},
				],
			},
		)
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "responses-stream-error",
				status: 502,
				code: "stream_read_error",
				message: "stream_read_error",
				failureCode: "upstream_error",
				failureMessage: "Upstream request failed",
				requestId: "req_e2e_stream_read_error_diagnostic",
			},
			{
				type: "tool",
				id: "call_stream_read_error_diagnostic_child_complete",
				name: "attempt_completion",
				arguments: { result: childResult },
			},
		)

		await sendTask(sidebar, "Reproduce the subagent stream_read_error lifecycle.")
		const approveButton = sidebar.getByText("Approve", { exact: true })
		const childHeading = sidebar.getByRole("heading", { name: childTask, exact: true }).last()
		await expect(approveButton).toBeVisible({ timeout: 60_000 })
		const input = sidebar.getByTestId("chat-input")
		await input.fill(approvalFeedback)
		await startReboundObserver(sidebar, approvalFeedback)
		await approveAndPressEnterWithoutYielding(sidebar)

		await expect(sidebar.getByText(parentResult, { exact: false }).last()).toBeVisible({ timeout: 90_000 })
		await expect(
			sidebar.getByTestId(/^(?:user|queued)-input-markdown-scroll$/).filter({ hasText: approvalFeedback }),
		).toHaveCount(1)
		const draftState = await stopReboundObserver(sidebar)
		expect(draftState.rebound).toBe(false)
		expect(draftState.inputValue).toBe("")
		await expect(childHeading).toBeVisible()
		const subagentCard = childHeading.locator("xpath=ancestor::*[@data-testid='subagent-item'][1]")
		await expect(subagentCard.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0)
		await expect(subagentCard.getByRole("button", { name: "Finish", exact: true })).toHaveCount(0)

		const showOutput = subagentCard.getByRole("button", { name: "Show subagent output", exact: true })
		await expect(showOutput).toBeVisible()
		await showOutput.click()
		const output = subagentCard.getByTestId("subagent-output-scroll")
		await expect(output.getByTestId("subagent-retry-attempt")).toHaveCount(1)
		await expect(output).toContainText("total 5s")
		await expect(output).toContainText(childResult)

		const childConsumptions = server.getMockConsumptions("openai-compatible-responses")
		expect(childConsumptions).toHaveLength(2)
		expect(childConsumptions[0]).toMatchObject({
			responseType: "responses-stream-error",
			status: 502,
		})
		expect(childConsumptions[0].contractError).toBeUndefined()
		expect(childConsumptions[1]).toMatchObject({
			responseType: "tool",
			toolName: "attempt_completion",
		})
		expect(childConsumptions[1].contractError).toBeUndefined()

		const diagnostic = {
			childRequestCount: childConsumptions.length,
			responseTypes: childConsumptions.map(({ responseType }) => responseType),
			statuses: childConsumptions.map(({ status }) => status ?? null),
			retryRows: await output.getByTestId("subagent-retry-attempt").count(),
			completedResultVisible: await output.getByText(childResult, { exact: false }).isVisible(),
		}
		const reportPath = testInfo.outputPath("subagent-stream-read-error-diagnostic.json")
		await writeFile(reportPath, `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8")
		await testInfo.attach("subagent-stream-read-error-diagnostic", {
			path: reportPath,
			contentType: "application/json",
		})
		await subagentCard.screenshot({ path: testInfo.outputPath("subagent-stream-read-error-card.png") })
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/stream_read_error/, /upstream_error/])
	},
)

e2e(
	"Subagent stream_read_error diagnostic exits the attempt after observable output and exposes Retry",
	async ({ helper, server, sidebar, userDataDir, workspaceDir }, testInfo) => {
		e2e.setTimeout(120_000)
		const agentName = "e2e-stream-read-error-visible-output"
		const childTask = "E2E_STREAM_READ_ERROR_VISIBLE_OUTPUT_CHILD"
		const partialResult = "E2E_STREAM_READ_ERROR_PARTIAL_OUTPUT"
		const recoveredResult = "E2E_STREAM_READ_ERROR_MANUAL_RETRY_RECOVERED"
		await writeResponsesSubagent(workspaceDir, agentName)

		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_visible_output_stream_error_subagent",
				name: "use_subagent",
				arguments: {
					agent_name: agentName,
					task: childTask,
					context: "Expose the partial stream, then wait for a manual Retry.",
					timeout: 90,
				},
			},
			{
				type: "tool",
				id: "call_visible_output_stream_error_ready",
				name: "qna_respond",
				arguments: { response: "E2E_STREAM_READ_ERROR_DIRECT_EXIT_OBSERVED" },
				expectedToolResults: [
					{
						callId: "call_visible_output_stream_error_subagent",
						contentIncludes: "stopped without producing a result",
					},
				],
				expectedRequestIncludes: ["Retry control"],
			},
		)
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "responses-stream-error",
				status: 502,
				code: "stream_read_error",
				message: "stream_read_error",
				failureCode: "upstream_error",
				failureMessage: "Upstream request failed after partial output",
				prefixText: partialResult,
				requestId: "req_e2e_visible_output_stream_read_error",
			},
			{
				type: "tool",
				id: "call_visible_output_stream_error_child_complete",
				name: "attempt_completion",
				arguments: { result: recoveredResult },
			},
		)

		await sendTask(sidebar, "Reproduce stream_read_error after visible subagent output.")
		const approveButton = sidebar.getByText("Approve", { exact: true })
		const childHeading = sidebar.getByRole("heading", { name: childTask, exact: true }).last()
		await expect(approveButton.or(childHeading)).toBeVisible({ timeout: 60_000 })
		if (await approveButton.isVisible()) await approveButton.click()
		await expect(sidebar.getByText("E2E_STREAM_READ_ERROR_DIRECT_EXIT_OBSERVED", { exact: true })).toBeVisible({
			timeout: 60_000,
		})

		const subagentCard = childHeading.locator("xpath=ancestor::*[@data-testid='subagent-item'][1]")
		await expect(childHeading).toBeVisible()
		const retryButton = subagentCard.getByRole("button", { name: "Retry", exact: true })
		await expect(retryButton).toBeVisible()
		const showOutput = subagentCard.getByRole("button", { name: "Show subagent output", exact: true })
		await expect(showOutput).toBeVisible()
		await showOutput.click()
		const output = subagentCard.getByTestId("subagent-output-scroll")
		await expect(output).toContainText("stream_read_error")
		await expect(output.getByTestId("subagent-retry-attempt")).toHaveCount(0)
		expect(server.getMockConsumptions("openai-compatible-responses")).toHaveLength(1)
		await subagentCard.screenshot({ path: testInfo.outputPath("subagent-stream-read-error-direct-exit.png") })

		await retryButton.click()
		await expect(output).toContainText(recoveredResult, { timeout: 60_000 })
		await expect(subagentCard.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0)
		const childConsumptions = server.getMockConsumptions("openai-compatible-responses")
		expect(childConsumptions).toHaveLength(2)
		expect(childConsumptions.map(({ responseType }) => responseType)).toEqual(["responses-stream-error", "tool"])
		expect(childConsumptions.every(({ contractError }) => contractError === undefined)).toBe(true)

		const reportPath = testInfo.outputPath("subagent-stream-read-error-direct-exit.json")
		await writeFile(
			reportPath,
			`${JSON.stringify(
				{
					automaticRetryRowsBeforeManualRetry: 0,
					childRequestCountBeforeManualRetry: 1,
					childRequestCountAfterManualRetry: childConsumptions.length,
					responseTypes: childConsumptions.map(({ responseType }) => responseType),
				},
				null,
				2,
			)}\n`,
			"utf8",
		)
		await testInfo.attach("subagent-stream-read-error-direct-exit", {
			path: reportPath,
			contentType: "application/json",
		})
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/stream_read_error/, /upstream_error/])
	},
)

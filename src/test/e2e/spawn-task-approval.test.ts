import { expect, type Frame } from "@playwright/test"
import { E2ETestHelper, e2e } from "./utils/helpers"

/**
 * Regression coverage for the spawn_task approval interaction.
 *
 * Symptom: after the user approves the spawn_task request, the task footer
 * stays stuck showing only the task-level Cancel action and the conversation
 * can no longer continue (no second interaction, no tool result, no new API
 * request). This file reproduces the full approval chain through a real VS
 * Code window with the mock API:
 *
 *   1. model emits spawn_task tool call
 *   2. handler opens the spawn_task_approval interaction -> Approve
 *   3. child starts independently with its own matched mock response
 *   4. parent must keep running and reach the queued attempt_completion
 */

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

/**
 * Approve the single spawn interaction.
 *
 * The accepted interaction can disappear between pointer down and Playwright's
 * post-click stability check. Treat that detach as success only when the exact
 * approval has causally closed; otherwise preserve the original click failure.
 */
async function approveSpawnTask(sidebar: Frame): Promise<void> {
	const approve = sidebar.getByRole("contentinfo").getByText("Approve", { exact: true }).first()
	await expect(approve).toBeVisible({ timeout: 60_000 })
	try {
		await approve.click({ timeout: 5_000 })
	} catch (error) {
		const closed = await expect(approve)
			.toHaveCount(0, { timeout: 20_000 })
			.then(() => true)
			.catch(() => false)
		if (!closed) throw error
	}
}

e2e("Spawn task - approval chain closes and the conversation continues", async ({ helper, server, sidebar, userDataDir }) => {
	e2e.setTimeout(240_000)
	await helper.signin(sidebar)
	server.resetOpenAiMock()
	const parentTask = "Spawn a sub-task for the E2E workspace, then finish."
	const childTask = "E2E spawned sub-task"
	const parentCompletion = "E2E_SPAWN_TASK_CONTINUED"
	server.enqueueOpenAiResponses(
		{
			type: "tool",
			id: "call_spawn_task",
			name: "spawn_task",
			arguments: { task: childTask, mode: "plan", context: "E2E spawn context" },
			expectedRequestIncludes: [parentTask],
			expectedToolResultCount: 0,
			matchRequestContract: true,
		},
		{
			type: "tool",
			id: "call_spawn_task_completion",
			name: "attempt_completion",
			arguments: { result: parentCompletion },
			expectedRequestIncludes: [parentTask],
			expectedToolResults: [{ callId: "call_spawn_task", contentIncludes: "Spawned new PLAN task" }],
			matchRequestContract: true,
		},
		{
			type: "tool",
			id: "call_spawned_child_plan",
			name: "make_plan",
			arguments: { response: "E2E_SPAWNED_CHILD_READY", needs_more_exploration: false },
			expectedRequestIncludes: [childTask, "E2E spawn context"],
			expectedToolResultCount: 0,
			matchRequestContract: true,
		},
	)

	await sendTask(sidebar, parentTask)
	await approveSpawnTask(sidebar)

	// The parent conversation must continue while the child runs independently.
	await expect(sidebar.getByText(parentCompletion, { exact: false }).last()).toBeVisible({
		timeout: 60_000,
	})
	await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(3)
	const consumptions = server.getMockConsumptions("openai-compatible-chat")
	expect(consumptions).toHaveLength(3)
	expect(consumptions.every((consumption) => consumption.contractError === undefined)).toBe(true)

	// No approval or task-level cancel-only footer may remain.
	await expect(sidebar.getByText("Approve", { exact: true })).toHaveCount(0)
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled()
	await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
})

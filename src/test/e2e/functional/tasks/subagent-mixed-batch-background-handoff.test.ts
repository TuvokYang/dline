import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

async function setAutoApproveAction(sidebar: Frame, label: string, enabled: boolean): Promise<void> {
    await sidebar.getByLabel("Open auto-approve settings").click()
    const checkbox = sidebar.locator("vscode-checkbox").filter({ hasText: label })
    await expect(checkbox).toHaveCount(1)
    const isChecked = () => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
    if ((await isChecked()) !== enabled) await sidebar.getByText(label, { exact: true }).click()
    await expect.poll(isChecked).toBe(enabled)
    await sidebar.getByLabel("Close auto-approve settings").click()
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
    const input = sidebar.getByTestId("chat-input")
    await expect(input).toBeEnabled({ timeout: 30_000 })
    await input.fill(text)
    await sidebar.getByTestId("send-button").click()
}

e2e(
    "Mixed foreground subagent batch returns settled results and hands live siblings to the background",
    async ({ helper, server, sidebar, userDataDir }) => {
        e2e.setTimeout(180_000)
        const settledTask = "E2E_MIXED_BATCH_SETTLED_TASK"
        const runningTask = "E2E_MIXED_BATCH_RUNNING_TASK"
        const settledResult = "E2E_MIXED_BATCH_SETTLED_RESULT"
        const backgroundResult = "E2E_MIXED_BATCH_BACKGROUND_RESULT"
        const question = "E2E_MIXED_BATCH_HANDOFF_READY"
        const option = "E2E_MIXED_BATCH_CHECK_BACKGROUND_RESULT"
        const completion = "E2E_MIXED_BATCH_HANDOFF_OK"

        await helper.signin(sidebar)
        await setAutoApproveAction(sidebar, "Read project files", false)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "call_mixed_batch_handoff",
                name: "use_subagents",
                arguments: {
                    subagents: [
                        { agent_name: "default", task: settledTask, context: "Complete immediately." },
                        { agent_name: "default", task: runningTask, context: "Keep running until handed off." },
                    ],
                    timeout: 60,
                },
            },
            {
                type: "tool",
                id: "call_mixed_batch_settled_child",
                name: "attempt_completion",
                arguments: { result: settledResult },
            },
            {
                type: "tool",
                id: "call_mixed_batch_background_child",
                name: "attempt_completion",
                arguments: { result: backgroundResult },
                delayMs: 20_000,
            },
            {
                type: "tool",
                id: "call_mixed_batch_parent_wait",
                name: "ask_followup_question",
                arguments: { question, options: [option] },
                expectedToolResults: [
                    {
                        callId: "call_mixed_batch_handoff",
                        contentIncludes: [
                            `[1] COMPLETED - ${settledTask}`,
                            settledResult,
                            "Continued background subagent batch job:",
                            "final result will be available only in a later model request",
                        ],
                    },
                ],
            },
            {
                type: "tool",
                id: "call_mixed_batch_parent_complete",
                name: "attempt_completion",
                arguments: { result: completion },
                expectedRequestIncludes: [option, backgroundResult],
            },
        )

        await sendTask(sidebar, "Start the mixed foreground subagent batch and wait for the handoff.")
        const approveButton = sidebar.getByText("Approve", { exact: true })
        await expect(approveButton).toBeVisible({ timeout: 60_000 })
        await approveButton.click()

        const settledTaskRow = sidebar.getByText(settledTask, { exact: true }).last()
        const runningTaskRow = sidebar.getByText(runningTask, { exact: true }).last()
        await expect(settledTaskRow).toBeVisible({ timeout: 60_000 })
        await expect(runningTaskRow).toBeVisible()
        await expect(sidebar.getByText(settledResult, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
        await expect.poll(() => server.openAiRequestCount).toBe(3)

        const runningCard = runningTaskRow.locator("xpath=ancestor::*[@data-testid='subagent-item'][1]")
        const runningHeader = runningCard.getByTestId("subagent-item-header")
        await expect(runningHeader.getByTestId("subagent-execution-mode")).toHaveText("Foreground")
        const handoffButton = sidebar.getByRole("contentinfo").locator('vscode-button[aria-label="Continue in Background"]')
        await expect(handoffButton).toBeVisible()
        await expect(handoffButton).toBeEnabled()
        await handoffButton.click()

        await expect(sidebar.getByText(question, { exact: true })).toBeVisible({ timeout: 60_000 })
        await expect(runningHeader.getByTestId("subagent-execution-mode")).toHaveText("Background")
        await expect(sidebar.getByText(backgroundResult, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
        const optionButton = sidebar.getByRole("button", { name: option, exact: true })
        await expect(optionButton).toBeEnabled()
        await optionButton.click()
        await expect(sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })

        await expect.poll(() => server.openAiRequestCount).toBe(5)
        const consumptions = server.getMockConsumptions("openai-compatible-chat")
        expect(consumptions.map((entry) => entry.toolName)).toEqual([
            "use_subagents",
            "attempt_completion",
            "attempt_completion",
            "ask_followup_question",
            "attempt_completion",
        ])
        const handoffContinuation = consumptions[3]
        expect(handoffContinuation.contractError).toBeUndefined()
        expect(handoffContinuation.requestToolResults).toContainEqual(
            expect.objectContaining({
                callId: "call_mixed_batch_handoff",
                content: expect.stringContaining(settledResult),
            }),
        )
        expect(handoffContinuation.requestToolResults).toContainEqual(
            expect.objectContaining({
                callId: "call_mixed_batch_handoff",
                content: expect.stringContaining("Continued background subagent batch job:"),
            }),
        )
        const finalRequest = JSON.stringify(server.getOpenAiRequestBodies().at(-1))
        expect((finalRequest.match(new RegExp(settledResult, "g")) ?? []).length).toBe(1)
        expect(finalRequest).toContain(backgroundResult)
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)

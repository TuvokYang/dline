import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect } from "@playwright/test"

const TASK = "E2E_PLAIN_TEXT_OUTSIDE_TOOL_WARNING"
const PROSE = "E2E_PLAIN_PROSE_STAYS_VISIBLE"
const QUESTION = "E2E_QNA_TOOL_STILL_EXECUTES"

e2e(
    "Provider prose outside a tool call stays visible while the tool still runs",
    async ({ helper, server, sidebar, userDataDir }) => {
        e2e.setTimeout(180_000)
        await helper.signin(sidebar)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses({
            type: "message",
            text: `${PROSE}\n\n<qna_respond><response>${QUESTION}</response></qna_respond>`,
        })

        const input = sidebar.getByTestId("chat-input")
        await input.fill(TASK)
        await sidebar.getByTestId("send-button").click()

        await expect(sidebar.getByText(QUESTION, { exact: true })).toBeVisible({ timeout: 90_000 })
        await expect(sidebar.getByText(PROSE, { exact: true })).toBeVisible()
        await expect(sidebar.getByTestId("error-message-box")).toHaveCount(0)

        const consumptions = server.getMockConsumptions("openai-compatible-chat")
        expect(consumptions).toHaveLength(1)
        expect(consumptions[0]?.contractError).toBeUndefined()
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)

e2e(
    "Plain-text warnings promote 5:1 and Process Anyway resets the warning budget",
    async ({ helper, server, sidebar, userDataDir }) => {
        e2e.setTimeout(180_000)
        await helper.signin(sidebar)
        server.resetOpenAiMock()
        const warnings = Array.from({ length: 15 }, (_, index) => ({
            type: "message" as const,
            text: `E2E_PLAIN_WARNING_${index + 1}`,
            ...(index === 4 ? { delayMs: 2_000 } : {}),
        }))
        const guidance = "E2E_PLAIN_WARNING_PROCESS_ANYWAY"
        server.enqueueOpenAiResponses(
            ...warnings,
            {
                type: "tool",
                name: "attempt_completion",
                arguments: { result: "E2E_PLAIN_WARNING_RESET_OK" },
                expectedRequestIncludes: [guidance],
            },
            {
                type: "error",
                status: 500,
                code: "unexpected_additional_request",
                message: "Unexpected request after plain-warning recovery",
            },
        )

        const input = sidebar.getByTestId("chat-input")
        await input.fill("E2E_PLAIN_WARNING_BUDGET_TASK")
        await sidebar.getByTestId("send-button").click()

        await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(5)
        await expect(sidebar.getByTestId("error-message-box")).toHaveCount(0)

        const attention = sidebar.getByTestId("error-message-box")
        await expect(attention.getByText("Task Needs Attention", { exact: true })).toBeVisible({ timeout: 90_000 })
        expect(server.openAiRequestCount).toBe(15)

        const processAnyway = sidebar.getByRole("contentinfo").locator('vscode-button[aria-label="Process Anyway"]')
        await input.fill(guidance)
        await processAnyway.click()

        await expect(sidebar.getByText("E2E_PLAIN_WARNING_RESET_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
        await expect.poll(() => server.openAiRequestCount).toBe(16)
        expect(server.getMockConsumptions("openai-compatible-chat").every((entry) => entry.contractError === undefined)).toBe(
            true,
        )
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)

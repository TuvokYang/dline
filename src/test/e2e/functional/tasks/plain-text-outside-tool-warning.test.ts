import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect } from "@playwright/test"

const TASK = "E2E_PLAIN_TEXT_OUTSIDE_TOOL_WARNING"
const INVALID_PROSE = "E2E_INVALID_PROSE_MUST_BE_REPLACED"
const QUESTION = "E2E_QNA_TOOL_STILL_EXECUTES"

e2e(
    "Provider prose outside a tool call settles as a warning while the tool still runs",
    async ({ helper, server, sidebar, userDataDir }) => {
        e2e.setTimeout(180_000)
        await helper.signin(sidebar)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses({
            type: "message",
            text: `${INVALID_PROSE}\n\n<qna_respond><response>${QUESTION}</response></qna_respond>`,
        })

        const input = sidebar.getByTestId("chat-input")
        await input.fill(TASK)
        await sidebar.getByTestId("send-button").click()

        await expect(sidebar.getByText(QUESTION, { exact: true })).toBeVisible({ timeout: 90_000 })
        await expect(sidebar.getByTestId("error-message-box")).toHaveCount(1)
        await expect(sidebar.getByText(INVALID_PROSE, { exact: true })).toHaveCount(0)

        const consumptions = server.getMockConsumptions("openai-compatible-chat")
        expect(consumptions).toHaveLength(1)
        expect(consumptions[0]?.contractError).toBeUndefined()
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)

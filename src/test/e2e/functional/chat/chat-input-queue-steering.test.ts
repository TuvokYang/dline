import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect } from "@playwright/test"

e2e(
    "Chat input queue - steering rides the next ordinary tool round while queued input stays retained",
    async ({ helper, server, sidebar, userDataDir }) => {
        e2e.setTimeout(180_000)
        await helper.signin(sidebar)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            { type: "tool", name: "list_files", arguments: { path: ".", recursive: "false" }, delayMs: 15_000 },
            { type: "tool", name: "attempt_completion", arguments: { result: "E2E_STEERING_AFTER_ROUND" }, delayMs: 25_000 },
        )
        const input = sidebar.getByTestId("chat-input")
        await input.fill("E2E_STEERING_TOOLROUND_TASK")
        await sidebar.getByTestId("send-button").click()
        await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(1)
        await expect(sidebar.getByRole("button", { name: "Cancel", exact: true }).first()).toBeVisible({ timeout: 30_000 })

        await input.fill("E2E_QUEUED_MUST_WAIT")
        await input.press("Enter")
        await expect(sidebar.getByTestId("input-queue-toggle")).toContainText("Queue 1")
        await input.fill("## E2E_STEERING_NOW\n\n- ordered steering")
        await input.press("Enter")
        await expect(sidebar.getByTestId("input-queue-toggle")).toContainText("Queue 2")
        await sidebar.getByTestId("input-queue-toggle").click()
        await sidebar.locator('[data-testid^="input-queue-send-"]').nth(1).click()
        await expect(sidebar.locator('[data-testid^="input-queue-entry-"]').nth(1)).toHaveAttribute("data-mode", "steering")

        await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(2)
        const delivered = server.getMockConsumptions().at(-1)
        expect(delivered?.contractError).toBeUndefined()
        const body = JSON.stringify(delivered?.requestBody)
        expect(body).toContain("E2E_STEERING_NOW")
        expect(body).toContain("sent by the user while work was in progress")
        expect(body).not.toContain("E2E_QUEUED_MUST_WAIT")
        const row = sidebar.getByTestId("queued-user-input")
        await expect(row).toHaveCount(1)
        await expect(row).toHaveAttribute("data-queued-input-mode", "steering")
        await expect(row.getByRole("heading", { name: "E2E_STEERING_NOW" })).toBeVisible()
        await expect(row).not.toContainText("sent by the user while work was in progress")
        await expect(sidebar.getByTestId("input-queue-toggle")).toContainText("Queue 1")
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)

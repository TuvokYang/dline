import { expectComposerText, PASTED_PNG_CHIP_NAME } from "@e2e/utils/composer"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Locator } from "@playwright/test"

const ONE_PIXEL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
const ONE_PIXEL_PNG_BASE64_PREFIX = ONE_PIXEL_PNG_BASE64.slice(0, -4)

async function closeCurrentTask(sidebar: Frame): Promise<void> {
    const closeButton = sidebar.getByRole("button", { name: "Close Task", exact: true })
    await expect(closeButton).toBeVisible()
    await closeButton.click()
    await expect(closeButton).toHaveCount(0, { timeout: 30_000 })
    await expect(sidebar.getByTestId("chat-input")).toBeVisible()
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
}

/** Paste a screenshot the way the clipboard handler receives one. */
async function pasteScreenshot(input: Locator): Promise<void> {
    await input.evaluate((element, encodedPng) => {
        const binary = atob(encodedPng)
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
        const clipboardData = new DataTransfer()
        clipboardData.items.add(new File([bytes], "history-resume.png", { type: "image/png" }))
        element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }))
    }, ONE_PIXEL_PNG_BASE64)
}

e2e(
    // An image pasted while a history task is only displayed is staged before the
    // task is open again; Resume must still deliver it with the text.
    "History Resume delivers an image and text pasted while the task was only displayed",
    async ({ helper, server, sidebar, userDataDir }) => {
        e2e.setTimeout(180_000)
        await helper.signin(sidebar)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "call_history_image_read",
                name: "read_file",
                arguments: { path: "README.md" },
            },
            {
                // Still in flight when the task is closed, so the history task offers Resume.
                type: "tool",
                id: "call_history_image_interrupted",
                name: "attempt_completion",
                arguments: { result: "E2E_HISTORY_IMAGE_INTERRUPTED_MUST_NOT_RENDER" },
                delayMs: 30_000,
            },
            {
                type: "tool",
                id: "call_history_image_resumed",
                name: "attempt_completion",
                arguments: { result: "E2E_HISTORY_IMAGE_RESUMED" },
                expectedRequestIncludes: ["E2E_HISTORY_IMAGE_DRAFT", "image/png", ONE_PIXEL_PNG_BASE64_PREFIX],
            },
        )

        const taskText = "E2E_HISTORY_IMAGE_TASK"
        const input = sidebar.getByTestId("chat-input")
        await input.fill(taskText)
        await sidebar.getByTestId("send-button").click()
        await expect(sidebar.getByRole("button", { name: "Dline read 1 file", exact: true })).toBeVisible({ timeout: 60_000 })
        await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(2)
        await closeCurrentTask(sidebar)

        await sidebar.getByText(taskText, { exact: true }).last().click()
        const resumeButton = sidebar.getByRole("contentinfo").locator('[data-testid="send-button"][data-action="resume"]')
        await expect(resumeButton).toBeVisible({ timeout: 30_000 })

        await input.fill("E2E_HISTORY_IMAGE_DRAFT")
        await pasteScreenshot(input)
        const chip = input.getByRole("group", { name: PASTED_PNG_CHIP_NAME })
        await expect(chip).toHaveAttribute("data-status", "ready", { timeout: 30_000 })
        await resumeButton.click()

        await expect(sidebar.getByText("E2E_HISTORY_IMAGE_RESUMED", { exact: false }).last()).toBeVisible({
            timeout: 60_000,
        })
        await expectComposerText(input, "")
        await expect(chip).toHaveCount(0)
        expect(server.openAiRequestCount).toBe(3)
        for (const request of server.getMockConsumptions("openai-compatible-chat")) {
            expect(request.contractError).toBeUndefined()
        }
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)

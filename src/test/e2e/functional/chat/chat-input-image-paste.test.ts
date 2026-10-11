import { expectComposerText } from "@e2e/utils/composer"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { type ElectronApplication, expect, type Frame, type Locator } from "@playwright/test"

const ONE_PIXEL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

interface PasteObservation {
    dispatchReturned: boolean
    observedItemTypes: string[]
}

async function pasteScreenshot(input: Locator): Promise<PasteObservation> {
    return input.evaluate((element, encodedPng) => {
        const composer = element as HTMLElement
        let observedItemTypes: string[] = []
        composer.addEventListener(
            "paste",
            (event) => {
                observedItemTypes = Array.from(event.clipboardData?.items ?? []).map((item) => item.type)
            },
            { capture: true, once: true },
        )

        const binary = atob(encodedPng)
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
        const screenshot = new File([bytes], "clipboard-screenshot.png", { type: "image/png" })
        const clipboardData = new DataTransfer()
        clipboardData.items.add(screenshot)
        const pasteEvent = new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData,
        })

        return {
            dispatchReturned: composer.dispatchEvent(pasteEvent),
            observedItemTypes,
        }
    }, ONE_PIXEL_PNG_BASE64)
}

e2e("Chat input - screenshot paste stays available while a task is running", async ({ helper, server, sidebar, userDataDir }) => {
    e2e.setTimeout(180_000)
    await helper.signin(sidebar)
    server.resetOpenAiMock()
    server.enqueueOpenAiResponses({
        type: "tool",
        name: "attempt_completion",
        arguments: { result: "E2E_RUNNING_SCREENSHOT_PASTE_DONE" },
        delayMs: 15_000,
    })

    const input = sidebar.getByTestId("chat-input")
    await input.fill("E2E_RUNNING_SCREENSHOT_PASTE_TASK")
    await sidebar.getByTestId("send-button").click()
    await expect(sidebar.getByText("E2E_RUNNING_SCREENSHOT_PASTE_TASK", { exact: true }).first()).toBeVisible()
    await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(1)
    await expect(sidebar.getByRole("button", { name: "Cancel", exact: true }).first()).toBeVisible({ timeout: 30_000 })

    const runningDraft = "E2E_RUNNING_SCREENSHOT_PASTE_DRAFT"
    await input.fill(runningDraft)
    await expectComposerText(input, runningDraft)

    const pasteObservation = await pasteScreenshot(input)
    expect(pasteObservation).toEqual({ dispatchReturned: false, observedItemTypes: ["image/png"] })
    // The screenshot lands inline at the caret as an image chip with its preview.
    await expect(input.getByRole("group", { name: /^Image clipboard-screenshot\.png, PNG/ })).toBeVisible()
    await expect(input.getByAltText("Thumbnail clipboard-screenshot.png")).toBeVisible()
    await expectComposerText(input, runningDraft)
    await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
})

/** Paste a screenshot into the draft and wait until the composer may send it. */
async function pasteReadyScreenshot(input: Locator): Promise<void> {
    await pasteScreenshot(input)
    const chip = input.getByRole("group", { name: /^Image clipboard-screenshot\.png, PNG/ })
    await expect(chip).toBeVisible()
    await expect(chip).toHaveAttribute("data-status", "ready", { timeout: 30_000 })
}

async function expectQueuedScreenshot(sidebar: Frame, text: string): Promise<void> {
    const toggle = sidebar.getByTestId("input-queue-toggle")
    await expect(toggle).toContainText("Queue 1", { timeout: 60_000 })
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
    const entry = sidebar.locator('[data-testid^="input-queue-entry-"]').filter({ hasText: text })
    await expect(entry).toHaveCount(1)
    const attachments = entry.locator('[data-testid^="input-queue-attachments-"]')
    await expect(attachments).toHaveText("1 image")
    await expect(attachments).toHaveAttribute("title", "clipboard-screenshot.png")
    // The body names the screenshot as the user saw it, never by its resource id.
    await expect(entry.locator('[data-testid^="input-queue-markdown-"]')).toContainText(`${text} [clipboard-screenshot.png]`)
    await expect(entry).not.toContainText("[image:")
    // The overlay floats above the chat; close it so it cannot cover the task controls.
    await toggle.click()
    await expect(sidebar.getByTestId("input-queue-overlay")).toHaveCount(0)
}

// The composer sends a screenshot only as a resource node, so the queue must
// read its attachments from the document rather than from the empty flat lists.
e2e(
    "Chat input - a screenshot queued while a task runs keeps its attachment, also after a reload",
    async ({ helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(240_000)
        let app: ElectronApplication | undefined
        try {
            app = await openVSCode(workspaceDir)
            let page = await app.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            let sidebar = await helper.getSidebar(page)
            await helper.signin(sidebar)
            server.resetOpenAiMock()
            server.enqueueOpenAiResponses({
                type: "tool",
                name: "attempt_completion",
                arguments: { result: "E2E_QUEUED_SCREENSHOT_DONE" },
                // Long enough that the turn cannot end, and drain the queue, before the cancel.
                delayMs: 120_000,
            })

            const input = sidebar.getByTestId("chat-input")
            await input.fill("E2E_QUEUED_SCREENSHOT_TASK")
            await sidebar.getByTestId("send-button").click()
            await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(1)
            const cancel = sidebar.getByRole("button", { name: "Cancel", exact: true }).first()
            await expect(cancel).toBeVisible({ timeout: 30_000 })

            await input.fill("E2E_QUEUED_SCREENSHOT_TEXT ")
            await pasteReadyScreenshot(input)
            await input.press("Enter")
            await expectQueuedScreenshot(sidebar, "E2E_QUEUED_SCREENSHOT_TEXT")
            await expectComposerText(input, "", { timeout: 30_000 })

            // Cancel keeps the queue; the restored entry must still name its screenshot.
            await cancel.click()
            await expect(sidebar.getByTestId("input-queue-toggle")).toContainText("Queue 1", { timeout: 60_000 })
            await app.close()
            helper.clearCachedFrame()
            app = undefined

            app = await openVSCode(workspaceDir)
            const reopenedApp = app
            page = await reopenedApp.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            sidebar = await helper.getSidebar(page)
            const historyTask = sidebar.locator(".history-preview-item").filter({ hasText: "E2E_QUEUED_SCREENSHOT_TASK" })
            await expect(historyTask).toHaveCount(1, { timeout: 30_000 })
            await historyTask.click()
            helper.clearCachedFrame()
            sidebar = await E2ETestHelper.waitForValue(async () => {
                for (const candidatePage of reopenedApp.windows()) {
                    for (const frame of candidatePage.frames()) {
                        if (frame.isDetached()) continue
                        if ((await frame.getByTestId("input-queue-toggle").count()) > 0) return frame
                    }
                }
                return undefined
            }, 60_000)
            await expect(sidebar.getByTestId("hydration-pending")).toHaveCount(0, { timeout: 30_000 })
            await expectQueuedScreenshot(sidebar, "E2E_QUEUED_SCREENSHOT_TEXT")
            expect(server.openAiRequestCount).toBe(1)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app?.close()
            helper.clearCachedFrame()
        }
    },
)

e2e(
    "Chat input - a queued screenshot reaches the model at the next turn end",
    async ({ helper, server, sidebar, userDataDir }) => {
        e2e.setTimeout(240_000)
        await helper.signin(sidebar)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                name: "attempt_completion",
                arguments: { result: "E2E_QUEUED_SCREENSHOT_FIRST" },
                delayMs: 15_000,
            },
            {
                type: "tool",
                name: "attempt_completion",
                arguments: { result: "E2E_QUEUED_SCREENSHOT_SECOND" },
            },
        )

        const input = sidebar.getByTestId("chat-input")
        await input.fill("E2E_QUEUED_SCREENSHOT_DELIVERY_TASK")
        await sidebar.getByTestId("send-button").click()
        await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(1)
        await expect(sidebar.getByRole("button", { name: "Cancel", exact: true }).first()).toBeVisible({ timeout: 30_000 })

        await input.fill("E2E_QUEUED_SCREENSHOT_DELIVERED ")
        await pasteReadyScreenshot(input)
        await input.press("Enter")
        await expectQueuedScreenshot(sidebar, "E2E_QUEUED_SCREENSHOT_DELIVERED")

        await expect.poll(() => server.openAiRequestCount, { timeout: 120_000 }).toBe(2)
        const delivered = JSON.stringify(server.getMockConsumptions().at(-1)?.requestBody)
        expect(delivered).toContain("E2E_QUEUED_SCREENSHOT_DELIVERED")
        expect(delivered).toContain(ONE_PIXEL_PNG_BASE64.slice(0, 24))
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)

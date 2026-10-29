import { expect, type Locator, type Page, test } from "@playwright/test"

const STORY = "/iframe.html?id=ui-dialog--long-content&viewMode=story"

// A short, narrow sidebar where the dialog body is taller than the webview.
const SHORT_SIDEBAR = { width: 280, height: 420 }

async function expectInsideViewport(page: Page, locator: Locator) {
    const viewport = page.viewportSize()
    const box = await locator.boundingBox()
    expect(viewport).not.toBeNull()
    expect(box).not.toBeNull()
    if (!viewport || !box) return
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
}

test("DialogContent stays inside a short sidebar and scrolls its body", async ({ page }) => {
    await page.setViewportSize(SHORT_SIDEBAR)
    const response = await page.goto(STORY, { waitUntil: "domcontentloaded" })
    expect(response?.ok()).toBeTruthy()

    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await expectInsideViewport(page, dialog)
    await expectInsideViewport(page, page.getByRole("heading", { name: "Long dialog" }))
    await expectInsideViewport(page, dialog.getByRole("button", { name: "Close" }))

    // The overflow is scrollable inside the dialog rather than lost below the viewport.
    const lastLine = dialog.getByTestId("long-dialog-line").last()
    await lastLine.scrollIntoViewIfNeeded()
    await expectInsideViewport(page, lastLine)
})

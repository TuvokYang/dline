import { expect, type Locator, type Page, test } from "@playwright/test"

const STORY = "/iframe.html?id=common-whatsnewmodal--default&viewMode=story"

// Matches the Dline sidebar of the 1024x677 VS Code window used by the macOS E2E runners,
// where the announcement is far taller than the visible webview.
const NARROW_SIDEBAR = { width: 240, height: 560 }

async function openWhatsNew(page: Page) {
	const response = await page.goto(STORY, { waitUntil: "domcontentloaded" })
	expect(response?.ok()).toBeTruthy()
	await expect(page.getByRole("heading", { name: /New in v/ })).toBeVisible()
	await page.evaluate(() => document.fonts.ready)
}

async function expectInsideViewport(page: Page, locator: Locator) {
	const viewport = page.viewportSize()
	const box = await locator.boundingBox()
	expect(viewport).not.toBeNull()
	expect(box).not.toBeNull()
	if (!viewport || !box) return
	expect(box.y).toBeGreaterThanOrEqual(0)
	expect(box.x).toBeGreaterThanOrEqual(0)
	expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
	expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
}

test("What's New keeps its title and close button reachable in a short, narrow sidebar", async ({ page }, testInfo) => {
	const consoleErrors: string[] = []
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text())
	})
	await page.setViewportSize(NARROW_SIDEBAR)
	await openWhatsNew(page)

	const dialog = page.getByRole("dialog")
	const closeButton = dialog.getByRole("button", { name: "Close" })

	await expectInsideViewport(page, dialog)
	await expectInsideViewport(page, page.getByRole("heading", { name: /New in v/ }))
	await expectInsideViewport(page, closeButton)
	await closeButton.click({ trial: true })

	// The body scrolls inside the dialog instead of pushing the dialog off screen.
	const changelogLink = dialog.getByRole("link", { name: "full changelog" })
	await changelogLink.scrollIntoViewIfNeeded()
	await expectInsideViewport(page, changelogLink)
	await expectInsideViewport(page, closeButton)

	// Radix reports a dialog without its own title as inaccessible to screen readers.
	expect(consoleErrors.filter((text) => text.includes("DialogTitle"))).toEqual([])

	await page.screenshot({ path: testInfo.outputPath("whats-new-narrow-sidebar.png") })
})

import { expect, type Page, test } from "@playwright/test"

const STORY = "/iframe.html?id=chat-contextwindow--segmented-summary&viewMode=story"

async function openContextWindow(page: Page) {
	const response = await page.goto(STORY, { waitUntil: "domcontentloaded" })
	expect(response?.ok()).toBeTruthy()
	await expect(page.getByTestId("context-window-fixture")).toBeVisible()
	await expect(page.getByTestId("context-window-progress-track")).toBeVisible()
	await page.evaluate(() => document.fonts.ready)
}

test("Context Window summary has one visual surface on hover and focus", async ({ page }, testInfo) => {
	await openContextWindow(page)
	const trigger = page.getByTestId("context-window-tooltip-trigger")
	await trigger.hover()

	const surface = page.locator('[data-context-window-surface="summary"]')
	const summary = page.getByTestId("context-window-summary")
	await expect(surface).toBeVisible()
	await expect(summary).toBeVisible()
	await expect(page.locator('[data-slot="hover-card-content"]')).toHaveCount(1)
	// The card opens with a zoom-in animation, so a rect read mid-animation is
	// scaled down; measure the settled surface, not a frame of the transition.
	await surface.evaluate((element) =>
		Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)),
	)

	const geometry = await surface.evaluate((element) => {
		const surfaceStyle = getComputedStyle(element)
		const summary = element.querySelector<HTMLElement>('[data-testid="context-window-summary"]')
		const summaryStyle = summary ? getComputedStyle(summary) : undefined
		const surfaceRect = element.getBoundingClientRect()
		const summaryRect = summary?.getBoundingClientRect()
		const arrow = element.querySelector("svg")
		const arrowStyle = arrow ? getComputedStyle(arrow) : undefined
		return {
			rootFontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
			surfaceBackground: surfaceStyle.backgroundColor,
			surfaceWidth: surfaceRect.width,
			summaryBackground: summaryStyle?.backgroundColor,
			summaryShadow: summaryStyle?.boxShadow,
			summaryInsideSurface:
				summaryRect !== undefined &&
				summaryRect.left >= surfaceRect.left &&
				summaryRect.right <= surfaceRect.right &&
				summaryRect.top >= surfaceRect.top &&
				summaryRect.bottom <= surfaceRect.bottom,
			arrowBackground: arrowStyle?.backgroundColor,
			arrowFill: arrowStyle?.fill,
		}
	})

	expect(geometry.surfaceWidth).toBeCloseTo(geometry.rootFontSize * 18, 0)
	expect(geometry.summaryBackground).toBe("rgba(0, 0, 0, 0)")
	expect(geometry.summaryShadow).toBe("none")
	expect(geometry.summaryInsideSurface).toBe(true)
	expect(geometry.arrowBackground).toBe(geometry.surfaceBackground)
	expect(geometry.arrowFill).toBe(geometry.surfaceBackground)

	await trigger.click()
	await expect(surface).toBeVisible()
	await expect(page.locator('[data-slot="hover-card-content"]')).toHaveCount(1)
	await page.screenshot({ path: testInfo.outputPath("context-window-single-surface.png") })
})

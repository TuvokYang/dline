import { expect, test } from "@playwright/test"

for (const width of [360, 1280]) {
    for (const story of ["collapsed", "long-task-text"]) {
        test(`task header ${story} shows complete details at ${width}px`, async ({ page }, testInfo) => {
            await page.setViewportSize({ width, height: 640 })
            await page.goto(`/iframe.html?id=views-components-taskheader--${story}&viewMode=story`)
            const trigger = page.getByLabel("Task details", { exact: true })
            await expect(trigger).toBeVisible()
            await page.evaluate(() => document.fonts.ready)
            await trigger.hover()
            const preview = page.getByRole("tooltip")
            await expect(preview).toBeVisible()
            await expect(preview.locator("dd").first()).toHaveText("storybook-task-123")
            if (story === "collapsed") {
                await expect(preview.locator("dd").last()).toHaveText(
                    "Create a responsive navigation component for a React application",
                )
            } else {
                await expect(preview.locator("dd").last()).toContainText("10. Analytics integration")
            }

            const box = await preview.boundingBox()
            if (!box) throw new Error("Task preview geometry is unavailable")
            expect(box.x).toBeGreaterThanOrEqual(7)
            expect(box.x + box.width).toBeLessThanOrEqual(width - 7)
            expect(box.y).toBeGreaterThanOrEqual(7)
            expect(box.y + box.height).toBeLessThanOrEqual(633)
            const layout = await preview.evaluate((element) => ({
                horizontalOverflow: element.scrollWidth > element.clientWidth + 1,
                scrollable: element.scrollHeight > element.clientHeight + 1,
            }))
            expect(layout.horizontalOverflow).toBe(false)
            await preview.hover()
            await expect(preview).toBeVisible()
            if (width === 360 && story === "long-task-text") {
                expect(layout.scrollable).toBe(true)
                await page.mouse.wheel(0, 2_000)
                await expect
                    .poll(() => preview.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
                    .toBeLessThanOrEqual(2)
            }
            await page.screenshot({ path: testInfo.outputPath("task-details-hover.png") })
            await page.keyboard.press("Escape")
            await expect(preview).toBeHidden()
            await trigger.focus()
            await expect(preview).toBeVisible()
        })
    }
}

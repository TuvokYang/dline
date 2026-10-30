import { expect, test } from "@playwright/test"

for (const preset of ["collapsed", "partially-expanded", "all-expanded"] as const) {
    test(`real chat reveals and navigates the trajectory with ${preset} message-segment folds`, async ({ page }, testInfo) => {
        await page.goto("/iframe.html?id=chat-folding-and-trajectory--message-segments&viewMode=story")
        const fixture = page.getByTestId("folding-trajectory-fixture")
        const scroller = fixture.locator("[data-virtuoso-scroller]")
        const rail = fixture.getByRole("navigation", { name: "Conversation trajectory" })
        await expect(scroller).toBeVisible()
        await expect(rail.getByTestId("trajectory-turn")).toHaveCount(12)

        // Wait for initial bottom restoration, then express real user browsing intent.
        await expect
            .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
            .toBeLessThanOrEqual(10)
        // Expansion transfers viewport ownership to the reader, so it must not
        // be expected to auto-follow the newly taller list back to the bottom.
        if (preset === "partially-expanded") await page.getByRole("button", { name: "Partially expand", exact: true }).click()
        if (preset === "all-expanded") await page.getByRole("button", { name: "Expand all", exact: true }).click()
        await scroller.hover({ position: { x: 2, y: 200 } })
        await page.mouse.wheel(0, -(await scroller.evaluate((element) => element.scrollHeight)))
        await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThan(1)
        if (preset === "collapsed") {
            await expect(fixture.locator('[data-testid="activity-fold-header"][aria-expanded="true"]')).toHaveCount(0)
        } else if (preset === "partially-expanded") {
            // Open proposal blocks restore top-level Standard rows, not expanded fold wrappers.
            await expect(fixture.locator('[data-row-ts="1010"]').first()).toBeAttached()
            await expect(fixture.locator('[data-fold-id="segment:1010"]')).toHaveCount(0)
            await expect(fixture.locator('[data-testid="activity-fold-header"][aria-expanded="true"]')).toHaveCount(0)
        } else {
            await expect(fixture.locator('[data-testid="activity-fold-header"][aria-expanded="false"]')).toHaveCount(0)
        }

        // Start from idle so an initial/programmatic scroll cannot satisfy the reveal assertion.
        await page.mouse.move(900, 750)
        await expect(rail).toHaveCSS("opacity", "0")
        const before = await scroller.evaluate((element) => element.scrollTop)
        await scroller.hover({ position: { x: 2, y: 200 } })
        await page.mouse.wheel(0, 420)
        await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(before + 10)
        await expect(rail).toHaveCSS("opacity", "1")
        await expect(rail).toBeInViewport()
        await expect(rail).toHaveCSS("pointer-events", "auto")
        await testInfo.attach(`${preset}-scroll`, { body: await page.screenshot(), contentType: "image/png" })

        // No synthetic focus or forced click: the scroll must have made this bar usable.
        await rail.locator('[data-turn-ts="1101"]').click()
        await expect(fixture.locator('[data-message-ts="1101"]')).toBeInViewport()

        if (preset === "collapsed") {
            // The ordinary text and both communication tools remain standalone, not folded descendants.
            for (const ts of [1132, 1136, 1144]) {
                const message = fixture.locator(`[data-message-ts="${ts}"]`)
                await expect(message).toBeAttached()
                expect(await message.evaluate((element) => element.closest("[data-fold-id]") === null)).toBe(true)
            }
            await expect(fixture.locator('[data-testid="activity-fold-header"][aria-expanded="true"]')).toHaveCount(0)
        }
    })
}

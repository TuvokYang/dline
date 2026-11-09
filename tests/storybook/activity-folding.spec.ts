import { expect, test } from "@playwright/test"

for (const mode of ["standard", "message-segments", "whole-turn"] as const) {
    test(`dynamic Activity Folding uses production ${mode} rules and restores Standard rows`, async ({ page }) => {
        const finish = async (story: string) => {
            await page.goto(`/iframe.html?id=chat-activity-folding--${story}&viewMode=story`)
            await page.getByRole("button", { name: "End", exact: true }).click()
            await expect(page.getByTestId("live-step-caption")).toHaveText(/completes the second turn/)
        }
        const order = () =>
            page.locator("[data-row-ts]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-row-ts")))
        await finish("standard")
        const standard = await order()
        expect(standard.length).toBeGreaterThan(10)
        if (mode === "standard") {
            await expect(page.locator("[data-fold-id]")).toHaveCount(0)
            return
        }
        await finish(mode)
        await expect(page.locator("select")).toHaveCount(0)
        if (mode === "whole-turn") {
            await expect(page.locator("[data-fold-id]")).toHaveCount(2)
            for (const ts of [32, 36, 39.5, 53]) await expect(page.locator(`[data-message-ts="${ts}"]`)).toHaveCount(0)
        } else {
            for (const ts of [32, 36, 39.5, 53]) {
                const row = page.locator(`[data-message-ts="${ts}"]`)
                await expect(row).toBeVisible()
                expect(await row.evaluate((node) => node.closest("[data-fold-id]") === null)).toBe(true)
            }
        }
        await page.getByRole("button", { name: "Expand all activity", exact: true }).click()
        await expect(page.locator("[data-fold-id]")).toHaveCount(0)
        expect(await order()).toEqual(standard)
        await page.getByRole("button", { name: "Collapse all activity", exact: true }).click()
        await expect.poll(() => page.locator("[data-fold-id]").count()).toBeGreaterThan(0)
    })
}

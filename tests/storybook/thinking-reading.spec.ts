import { expect, type Locator, type Page, test } from "@playwright/test"

const distanceFromBottom = (region: Locator) =>
    region.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)

// Let scroll events and ResizeObserver deliveries finish, not a fixed elapsed delay.
async function settleLayout(page: Page) {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function scrollTo(region: Locator, top: number) {
    await region.evaluate((element, position) => {
        element.scrollTop = position
    }, top)
}

test.beforeEach(async ({ page }) => {
    await page.goto("/iframe.html?id=chat-thinking-row--reading&viewMode=story")
    await expect(page.getByRole("region", { name: "Thinking content" })).toBeVisible()
})

test("thinking follows long streamed content, yields to manual reading, resumes and follows reflow", async ({ page }) => {
    const region = page.getByRole("region", { name: "Thinking content" })
    await expect.poll(() => region.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    await expect.poll(() => distanceFromBottom(region)).toBeLessThan(2)
    expect(await region.evaluate((element) => element.clientHeight)).toBeLessThanOrEqual(150)
    await expect(region.locator("strong")).toHaveCount(12)

    await page.getByRole("button", { name: "Append chunk" }).click()
    await expect(page.getByRole("status")).toHaveText("Parts: 13")
    await expect.poll(() => distanceFromBottom(region)).toBeLessThan(2)

    await scrollTo(region, 100)
    await settleLayout(page)
    const readingTop = await region.evaluate((element) => element.scrollTop)
    await page.getByRole("button", { name: "Append chunk" }).click()
    await expect(page.getByRole("status")).toHaveText("Parts: 14")
    await settleLayout(page)
    expect(await region.evaluate((element) => element.scrollTop)).toBe(readingTop)

    await scrollTo(region, await region.evaluate((element) => element.scrollHeight))
    await settleLayout(page)
    await page.getByRole("button", { name: "Append chunk" }).click()
    await expect(page.getByRole("status")).toHaveText("Parts: 15")
    await expect.poll(() => distanceFromBottom(region)).toBeLessThan(2)

    const previousHeight = await region.evaluate((element) => element.scrollHeight)
    await page.getByRole("button", { name: "Toggle width" }).click()
    await expect.poll(() => region.evaluate((element) => element.scrollHeight)).toBeGreaterThan(previousHeight)
    await expect.poll(() => distanceFromBottom(region)).toBeLessThan(2)
    await test.info().attach("thinking-streaming", { body: await page.screenshot(), contentType: "image/png" })
})

test("a one-pixel upward scroll pauses following without a layout-update loop", async ({ page }) => {
    const region = page.getByRole("region", { name: "Thinking content" })
    await expect.poll(() => distanceFromBottom(region)).toBeLessThan(2)
    const readingTop = (await region.evaluate((element) => element.scrollTop)) - 1
    await scrollTo(region, readingTop)
    await settleLayout(page)
    await page.getByRole("button", { name: "Append chunk" }).click()
    await expect(page.getByRole("status")).toHaveText("Parts: 13")
    await settleLayout(page)
    await expect(region).toBeVisible()
    expect(await region.evaluate((element) => element.scrollTop)).toBe(readingTop)
})

test("stopping keeps position, while reopening static thinking starts at the top without body-click collapse", async ({
    page,
}) => {
    const region = page.getByRole("region", { name: "Thinking content" })
    await expect.poll(() => distanceFromBottom(region)).toBeLessThan(2)
    const position = await region.evaluate((element) => element.scrollTop)
    await page.getByRole("button", { name: "Stop stream" }).click()
    await settleLayout(page)
    expect(await region.evaluate((element) => element.scrollTop)).toBe(position)
    const header = page.getByRole("button", { name: "Thinking", exact: true })
    await header.click()
    await expect(region).toHaveCount(0)
    await header.click()
    await expect(region).toBeVisible()
    await expect.poll(() => region.evaluate((element) => element.scrollTop)).toBe(0)
    await region.locator("strong").first().click()
    await expect(header).toHaveAttribute("aria-expanded", "true")
    await expect(region).toBeVisible()
    await test.info().attach("thinking-history", { body: await page.screenshot(), contentType: "image/png" })
})

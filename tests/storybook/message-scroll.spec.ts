import { expect, type Page, test } from "@playwright/test"

const STORY = "/iframe.html?id=regression-message-scrolling--interactive&viewMode=story"
const SCROLLER = '[data-virtuoso-scroller="true"]'

async function geometry(page: Page) {
    return page.locator(SCROLLER).evaluate((element) => ({
        top: element.scrollTop,
        height: element.scrollHeight,
        viewport: element.clientHeight,
        gap: element.scrollHeight - element.clientHeight - element.scrollTop,
    }))
}

/** Wait for browser layout/scroll events, not a guessed wall-clock delay. */
async function settleFrames(page: Page) {
    await page.evaluate(async () => {
        for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
}

async function openFixture(page: Page) {
    await page.goto(STORY, { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("scroll-fixture")).toBeVisible({ timeout: 120_000 })
    await expect.poll(async () => (await geometry(page)).gap).toBeLessThanOrEqual(10)
    await settleFrames(page)
}

test.describe.configure({ mode: "default" })
test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    const page = await browser.newPage()
    try {
        await openFixture(page)
    } finally {
        await page.close()
    }
})

test("message refresh must not undo small downward or upward browsing movements", async ({ page }, testInfo) => {
    await openFixture(page)
    await page.locator(SCROLLER).hover()
    await page.mouse.wheel(0, -700)
    await expect.poll(async () => (await geometry(page)).gap).toBeGreaterThan(300)
    await settleFrames(page)
    const evidence = []
    for (const delta of [12, -12]) {
        const before = await geometry(page)
        await page.mouse.wheel(0, delta)
        await expect.poll(async () => Math.abs((await geometry(page)).top - before.top)).toBeGreaterThan(5)
        await settleFrames(page)
        const moved = await geometry(page)
        // Trigger the same immutable transport refresh that occurs during streaming,
        // after a small scroll that need not change Virtuoso's rendered row range.
        await page
            .getByRole("button", { name: "Refresh messages", exact: true })
            .evaluate((button: HTMLButtonElement) => button.click())
        await settleFrames(page)
        const refreshed = await geometry(page)
        evidence.push({ delta, before, moved, refreshed })
        await testInfo.attach(`browsing-${delta}.json`, {
            body: JSON.stringify(evidence, null, 2),
            contentType: "application/json",
        })
        expect
            .soft(Math.abs(refreshed.top - moved.top), `message identity refresh must not undo ${delta}px user movement`)
            .toBeLessThanOrEqual(2)
    }
})

test("following survives a viewport resize without another message", async ({ page }, testInfo) => {
    await openFixture(page)
    await page.getByRole("button", { name: "Resize viewport" }).evaluate((button: HTMLButtonElement) => button.click())
    await settleFrames(page)
    await testInfo.attach("resize.json", { body: JSON.stringify(await geometry(page)), contentType: "application/json" })
    await expect.poll(async () => (await geometry(page)).gap, { timeout: 3000 }).toBeLessThanOrEqual(10)
})

test("visible restoration publishes the last hidden message update", async ({ page }) => {
    await openFixture(page)
    // A live conversation has already refreshed at least once after task-entry reset.
    await page
        .getByRole("button", { name: "Refresh messages", exact: true })
        .evaluate((button: HTMLButtonElement) => button.click())
    await settleFrames(page)
    // Deterministically drive the browser lifecycle boundary without modifying production code.
    await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
        document.dispatchEvent(new Event("visibilitychange"))
    })
    await page.getByRole("button", { name: "Update tail" }).evaluate((button: HTMLButtonElement) => button.click())
    await settleFrames(page)
    await expect(page.getByText("SCROLL_UPDATED_TAIL", { exact: true })).toHaveCount(0)
    await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" })
        document.dispatchEvent(new Event("visibilitychange"))
    })
    await expect(page.getByText("SCROLL_UPDATED_TAIL", { exact: true })).toBeVisible({ timeout: 3000 })
    await expect.poll(async () => (await geometry(page)).gap).toBeLessThanOrEqual(10)
})

test("wheel at a completed tool card boundary can scroll the outer conversation", async ({ page }, testInfo) => {
    await openFixture(page)
    await page.getByRole("button", { name: "Append completion" }).evaluate((button: HTMLButtonElement) => button.click())
    const card = page.getByText("SCROLL_COMPLETION_CARD", { exact: true })
    await expect(card).toBeVisible()
    await settleFrames(page)
    const before = await geometry(page)
    await card.hover()
    // Confirm the pointer is inside the real nested scrolling surface.
    await testInfo.attach("card-boundary.json", {
        body: JSON.stringify(
            await page.getByTestId("completion-output-scroll").evaluate((element) => ({
                top: element.scrollTop,
                height: element.scrollHeight,
                viewport: element.clientHeight,
                overscroll: getComputedStyle(element).overscrollBehaviorY,
            })),
        ),
        contentType: "application/json",
    })
    await page.mouse.wheel(0, -120)
    await settleFrames(page)
    await testInfo.attach("card-wheel.json", {
        body: JSON.stringify({ before, after: await geometry(page) }),
        contentType: "application/json",
    })
    await expect.poll(async () => before.top - (await geometry(page)).top, { timeout: 3000 }).toBeGreaterThan(40)
})

test("browsing remains responsive through repeated tail updates and viewport resize", async ({ page }) => {
    await openFixture(page)
    await page.locator(SCROLLER).hover()
    await page.mouse.wheel(0, -700)
    await expect.poll(async () => (await geometry(page)).gap).toBeGreaterThan(300)
    await settleFrames(page)
    for (let index = 0; index < 6; index++) {
        const before = await geometry(page)
        await page.mouse.wheel(0, index % 2 === 0 ? -16 : 16)
        await expect.poll(async () => Math.abs((await geometry(page)).top - before.top)).toBeGreaterThan(8)
        await settleFrames(page)
        const moved = await geometry(page)
        await page.getByRole("button", { name: "Update tail" }).evaluate((button: HTMLButtonElement) => button.click())
        await settleFrames(page)
        expect(Math.abs((await geometry(page)).top - moved.top)).toBeLessThanOrEqual(2)
    }
    const beforeResize = await geometry(page)
    await page.getByRole("button", { name: "Resize viewport" }).evaluate((button: HTMLButtonElement) => button.click())
    await settleFrames(page)
    expect(Math.abs((await geometry(page)).top - beforeResize.top)).toBeLessThanOrEqual(2)
    expect((await geometry(page)).gap).toBeGreaterThan(300)
})

test("explicit jump to top supersedes a browsing anchor after a tail update", async ({ page }) => {
    await openFixture(page)
    const scroller = page.locator(SCROLLER)
    await scroller.hover()
    await page.mouse.wheel(0, -700)
    await expect.poll(async () => (await geometry(page)).gap).toBeGreaterThan(300)
    await page.getByRole("button", { name: "Scroll to top", exact: true }).click()
    await expect.poll(async () => (await geometry(page)).top).toBeLessThanOrEqual(2)
    await settleFrames(page)

    await scroller.hover()
    await page.mouse.wheel(0, 120)
    await expect.poll(async () => (await geometry(page)).top).toBeGreaterThan(80)
    await page.mouse.wheel(0, -12)
    await settleFrames(page)
    await page
        .getByRole("button", { name: "Update tail", exact: true })
        .evaluate((button) => (button as HTMLButtonElement).click())
    await settleFrames(page)
    await page.getByRole("button", { name: "Scroll to top", exact: true }).click()
    await settleFrames(page)
    await expect.poll(async () => (await geometry(page)).top, { timeout: 3_000 }).toBeLessThanOrEqual(2)
})

test("long tool content keeps its height cap and consumes scrolling before its boundary", async ({ page }) => {
    await openFixture(page)
    await page.getByRole("button", { name: "Append long card" }).evaluate((button: HTMLButtonElement) => button.click())
    const card = page.getByTestId("completion-output-scroll")
    await expect(card).toBeVisible()
    await settleFrames(page)
    const dimensions = await card.evaluate((element) => ({
        height: element.clientHeight,
        content: element.scrollHeight,
        limit: window.innerHeight * 0.6,
    }))
    expect(dimensions.height).toBeLessThanOrEqual(dimensions.limit + 1)
    expect(dimensions.content).toBeGreaterThan(dimensions.height)
    await card.evaluate((element) => {
        element.scrollTop = 200
    })
    await card.hover()
    await settleFrames(page)
    const outer = await geometry(page)
    const innerTop = await card.evaluate((element) => element.scrollTop)
    await page.mouse.wheel(0, 60)
    await expect.poll(() => card.evaluate((element) => element.scrollTop)).toBeGreaterThan(innerTop + 30)
    expect(Math.abs((await geometry(page)).top - outer.top)).toBeLessThanOrEqual(2)
})

test("a wheel with remaining nested distance finishes the card without leaking into the conversation", async ({
    page,
}, testInfo) => {
    await openFixture(page)
    await page.getByRole("button", { name: "Append long card" }).evaluate((button: HTMLButtonElement) => button.click())
    const card = page.getByTestId("completion-output-scroll")
    await expect(card).toBeVisible()
    await card.evaluate((element) => {
        element.scrollTop = element.scrollHeight - element.clientHeight - 20
    })
    await card.hover()
    await settleFrames(page)

    const outerBefore = await geometry(page)
    const innerBefore = await card.evaluate((element) => ({
        top: element.scrollTop,
        max: element.scrollHeight - element.clientHeight,
    }))
    await page.mouse.wheel(0, 120)
    await settleFrames(page)
    const outerAfterFirstWheel = await geometry(page)
    const innerAfterFirstWheel = await card.evaluate((element) => ({
        top: element.scrollTop,
        max: element.scrollHeight - element.clientHeight,
    }))

    await testInfo.attach("nested-wheel-boundary-probe.json", {
        body: JSON.stringify({ outerBefore, innerBefore, outerAfterFirstWheel, innerAfterFirstWheel }, null, 2),
        contentType: "application/json",
    })
    expect(innerAfterFirstWheel.max - innerAfterFirstWheel.top).toBeLessThanOrEqual(1)
    expect(Math.abs(outerAfterFirstWheel.top - outerBefore.top)).toBeLessThanOrEqual(2)
})

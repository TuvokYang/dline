import { expect, type Page, test } from "@playwright/test"

const STORY = "/iframe.html?id=chat-usagebar--remaining-capacity&viewMode=story"
const FLOATING_SURFACES = '[data-slot="tooltip-content"], [data-slot="click-menu-content"]'

async function openUsageBar(page: Page) {
    const response = await page.goto(STORY, { waitUntil: "domcontentloaded" })
    expect(response?.ok()).toBeTruthy()
    await expect(page.getByTestId("usage-bar-fixture")).toBeVisible()
    await expect(page.getByRole("button", { name: "Provider usage" })).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
}

async function visibleSurfaceCount(page: Page): Promise<number> {
    return page.locator(FLOATING_SURFACES).evaluateAll(
        (elements) =>
            elements.filter((element) => {
                const style = getComputedStyle(element)
                const rect = element.getBoundingClientRect()
                return (
                    style.visibility !== "hidden" &&
                    style.display !== "none" &&
                    Number(style.opacity) > 0 &&
                    rect.width > 0 &&
                    rect.height > 0
                )
            }).length,
    )
}

test("hover tooltip keeps the original colors, compact reset summary, and a uniform right edge", async ({ page }, testInfo) => {
    await openUsageBar(page)
    const trigger = page.getByRole("button", { exact: true, name: "Provider usage" })
    await trigger.hover()

    const surface = page.locator('[data-usage-surface="preview"]')
    await expect(surface).toBeVisible()
    await expect(surface).toHaveAttribute("data-slot", "tooltip-content")
    await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(1)
    await expect(page.locator('[data-slot="click-menu-content"]')).toHaveCount(0)
    await expect(surface).toContainText("Reset cards: 2")
    await expect(surface).toContainText("Next card expires")
    await expect(surface).not.toContainText("Reset card 1")
    await expect.poll(() => visibleSurfaceCount(page)).toBe(1)

    const edge = await surface.evaluate((element) => {
        const surfaceStyle = getComputedStyle(element)
        const arrow = element.querySelector("svg")
        const arrowStyle = arrow ? getComputedStyle(arrow) : undefined
        const foregroundProbe = document.createElement("span")
        foregroundProbe.style.color = "var(--vscode-foreground)"
        document.body.appendChild(foregroundProbe)
        const expectedForeground = getComputedStyle(foregroundProbe).color
        foregroundProbe.remove()
        return {
            background: surfaceStyle.backgroundColor,
            borderRight: surfaceStyle.borderRightColor,
            color: surfaceStyle.color,
            expectedForeground,
            arrowBackground: arrowStyle?.backgroundColor,
            arrowFill: arrowStyle?.fill,
            hasHorizontalOverflow: element.scrollWidth > element.clientWidth + 1,
        }
    })

    expect(edge.hasHorizontalOverflow).toBe(false)
    expect(edge.color).toBe(edge.expectedForeground)
    expect(edge.arrowBackground).toBe(edge.background)
    expect(edge.arrowFill).toBe(edge.background)
    await page.screenshot({ path: testInfo.outputPath("usage-hover-preview.png") })
})

test("hover then click keeps the click menu within a narrow Webview and aligned to the trigger", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 430, height: 640 })
    await openUsageBar(page)
    const trigger = page.getByRole("button", { exact: true, name: "Provider usage" })
    await trigger.hover()
    await expect(page.locator('[data-usage-surface="preview"]')).toBeVisible()

    await trigger.click()
    await expect(page.locator('[data-usage-surface="details"]')).toBeVisible()
    await expect(page.locator('[data-usage-surface="details"]')).toHaveAttribute("data-slot", "click-menu-content")
    const details = page.getByLabel("Provider usage details")
    await expect(details).toBeVisible()
    await expect(details).toContainText("Reset card 1")
    await expect(details.getByRole("button", { name: "Use reset card 1" })).toBeVisible()
    await expect(details).toHaveClass(/border-editor-group-border/)
    await expect(details).toHaveClass(/bg-menu/)
    await expect(details.locator("[data-usage-header]")).toHaveClass(/border-editor-group-border/)
    await expect(details.locator("li")).toHaveCount(2)
    await expect(details.locator("li").first()).toHaveClass(/bg-toolbar-hover\/30/)
    const [detailsBox, triggerBox] = await Promise.all([details.boundingBox(), trigger.boundingBox()])
    if (!detailsBox || !triggerBox) throw new Error("Usage click-menu geometry is unavailable")
    const viewport = page.viewportSize()
    if (!viewport) throw new Error("Storybook viewport is unavailable")
    expect(detailsBox.width).toBeLessThanOrEqual(301)
    expect(detailsBox.x).toBeGreaterThanOrEqual(7)
    expect(detailsBox.x + detailsBox.width).toBeLessThanOrEqual(viewport.width - 7)
    const centeredLeft = triggerBox.x + (triggerBox.width - detailsBox.width) / 2
    const expectedLeft = Math.min(Math.max(centeredLeft, 8), viewport.width - detailsBox.width - 8)
    expect(Math.abs(detailsBox.x - expectedLeft)).toBeLessThanOrEqual(2)
    expect(detailsBox.y + detailsBox.height).toBeLessThanOrEqual(triggerBox.y - 3)
    for (const card of await details.locator("li").all()) {
        const copy = card.locator("[data-reset-credit-copy]")
        const button = card.getByRole("button")
        const [cardBox, copyBox, buttonBox] = await Promise.all([card.boundingBox(), copy.boundingBox(), button.boundingBox()])
        if (!cardBox || !copyBox || !buttonBox) throw new Error("Reset card geometry is unavailable")
        expect(copyBox.x + copyBox.width).toBeLessThanOrEqual(buttonBox.x - 1)
        expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1)
    }
    await expect(page.locator('[data-usage-surface="preview"]')).toHaveCount(0)
    await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0)
    await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0)
    await expect(page.locator("[data-radix-popper-arrow-wrapper]")).toHaveCount(0)
    await expect.poll(() => visibleSurfaceCount(page)).toBe(1)

    await page.screenshot({ path: testInfo.outputPath("usage-click-details.png") })
})

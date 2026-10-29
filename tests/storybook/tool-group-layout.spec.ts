import { expect, type Locator, type Page, test } from "@playwright/test"

const readPath = "src/core/task/tools/handlers/ReadFileToolHandler.ts"

async function openExamples(page: Page, state = "completed") {
    const response = await page.goto(`/iframe.html?id=chat-tool-group-layout--${state}&viewMode=story`, {
        waitUntil: "domcontentloaded",
    })
    expect(response?.ok()).toBeTruthy()
    await expect(page.getByTestId("case-read").getByRole("button")).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
}

/** Measure the rendered characters, not merely a flex box whose text may be clipped. */
async function expectSuffixVisible(row: Locator, suffix: string) {
    await expect
        .poll(async () =>
            row.evaluate((element, text) => {
                const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
                let node = walker.nextNode()
                while (node) {
                    const offset = node.textContent?.indexOf(text) ?? -1
                    if (offset >= 0 && !node.parentElement?.closest('[aria-hidden="true"]')) {
                        const range = document.createRange()
                        range.setStart(node, offset)
                        range.setEnd(node, offset + text.length)
                        const rect = range.getBoundingClientRect()
                        const rowRect = element.getBoundingClientRect()
                        let parent = node.parentElement
                        let unclipped = rect.left >= rowRect.left - 1 && rect.right <= rowRect.right + 1
                        while (parent) {
                            const style = getComputedStyle(parent)
                            const box = parent.getBoundingClientRect()
                            if (["hidden", "clip", "auto", "scroll"].includes(style.overflowX)) {
                                unclipped &&= rect.left >= box.left - 1 && rect.right <= box.right + 1
                            }
                            parent = parent.parentElement
                        }
                        return unclipped && range.getClientRects().length === 1 && rect.height > 0
                    }
                    node = walker.nextNode()
                }
                return false
            }, suffix),
        )
        .toBe(true)
}

test("Tooltip uses 80% of the Webview viewport, including beyond the default responsive cap", async ({ page }) => {
    await openExamples(page)
    for (const width of [1280, 700, 360]) {
        await page.setViewportSize({ width, height: 900 })
        await page.getByTestId("case-read").getByRole("button").hover()
        const tooltip = page.locator('[data-slot="tooltip-content"]')
        await expect(tooltip).toBeVisible()
        await expect.poll(async () => Math.abs((await tooltip.boundingBox())!.width - width * 0.8)).toBeLessThan(2)
        const box = (await tooltip.boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(width)
        await expect(tooltip).toContainText(readPath)
        // Cross the hover grace area with real intermediate pointer moves.
        await page.mouse.move(width - 1, 899, { steps: 5 })
        await expect(tooltip).not.toBeVisible()
    }
})

test("tool rows use the full available parent width rather than 80%", async ({ page }) => {
    await openExamples(page)
    const row = page.getByTestId("case-read").getByRole("button")
    const widths = await row.evaluate((element) => ({
        row: element.getBoundingClientRect().width,
        parent: element.parentElement!.getBoundingClientRect().width,
    }))
    expect(Math.abs(widths.row - widths.parent)).toBeLessThan(2)
})

for (const state of ["completed", "active"]) {
    test(`${state}: fold directories, protect suffixes, show only metadata at minimum width, and restore`, async ({
        page,
    }, testInfo) => {
        await openExamples(page, state)
        const row = page.getByTestId("case-read").getByRole("button")
        await expect(row).toContainText(readPath)
        await page.setViewportSize({ width: 350, height: 900 })
        await expect.poll(() => row.innerText()).toContain("…/")
        await expect(row).toContainText("ReadFileToolHandler.ts")
        await expectSuffixVisible(row, "lines 125-416")
        await expectSuffixVisible(page.getByTestId("case-search").getByRole("button"), "300+ matches · 42 files")
        await expectSuffixVisible(page.getByTestId("case-refs").getByRole("button"), "12 refs · 3 files")
        await expectSuffixVisible(page.getByTestId("case-long-search").getByRole("button"), "27 matches · 5 files")
        await expectSuffixVisible(page.getByTestId("case-long-name").getByRole("button"), "lines 1-100")
        await page.screenshot({ path: testInfo.outputPath(`${state}-narrow.png`) })

        await page.setViewportSize({ width: 165, height: 900 })
        await expect.poll(() => row.innerText()).toBe("lines 125-416")
        await expect(row.locator("svg")).toHaveCount(0)
        await expectSuffixVisible(row, "lines 125-416")
        await row.screenshot({ path: testInfo.outputPath(`${state}-metadata-only.png`) })

        await page.setViewportSize({ width: 1280, height: 900 })
        await expect.poll(() => row.innerText()).toContain(readPath)
        await expectSuffixVisible(row, "lines 125-416")
        await expect(row.locator("svg")).toHaveCount(1)
        await page.screenshot({ path: testInfo.outputPath(`${state}-restored.png`) })
    })

    test(`${state}: every metadata type survives its own measured minimum and never overlaps the target`, async ({
        page,
    }, testInfo) => {
        await openExamples(page, state)
        for (const width of [700, 450, 350, 300]) {
            await page.setViewportSize({ width, height: 900 })
            for (const id of ["read", "search", "refs", "long-search", "long-name"]) {
                const row = page.getByTestId(`case-${id}`).getByRole("button")
                const suffix = row.locator('[data-tool-part="suffix"]')
                await expectSuffixVisible(row, (await suffix.textContent())!)
                await expect
                    .poll(() =>
                        row.evaluate((element) => {
                            const parts = [
                                ...element.querySelectorAll(
                                    '[data-tool-part="prefix"], [data-tool-part="path"], [data-tool-part="suffix"]',
                                ),
                            ]
                            const boxes = parts.map((part) => part.getBoundingClientRect())
                            return boxes.every((box, index) => index === 0 || boxes[index - 1].right <= box.left + 1)
                        }),
                    )
                    .toBe(true)
            }
        }

        // Different suffixes have different physical minima; do not assume one magic viewport fits them all.
        for (const id of ["read", "search", "refs", "long-search", "long-name"]) {
            const example = page.getByTestId(`case-${id}`)
            const row = example.getByRole("button")
            const suffixText = (await row.locator('[data-tool-part="suffix"]').textContent())!
            await example.evaluate((element) => {
                const button = element.querySelector("button")!
                const suffix = button.querySelector('[data-tool-part="suffix"]')!
                const outerSpacing = element.getBoundingClientRect().width - button.getBoundingClientRect().width
                element.style.width = `${outerSpacing + suffix.getBoundingClientRect().width + 2}px`
            })
            await expect.poll(() => row.innerText()).toBe(suffixText)
            await expect(row.locator("svg")).toHaveCount(0)
            await expect(row.locator('[data-tool-part="target"]')).toHaveCount(0)
            await expectSuffixVisible(row, suffixText)
        }
        await page.screenshot({ path: testInfo.outputPath(`${state}-all-metadata-minima.png`) })
        const noSuffix = page.getByTestId("case-no-suffix").getByRole("button")
        await expect(noSuffix.locator('[data-tool-part="path"]')).not.toBeEmpty()
    })
}

test("font changes remeasure text even when the row width remains unchanged", async ({ page }) => {
    await openExamples(page)
    await page.setViewportSize({ width: 450, height: 900 })
    const row = page.getByTestId("case-read").getByRole("button")
    const path = row.locator('[data-tool-part="path"]')
    await expect(path).toHaveText(readPath)
    const before = (await row.boundingBox())!.width
    await row.evaluate((element) => {
        element.style.fontFamily = "monospace"
        element.style.letterSpacing = "2px"
    })
    await expect(path).not.toHaveText(readPath)
    await expectSuffixVisible(row, "lines 125-416")
    expect((await row.boundingBox())!.width).toBeCloseTo(before, 1)
    await row.evaluate((element) => {
        element.style.fontFamily = ""
        element.style.letterSpacing = ""
    })
    await expect(path).toHaveText(readPath)
})

test("active long-text Tooltip wraps, remains hoverable and retains selectable full text", async ({ page }) => {
    await openExamples(page, "active")
    await page.setViewportSize({ width: 360, height: 900 })
    const row = page.getByTestId("case-long-search").getByRole("button")
    const fullText = await row.getAttribute("aria-label")
    await row.hover()
    const tooltip = page.locator('[data-slot="tooltip-content"]')
    await expect(tooltip).toBeVisible()
    await expect.poll(async () => Math.abs((await tooltip.boundingBox())!.width - 288)).toBeLessThan(2)
    const content = tooltip.locator(":scope > span").first().locator(":scope > span").first()
    await content.hover()
    await expect(tooltip).toBeVisible()
    const selection = await content.evaluate((element) => {
        const range = document.createRange()
        range.selectNodeContents(element)
        const selected = window.getSelection()!
        selected.removeAllRanges()
        selected.addRange(range)
        return {
            text: selected.toString(),
            userSelect: getComputedStyle(element).userSelect,
            lines: range.getClientRects().length,
        }
    })
    expect(selection.text).toBe(fullText)
    expect(selection.userSelect).toBe("text")
    expect(selection.lines).toBeGreaterThan(1)
    expect(await tooltip.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
})

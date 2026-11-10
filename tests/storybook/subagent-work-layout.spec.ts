import { expect, type Locator, test } from "@playwright/test"

async function textFitsScrollRegion(scroll: Locator, selector: string, end = false) {
    return scroll.evaluate(
        (element, options) => {
            const targets = element.querySelectorAll(options.selector)
            const target = options.end ? targets[targets.length - 1] : targets[0]
            const text = target?.firstChild
            if (!text || text.nodeType !== Node.TEXT_NODE || !text.textContent) return false
            const length = text.textContent.length
            const range = document.createRange()
            range.setStart(text, options.end ? Math.max(0, length - 8) : 0)
            range.setEnd(text, options.end ? length : Math.min(8, length))
            const ink = range.getBoundingClientRect()
            const clip = element.getBoundingClientRect()
            const card = element.closest('[data-testid="subagent-item"]')!.getBoundingClientRect()
            return ink.height > 0 && ink.top >= clip.top - 1 && ink.bottom <= clip.bottom + 1 && clip.bottom <= card.bottom + 1
        },
        { selector, end },
    )
}

for (const size of [
    { width: 360, height: 480 },
    { width: 960, height: 900 },
]) {
    for (const story of ["short-task-and-long-tools", "long-task-and-tools"]) {
        test(`${story} at ${size.width}x${size.height} keeps expanded Task and Tools readable`, async ({ page }) => {
            await page.setViewportSize(size)
            await page.goto(`/iframe.html?id=chat-subagent-work-card--${story}&viewMode=story`)
            const card = page.getByTestId("subagent-item")
            await card.getByRole("button", { name: /^Expand subagent / }).click()
            await expect(card.getByTestId("subagent-tool-step")).toHaveCount(80)
            const task = card.getByTestId("subagent-task-scroll")
            const tools = card.getByTestId("subagent-tools-scroll")
            await test.info().attach("initial-work-regions", {
                body: JSON.stringify(
                    await card.evaluate((element) =>
                        Array.from(element.querySelectorAll<HTMLElement>("[data-testid$='-scroll']"), (region) => ({
                            id: region.dataset.testid,
                            height: region.clientHeight,
                            scrollHeight: region.scrollHeight,
                            bounds: region.getBoundingClientRect().toJSON(),
                        })),
                    ),
                ),
                contentType: "application/json",
            })
            await expect(card.getByRole("button", { name: "Collapse subagent task" })).toHaveAttribute("aria-expanded", "true")
            await expect(card.getByRole("button", { name: "Collapse subagent tools" })).toHaveAttribute("aria-expanded", "true")
            expect(await textFitsScrollRegion(task, "h4")).toBe(true)
            expect(await textFitsScrollRegion(tools, '[data-testid="subagent-tool-step-name"]')).toBe(true)

            const taskTop = await task.evaluate((element) => element.scrollTop)
            await tools.hover()
            await page.mouse.wheel(0, 500)
            await expect.poll(() => tools.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
            expect(await task.evaluate((element) => element.scrollTop)).toBe(taskTop)
            expect(await textFitsScrollRegion(task, "h4")).toBe(true)

            if (story === "long-task-and-tools") {
                await task.evaluate((element) => {
                    // The context control follows the heading; the region bottom is not the task's last line.
                    const heading = element.querySelector("h4")!
                    element.scrollTop += heading.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom
                })
                expect(await task.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
                expect(await textFitsScrollRegion(task, "h4", true)).toBe(true)
                await task.evaluate((element) => {
                    element.scrollTop = 0
                })
            }
            await tools.evaluate((element) => {
                element.scrollTop = 0
            })
            await card.getByRole("button", { name: "Show subagent output" }).click()
            const output = card.getByTestId("subagent-output-scroll")
            expect(await textFitsScrollRegion(task, "h4")).toBe(true)
            expect(await textFitsScrollRegion(tools, '[data-testid="subagent-tool-step-name"]')).toBe(true)
            expect(await output.evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(18)

            await card.getByRole("button", { name: "Collapse subagent tools" }).click()
            expect(await textFitsScrollRegion(task, "h4")).toBe(true)
            await expect(card.getByRole("button", { name: "Collapse subagent task" })).toHaveAttribute("aria-expanded", "true")
            await card.getByRole("button", { name: "Expand subagent tools" }).click()
            expect(await textFitsScrollRegion(task, "h4")).toBe(true)
            expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
        })
    }
}

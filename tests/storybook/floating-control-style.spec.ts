import { expect, type Locator, test } from "@playwright/test"

async function surface(locator: Locator) {
    return locator.evaluate((element) => {
        const style = getComputedStyle(element)
        const canvas = document.createElement("canvas")
        canvas.width = canvas.height = 1
        const context = canvas.getContext("2d")
        if (!context) throw new Error("Canvas 2D context is unavailable.")
        context.fillStyle = style.backgroundColor
        context.fillRect(0, 0, 1, 1)
        return {
            color: style.backgroundColor,
            blur: style.backdropFilter,
            alpha: context.getImageData(0, 0, 1, 1).data[3] / 255,
        }
    })
}

for (const width of [380, 1280]) {
    test(`floating surfaces and checkpoint actions remain aligned at ${width}px without changing scroll behavior`, async ({
        page,
    }) => {
        await page.setViewportSize({ width, height: 1100 })
        await page.goto("/iframe.html?id=chat-folding-and-trajectory--message-segments&viewMode=story")
        const fixture = page.getByTestId("folding-trajectory-fixture")
        const scroller = fixture.locator("[data-virtuoso-scroller]")
        await expect(scroller).toBeVisible()
        // Establish the style fixture with real user input; initial auto-restoration is a separate regression.
        await scroller.hover({ position: { x: 5, y: 100 } })
        await page.mouse.wheel(0, 100_000)
        await expect
            .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
            .toBeLessThanOrEqual(10)
        await page.getByRole("button", { name: "Expand all", exact: true }).click()
        await scroller.hover({ position: { x: 5, y: 100 } })
        await page.mouse.wheel(0, -100_000)
        await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThan(1)
        const top = fixture.getByRole("button", { name: "Scroll to top", exact: true })
        await expect(top).toBeVisible()
        await top.click()
        await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThan(1)
        await expect(top).toBeVisible()

        const rail = fixture.getByRole("navigation", { name: "Conversation trajectory" })
        const railSurface = await surface(rail)
        expect(railSurface.alpha).toBeCloseTo(0.35, 2)
        expect(railSurface.blur).toBe("blur(8px)")
        const fold = fixture.getByTestId("folding-controls").getByRole("button")
        for (const control of [top, fold]) {
            await control.hover()
            expect(await surface(control)).toEqual(railSurface)
        }

        const checkpoint = fixture.getByText("Checkpoint", { exact: true }).first().locator("..")
        await checkpoint.hover()
        const compare = checkpoint.getByRole("button", { name: "Compare", exact: true })
        const restore = checkpoint.getByRole("button", { name: "Restore", exact: true })
        for (const action of [compare, restore]) {
            await expect(action).toBeVisible()
            const railLeft = await rail.evaluate((element) => element.getBoundingClientRect().left)
            expect(await action.evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(railLeft - 8)
            expect(
                await action.evaluate((element) => {
                    const bounds = element.getBoundingClientRect()
                    const target = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
                    return element === target || element.contains(target)
                }),
            ).toBe(true)
            await action.click({ trial: true })
        }
        await restore.click()
        await expect(page.getByRole("button", { name: /Restore.*Task/i }).first()).toBeVisible()
        await restore.click()

        await scroller.hover({ position: { x: 5, y: 100 } })
        await page.mouse.wheel(0, 200)
        const bottom = fixture.getByRole("button", { name: "Scroll to bottom", exact: true })
        await expect(bottom).toBeVisible()
        await bottom.hover()
        expect(await surface(bottom)).toEqual(railSurface)
        await bottom.click()
        await expect
            .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
            .toBeLessThanOrEqual(10)
        await expect(fixture.getByRole("button", { name: /^Scroll to (top|bottom)$/ })).toHaveCount(0)
    })
}

async function floatingPresentation(control: Locator) {
    return control.evaluate((element) => {
        const style = getComputedStyle(element)
        const bounds = element.getBoundingClientRect()
        const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
        return { opacity: style.opacity, pointerEvents: style.pointerEvents, hit: element === hit || element.contains(hit) }
    })
}

for (const direction of ["top", "bottom"] as const) {
    test(`scroll reveals the whole floating group without message hover with the ${direction} action`, async ({ page }) => {
        await page.goto("/iframe.html?id=chat-folding-and-trajectory--message-segments&viewMode=story")
        const fixture = page.getByTestId("folding-trajectory-fixture")
        const scroller = fixture.locator("[data-virtuoso-scroller]")
        await expect(scroller).toBeVisible()
        await scroller.hover({ position: { x: 5, y: 100 } })
        await page.mouse.wheel(0, 100_000)
        await expect
            .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
            .toBeLessThanOrEqual(10)
        await page.mouse.wheel(0, -100_000)
        await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThan(1)
        await page.mouse.wheel(0, 200)
        await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(100)
        if (direction === "top") await page.mouse.wheel(0, -50)

        const scroll = fixture.getByRole("button", { name: `Scroll to ${direction}`, exact: true })
        await expect(scroll).toBeVisible()
        const rail = fixture.getByRole("navigation", { name: "Conversation trajectory" })
        const controls = [rail, fixture.getByTestId("folding-controls"), scroll.locator("..")]
        const shown = { opacity: "1", pointerEvents: "auto", hit: true }
        const hidden = { opacity: "0", pointerEvents: "none", hit: false }
        for (const control of controls) await expect(control).toHaveCSS("opacity", "1")

        // Resting over the messages must not keep the overlays visible after scrolling stops.
        for (const control of controls) await expect(control).toHaveCSS("opacity", "0")
        await scroller.hover({ position: { x: 5, y: 100 } })
        await page.waitForTimeout(1300) // Samples the idle visibility contract, not business completion.
        for (const control of controls) expect(await floatingPresentation(control)).toEqual(hidden)

        const before = await scroller.evaluate((element) => element.scrollTop)
        await page.mouse.wheel(0, direction === "top" ? -50 : 150)
        await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).not.toBe(before)
        for (const control of controls) await expect(control).toHaveCSS("opacity", "1")
        await page.mouse.move(1100, 850)
        for (const control of controls) expect(await floatingPresentation(control)).toEqual(shown)

        // Only the revealed controls, not the whole chat, retain pointer use.
        await scroll.hover()
        await page.waitForTimeout(1300)
        for (const control of controls) expect(await floatingPresentation(control)).toEqual(shown)

        const firstBar = rail.getByTestId("trajectory-turn").first()
        await firstBar.hover()
        const preview = fixture.getByTestId("trajectory-turn-preview")
        await expect(preview).toBeVisible()
        const railBounds = await rail.boundingBox()
        const foldBounds = await fixture.getByTestId("folding-controls").boundingBox()
        await preview.hover()
        await page.waitForTimeout(1300) // Preview interaction must outlast both the hold and fade.
        await expect(preview).toBeVisible()
        for (const control of controls) expect(await floatingPresentation(control)).toEqual(shown)
        expect((await floatingPresentation(preview)).hit).toBe(true)
        expect(await rail.boundingBox()).toEqual(railBounds)
        expect(await fixture.getByTestId("folding-controls").boundingBox()).toEqual(foldBounds)

        await page.mouse.move(1100, 850)
        await expect(preview).toHaveCount(0)
        for (const control of controls) await expect(control).toHaveCSS("opacity", "0")
        for (const control of controls) expect(await floatingPresentation(control)).toEqual(hidden)

        // Keyboard focus must still reveal the entire group while the pointer remains outside the chat.
        await page.keyboard.press("Tab")
        const bar = rail.getByTestId("trajectory-turn").first()
        await bar.focus()
        expect(await bar.evaluate((element) => element.matches(":focus-visible"))).toBe(true)
        for (const control of controls) {
            await expect(control).toHaveCSS("opacity", "1")
            expect(await floatingPresentation(control)).toEqual(shown)
        }
    })
}

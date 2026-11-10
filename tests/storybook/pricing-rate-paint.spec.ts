import { expect, type Locator, test } from "@playwright/test"
import sharp from "sharp"

type Rgb = readonly [number, number, number]

async function pixels(locator: Locator) {
    return sharp(await locator.screenshot())
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
}

async function centerColor(locator: Locator): Promise<Rgb> {
    const { data, info } = await pixels(locator)
    const offset = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 3
    return [data[offset], data[offset + 1], data[offset + 2]]
}

async function matchingPixels(locator: Locator, color: Rgb) {
    const { data } = await pixels(locator)
    let matches = 0
    for (let offset = 0; offset < data.length; offset += 3) {
        if (color.every((channel, index) => Math.abs(data[offset + index] - channel) <= 1)) matches++
    }
    return matches
}

const themes = [
    { name: "translucent", orange: "#a2451a80", rgb: [162, 69, 26] as Rgb, alpha: 128 / 255 },
    { name: "opaque", orange: "#d18616", rgb: [209, 134, 22] as Rgb, alpha: 1 },
]

for (const width of [320, 960]) {
    for (const theme of themes) {
        test(`peak labels match the painted timeline in the ${theme.name} theme at ${width}px`, async ({ page }) => {
            await page.goto("/iframe.html?id=settings-providers-deepseekoffpeakpricing--weekday&viewMode=story")
            const card = page.getByText("DeepSeek", { exact: true }).locator("..")
            await card.evaluate(
                (element, options) => {
                    element.style.width = `${options.width}px`
                    element.style.backgroundColor = "#242424"
                    element.style.setProperty("--vscode-charts-orange", options.orange)
                    element.style.setProperty("--vscode-charts-green", "#89d185")
                },
                { width, orange: theme.orange },
            )
            const bar = page.locator('[data-rate-kind="peak"]').first()
            const heading = page.getByRole("region", { name: /^Peak window/ }).getByRole("heading", { level: 3 })
            const legend = page.getByText("Peak rates", { exact: true })
            const painted = await centerColor(bar)
            // Preserve the pre-existing SVG: a 45% green track, then the declared peak color.
            const expected = theme.rgb.map((channel, index) => {
                const underlay = [137, 209, 133][index] * 0.45 + 36 * 0.55
                return Math.round(channel * theme.alpha + underlay * (1 - theme.alpha))
            })
            expect(painted.every((channel, index) => Math.abs(channel - expected[index]) <= 1)).toBe(true)
            expect(await matchingPixels(heading, painted)).toBeGreaterThan(3)
            expect(await matchingPixels(legend, painted)).toBeGreaterThan(3)

            if (width === 960 && theme.name === "translucent") {
                // Equal CSS color declarations alone were the original broken rendering.
                await heading.evaluate((element, orange) => {
                    element.style.backgroundImage = "none"
                    element.style.color = orange
                }, theme.orange)
                expect(await matchingPixels(heading, painted)).toBe(0)
            }
        })
    }
}

test("peak labels remain readable when forced colors suppress background images", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" })
    await page.goto("/iframe.html?id=settings-providers-deepseekoffpeakpricing--weekday&viewMode=story")
    for (const label of [
        page.getByRole("region", { name: /^Peak window/ }).getByRole("heading", { level: 3 }),
        page.getByText("Peak rates", { exact: true }),
    ]) {
        await expect(label).toBeVisible()
        const style = await label.evaluate((element) => ({
            color: getComputedStyle(element).color,
            image: getComputedStyle(element).backgroundImage,
        }))
        expect(style.image).toBe("none")
        const [red, green, blue] = style.color.match(/\d+/g) ?? []
        expect(await matchingPixels(label, [Number(red), Number(green), Number(blue)])).toBeGreaterThan(3)
    }
})

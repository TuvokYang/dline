import { expect, type Page } from "@playwright/test"

const WORKBENCH_WIDTH = 1_200
const WORKBENCH_HEIGHT = 900
const SIDEBAR_RESIZE_TOLERANCE = 4

/**
 * Resizes the real VS Code primary sidebar through its workbench sash.
 * Changing only the Electron viewport does not change the sidebar width.
 */
export async function resizePrimarySidebar(page: Page, targetWidth: number): Promise<number> {
    await page.setViewportSize({ width: WORKBENCH_WIDTH, height: WORKBENCH_HEIGHT })

    const primarySidebar = page.locator('[id="workbench.parts.sidebar"]')
    await expect(primarySidebar).toBeVisible()
    const initialBox = await primarySidebar.boundingBox()
    if (!initialBox) throw new Error("VS Code primary sidebar does not have a bounding box")

    const sidebarRight = initialBox.x + initialBox.width
    const verticalSashes = page.locator(".monaco-sash.vertical")
    let nearestSash: { x: number; y: number; width: number; height: number } | undefined
    let nearestDistance = Number.POSITIVE_INFINITY
    for (let index = 0; index < (await verticalSashes.count()); index += 1) {
        const box = await verticalSashes.nth(index).boundingBox()
        if (!box || box.height < 100) continue
        const distance = Math.abs(box.x + box.width / 2 - sidebarRight)
        if (distance < nearestDistance) {
            nearestDistance = distance
            nearestSash = box
        }
    }
    if (!nearestSash || nearestDistance > 8) {
        throw new Error("Could not locate the VS Code primary sidebar resize sash")
    }

    const resizeY = nearestSash.y + Math.min(240, nearestSash.height / 2)
    await page.mouse.move(nearestSash.x + nearestSash.width / 2, resizeY)
    await page.mouse.down()
    await page.mouse.move(initialBox.x + targetWidth, resizeY, { steps: 20 })
    await page.mouse.up()

    await expect
        .poll(
            async () => {
                const resizedBox = await primarySidebar.boundingBox()
                return resizedBox ? Math.abs(resizedBox.width - targetWidth) : Number.POSITIVE_INFINITY
            },
            { message: `VS Code primary sidebar should resize to ${targetWidth}px`, timeout: 5_000 },
        )
        .toBeLessThanOrEqual(SIDEBAR_RESIZE_TOLERANCE)

    const resizedBox = await primarySidebar.boundingBox()
    if (!resizedBox) throw new Error("VS Code primary sidebar disappeared after resize")
    return resizedBox.width
}

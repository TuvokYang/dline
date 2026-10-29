import { writeFile } from "node:fs/promises"
import type { Page } from "@playwright/test"
import sharp from "sharp"
import { E2ETestHelper } from "../../utils/helpers"

const TARGET_PNG_WIDTH = 1_200
const MAX_PNG_BYTES = 500_000

export interface DemoPngAsset {
    width: number
    height: number
    bytes: number
}

export async function dismissDemoNotifications(page: Page): Promise<void> {
    const notifications = page.locator(".notifications-toasts.visible .notification-toast")
    for (let attempt = 0; attempt < 8; attempt += 1) {
        if ((await notifications.count()) === 0) return

        const notification = notifications.first()
        await notification.hover()
        const clearButton = notification.locator(".codicon-notifications-clear")
        if ((await clearButton.count()) > 0 && (await clearButton.isVisible())) {
            await clearButton.click()
            await page.waitForTimeout(100)
            continue
        }

        await E2ETestHelper.runCommandPalette(page, "Notifications: Clear All Notifications")
        await page.waitForTimeout(250)
    }

    throw new Error("VS Code notifications remained visible before the demo screenshot")
}

export async function finalizeDemoPng(screenshotPath: string): Promise<DemoPngAsset> {
    const { data, info } = await sharp(screenshotPath)
        .resize({ width: TARGET_PNG_WIDTH })
        .png({
            compressionLevel: 9,
            adaptiveFiltering: true,
            palette: true,
            quality: 100,
            colours: 256,
            dither: 0.5,
            effort: 10,
        })
        .toBuffer({ resolveWithObject: true })

    await writeFile(screenshotPath, data)
    if (info.width !== TARGET_PNG_WIDTH) {
        throw new Error(`Demo PNG width is ${info.width}, expected ${TARGET_PNG_WIDTH}`)
    }
    if (data.byteLength > MAX_PNG_BYTES) {
        throw new Error(`Demo PNG is ${data.byteLength} bytes, exceeding ${MAX_PNG_BYTES}`)
    }

    return { width: info.width, height: info.height, bytes: data.byteLength }
}

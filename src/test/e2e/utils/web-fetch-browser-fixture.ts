import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { type BrowserSettings, DEFAULT_BROWSER_SETTINGS } from "@shared/BrowserSettings"
// @ts-expect-error puppeteer-chromium-resolver does not publish TypeScript declarations.
import PCR from "puppeteer-chromium-resolver"
import { E2ETestHelper, e2e } from "./helpers"

/** Download outside the test budget so mirror latency does not consume its behavior timeout. */
const WEB_FETCH_CHROMIUM_SEED_TIMEOUT_MS = 600_000

async function downloadChromiumSeed(seedDir: string): Promise<string> {
    const download = async (): Promise<void> => {
        await mkdir(seedDir, { recursive: true })
        const stats = await PCR({ downloadPath: seedDir })
        await access(stats.executablePath)
    }
    try {
        await download()
    } catch {
        await rm(seedDir, { recursive: true, force: true })
        await download()
    }
    return seedDir
}

export const webFetchE2e = e2e.extend<Record<never, never>, { webFetchChromiumSeed: string }>({
    webFetchChromiumSeed: [
        async ({}, use, workerInfo) => {
            const seedDir = path.join(E2ETestHelper.PUPPETEER_CACHE_DIR, `worker-${workerInfo.workerIndex}`)
            await use(await downloadChromiumSeed(seedDir))
        },
        { scope: "worker", timeout: WEB_FETCH_CHROMIUM_SEED_TIMEOUT_MS },
    ],
})

export async function prepareWebFetchBrowser(dlineDir: string, dlineHomeDir: string, seedDir: string): Promise<void> {
    const testPuppeteerDir = path.join(dlineHomeDir, "puppeteer")
    await rm(testPuppeteerDir, { recursive: true, force: true })
    await cp(seedDir, testPuppeteerDir, { recursive: true })

    const file = path.join(dlineDir, "data", "settings", "settings.json")
    const settings = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    const browserSettings = (settings.browserSettings ?? {}) as Partial<BrowserSettings>
    settings.browserSettings = {
        ...DEFAULT_BROWSER_SETTINGS,
        ...browserSettings,
        viewport: {
            ...DEFAULT_BROWSER_SETTINGS.viewport,
            ...browserSettings.viewport,
        },
        customArgs: "--no-sandbox",
    } satisfies BrowserSettings
    await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

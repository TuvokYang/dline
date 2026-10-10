import type { Browser } from "puppeteer-core"
import { StateManager } from "@/core/storage/StateManager"
import { ensureChromiumExists } from "@/services/browser/utils"

export interface BrowserSearchPageLoader {
    load(url: string): Promise<string>
}

/** Load one search page in an isolated browser lifecycle. */
export class PuppeteerBrowserSearchPageLoader implements BrowserSearchPageLoader {
    async load(url: string): Promise<string> {
        let browser: Browser | undefined
        try {
            const stats = await ensureChromiumExists()
            const browserSettings = StateManager.get().getGlobalSettingsKey("browserSettings")
            const customArgs = browserSettings.customArgs?.trim().split(/\s+/).filter(Boolean) ?? []
            browser = await stats.puppeteer.launch({
                args: [
                    "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
                    ...customArgs,
                ],
                executablePath: stats.executablePath,
            })
            const page = await browser.newPage()
            await page.goto(url, { timeout: 15_000, waitUntil: ["domcontentloaded", "networkidle2"] })
            return await page.content()
        } finally {
            await browser?.close()
        }
    }
}

import type { Browser } from "puppeteer-core"
import { StateManager } from "@/core/storage/StateManager"
import { ensureChromiumExists } from "@/services/browser/utils"

/**
 * One fetched search page.
 *
 * `status` is the HTTP status of the navigation, or 0 when the navigation
 * produced no HTTP response. Providers need it because a search engine can
 * answer a refused client with a non-error status and a challenge document:
 * without the status a challenge page is indistinguishable from a page that
 * genuinely matched nothing.
 */
export interface BrowserSearchPage {
    readonly html: string
    readonly status: number
}

export interface BrowserSearchPageLoader {
    load(url: string): Promise<BrowserSearchPage>
}

/** Load one search page in an isolated browser lifecycle. */
export class PuppeteerBrowserSearchPageLoader implements BrowserSearchPageLoader {
    async load(url: string): Promise<BrowserSearchPage> {
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
            const response = await page.goto(url, { timeout: 15_000, waitUntil: ["domcontentloaded", "networkidle2"] })
            return { html: await page.content(), status: response?.status() ?? 0 }
        } finally {
            await browser?.close()
        }
    }
}

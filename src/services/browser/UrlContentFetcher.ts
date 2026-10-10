import * as cheerio from "cheerio"
import { Browser, Page } from "puppeteer-core"
import TurndownService from "turndown"
import { StateManager } from "@/core/storage/StateManager"
import { ensureChromiumExists } from "./utils"

const WEB_FETCH_NAVIGATION_TIMEOUT_MS = 30_000

function abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new Error("Browser operation was cancelled")
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw abortError(signal)
    }
}

function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise
    if (signal.aborted) return Promise.reject(abortError(signal))
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(abortError(signal))
        signal.addEventListener("abort", onAbort, { once: true })
        promise.then(
            (value) => {
                signal.removeEventListener("abort", onAbort)
                resolve(value)
            },
            (error: unknown) => {
                signal.removeEventListener("abort", onAbort)
                reject(error)
            },
        )
    })
}

export class UrlContentFetcher {
    private browser?: Browser
    private page?: Page
    private closePromise?: Promise<void>
    private abortSignal?: AbortSignal
    private abortListener?: () => void

    async launchBrowser(signal?: AbortSignal): Promise<void> {
        throwIfAborted(signal)
        if (this.browser) {
            this.bindAbortSignal(signal)
            return
        }
        const stats = await waitForAbort(ensureChromiumExists(), signal)
        throwIfAborted(signal)
        // Read browser settings from globalState for custom args only
        const browserSettings = StateManager.get().getGlobalSettingsKey("browserSettings")
        const customArgsStr = browserSettings.customArgs || ""
        const customArgs = customArgsStr.trim() ? customArgsStr.split(/\s+/) : []
        const launchPromise = stats.puppeteer.launch({
            args: [
                "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
                ...customArgs, // Append user-provided custom arguments
            ],
            executablePath: stats.executablePath,
        })
        let browser: Browser
        try {
            browser = await waitForAbort(launchPromise, signal)
        } catch (error) {
            if (signal?.aborted) {
                void launchPromise.then((lateBrowser) => lateBrowser.close()).catch(() => undefined)
            }
            throw error
        }
        if (signal?.aborted) {
            await browser.close().catch(() => undefined)
            throw abortError(signal)
        }
        this.browser = browser
        this.bindAbortSignal(signal)
        try {
            // The latest Puppeteer no longer adds "Headless" to the user agent.
            this.page = await waitForAbort(browser.newPage(), signal)
        } catch (error) {
            await this.closeBrowser().catch(() => undefined)
            throw error
        }
    }

    async closeBrowser(): Promise<void> {
        this.detachAbortSignal()
        if (this.closePromise) {
            await this.closePromise
            return
        }
        const browser = this.browser
        this.browser = undefined
        this.page = undefined
        if (!browser) return

        const closePromise = browser.close()
        this.closePromise = closePromise
        try {
            await closePromise
        } finally {
            if (this.closePromise === closePromise) {
                this.closePromise = undefined
            }
        }
    }

    // must make sure to call launchBrowser before and closeBrowser after using this
    async urlToMarkdown(url: string, signal?: AbortSignal): Promise<string> {
        throwIfAborted(signal)
        this.bindAbortSignal(signal)
        const page = this.page
        if (!this.browser || !page) {
            throw new Error("Browser not initialized")
        }
        /*
		- networkidle2 is equivalent to playwright's networkidle where it waits until there are no more than 2 network connections for at least 500 ms.
		- domcontentloaded is when the basic DOM is loaded
		this should be sufficient for most doc sites
		*/
        await waitForAbort(
            page.goto(url, {
                timeout: WEB_FETCH_NAVIGATION_TIMEOUT_MS,
                waitUntil: ["domcontentloaded", "networkidle2"],
            }),
            signal,
        )
        throwIfAborted(signal)
        const content = await waitForAbort(page.content(), signal)

        // use cheerio to parse and clean up the HTML
        const $ = cheerio.load(content)
        $("script, style, nav, footer, header").remove()

        // convert cleaned HTML to markdown
        const turndownService = new TurndownService()
        const markdown = turndownService.turndown($.html())

        return markdown
    }

    private bindAbortSignal(signal?: AbortSignal): void {
        if (!signal || this.abortSignal === signal) return
        this.detachAbortSignal()
        this.abortSignal = signal
        this.abortListener = () => {
            void this.closeBrowser().catch(() => undefined)
        }
        signal.addEventListener("abort", this.abortListener, { once: true })
        if (signal.aborted) {
            this.abortListener()
        }
    }

    private detachAbortSignal(): void {
        if (this.abortSignal && this.abortListener) {
            this.abortSignal.removeEventListener("abort", this.abortListener)
        }
        this.abortSignal = undefined
        this.abortListener = undefined
    }
}

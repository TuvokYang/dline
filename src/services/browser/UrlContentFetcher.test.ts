import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const browserMocks = vi.hoisted(() => {
    const goto = vi.fn(async () => null)
    const content = vi.fn(async () => "<main><h1>Dline</h1><p>Fetched locally</p></main>")
    const newPage = vi.fn(async () => ({ goto, content }))
    const close = vi.fn(async () => undefined)
    const launch = vi.fn(async () => ({ newPage, close }))
    return { goto, content, newPage, close, launch }
})

vi.mock("@/core/storage/StateManager", () => ({
    StateManager: {
        get: () => ({
            getGlobalSettingsKey: () => ({ customArgs: "" }),
        }),
    },
}))

vi.mock("./utils", () => ({
    ensureChromiumExists: vi.fn(async () => ({
        executablePath: "mock-chromium",
        puppeteer: { launch: browserMocks.launch },
    })),
}))

import { UrlContentFetcher } from "./UrlContentFetcher"

describe("UrlContentFetcher", () => {
    let fetcher: UrlContentFetcher

    beforeEach(() => {
        vi.clearAllMocks()
        fetcher = new UrlContentFetcher()
    })

    afterEach(async () => {
        await fetcher.closeBrowser()
    })

    it("allows page navigation to run for up to 30 seconds", async () => {
        const url = "https://example.test/slow-documentation"

        await fetcher.launchBrowser()
        await expect(fetcher.urlToMarkdown(url)).resolves.toContain("Dline")

        expect(browserMocks.goto).toHaveBeenCalledWith(url, {
            timeout: 30_000,
            waitUntil: ["domcontentloaded", "networkidle2"],
        })
    })
})

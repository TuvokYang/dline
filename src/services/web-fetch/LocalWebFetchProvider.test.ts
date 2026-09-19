import { describe, expect, it, vi } from "vitest"
import { BrowserWebFetchProvider, type UrlContentFetcherPort } from "./LocalWebFetchProvider"

function contentFetcher(markdown = "# Dline\n\nFetched locally") {
	return {
		launchBrowser: vi.fn(async (_signal?: AbortSignal) => undefined),
		urlToMarkdown: vi.fn(async (_url: string, _signal?: AbortSignal) => markdown),
		closeBrowser: vi.fn(async () => undefined),
	} satisfies UrlContentFetcherPort
}

describe("BrowserWebFetchProvider", () => {
	it("fetches cleaned Markdown locally and reports the Dline execution source", async () => {
		const fetcher = contentFetcher()
		const provider = new BrowserWebFetchProvider(() => fetcher)

		await expect(
			provider.fetch({
				url: "https://example.test/docs",
				prompt: "Extract the release notes",
			}),
		).resolves.toEqual({
			url: "https://example.test/docs",
			prompt: "Extract the release notes",
			content: "# Dline\n\nFetched locally",
			source: {
				id: "browser",
				label: "Browser Web Fetch",
				execution: "dline",
			},
		})
		expect(fetcher.launchBrowser).toHaveBeenCalledOnce()
		expect(fetcher.launchBrowser.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal)
		expect(fetcher.urlToMarkdown).toHaveBeenCalledWith("https://example.test/docs", expect.any(AbortSignal))
		expect(fetcher.closeBrowser).toHaveBeenCalledOnce()
	})

	it("closes the browser when page retrieval fails and preserves the actionable error", async () => {
		const fetcher = contentFetcher()
		fetcher.urlToMarkdown.mockRejectedValueOnce(new Error("Navigation timed out"))
		const provider = new BrowserWebFetchProvider(() => fetcher)

		await expect(provider.fetch({ url: "https://example.test/slow", prompt: "Read the page" })).rejects.toThrow(
			"Navigation timed out",
		)
		expect(fetcher.closeBrowser).toHaveBeenCalledOnce()
	})

	it("enforces the total fetch budget and closes the browser", async () => {
		const fetcher = contentFetcher()
		fetcher.launchBrowser.mockImplementationOnce(() => new Promise(() => undefined))
		const provider = new BrowserWebFetchProvider(() => fetcher)

		await expect(
			provider.fetch({ url: "https://example.test/cold", prompt: "Read the page", timeoutMs: 10 }),
		).rejects.toThrow("Web fetch timed out after 1 seconds")
		expect(fetcher.closeBrowser).toHaveBeenCalledOnce()
	})

	it("includes browser cleanup in the total fetch budget", async () => {
		vi.useFakeTimers()
		try {
			const fetcher = contentFetcher()
			fetcher.closeBrowser.mockImplementationOnce(() => new Promise(() => undefined))
			const provider = new BrowserWebFetchProvider(() => fetcher)
			const fetching = provider.fetch({
				url: "https://example.test/cleanup",
				prompt: "Read the page",
				timeoutMs: 10,
			})

			const rejection = expect(fetching).rejects.toThrow("Web fetch timed out after 1 seconds")
			await vi.advanceTimersByTimeAsync(10)
			await rejection
			expect(fetcher.closeBrowser).toHaveBeenCalledOnce()
		} finally {
			vi.useRealTimers()
		}
	})

	it("forwards external cancellation and closes the browser", async () => {
		const fetcher = contentFetcher()
		fetcher.urlToMarkdown.mockImplementationOnce(() => new Promise(() => undefined))
		const provider = new BrowserWebFetchProvider(() => fetcher)
		const controller = new AbortController()
		const fetching = provider.fetch({
			url: "https://example.test/restore",
			prompt: "Read the page",
			signal: controller.signal,
		})

		controller.abort(new Error("checkpoint_restore"))

		await expect(fetching).rejects.toThrow("checkpoint_restore")
		expect(fetcher.closeBrowser).toHaveBeenCalledOnce()
	})
})

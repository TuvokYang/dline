import { UrlContentFetcher } from "@/services/browser/UrlContentFetcher"

export interface UrlContentFetcherPort {
	launchBrowser(signal?: AbortSignal): Promise<void>
	urlToMarkdown(url: string, signal?: AbortSignal): Promise<string>
	closeBrowser(): Promise<void>
}

export interface LocalWebFetchRequest {
	readonly url: string
	readonly prompt: string
	readonly signal?: AbortSignal
	readonly timeoutMs?: number
}

export interface LocalWebFetchResponse {
	readonly url: string
	readonly prompt: string
	readonly content: string
	readonly source: {
		readonly id: "browser"
		readonly label: "Browser Web Fetch"
		readonly execution: "dline"
	}
}

export interface LocalWebFetchProvider {
	fetch(request: LocalWebFetchRequest): Promise<LocalWebFetchResponse>
}

const DEFAULT_WEB_FETCH_TIMEOUT_MS = 30_000

interface FetchCancellationScope {
	readonly signal: AbortSignal
	dispose(): void
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Web fetch operation was cancelled")
}

function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(abortError(signal))
	}
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

function createCancellationScope(externalSignal: AbortSignal | undefined, timeoutMs: number): FetchCancellationScope {
	const controller = new AbortController()
	const forwardExternalAbort = () => controller.abort(externalSignal?.reason ?? new Error("Web fetch operation was cancelled"))
	if (externalSignal?.aborted) {
		forwardExternalAbort()
	} else {
		externalSignal?.addEventListener("abort", forwardExternalAbort, { once: true })
	}
	const timeout = setTimeout(() => {
		controller.abort(new Error(`Web fetch timed out after ${Math.ceil(timeoutMs / 1_000)} seconds`))
	}, timeoutMs)
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timeout)
			externalSignal?.removeEventListener("abort", forwardExternalAbort)
		},
	}
}

/** Fetch and clean one webpage with an isolated browser lifecycle. */
export class BrowserWebFetchProvider implements LocalWebFetchProvider {
	constructor(private readonly createFetcher: () => UrlContentFetcherPort = () => new UrlContentFetcher()) {}

	async fetch(request: LocalWebFetchRequest): Promise<LocalWebFetchResponse> {
		const fetcher = this.createFetcher()
		const timeoutMs = request.timeoutMs ?? DEFAULT_WEB_FETCH_TIMEOUT_MS
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			throw new Error("Web fetch timeout must be a positive finite number")
		}
		const cancellation = createCancellationScope(request.signal, timeoutMs)
		let response: LocalWebFetchResponse | undefined
		let operationFailed = false
		let operationError: unknown
		try {
			response = await waitForAbort(
				(async () => {
					await fetcher.launchBrowser(cancellation.signal)
					const content = await fetcher.urlToMarkdown(request.url, cancellation.signal)
					return {
						url: request.url,
						prompt: request.prompt,
						content,
						source: {
							id: "browser",
							label: "Browser Web Fetch",
							execution: "dline",
						},
					}
				})(),
				cancellation.signal,
			)
		} catch (error) {
			operationFailed = true
			operationError = error
		}

		const closePromise = fetcher.closeBrowser()
		let closeFailed = false
		let closeError: unknown
		try {
			await waitForAbort(closePromise, cancellation.signal)
		} catch (error) {
			closeFailed = true
			closeError = error
			void closePromise.catch(() => undefined)
		} finally {
			cancellation.dispose()
		}

		if (operationFailed) throw operationError
		if (closeFailed) throw closeError
		if (!response) throw new Error("Web fetch completed without a response")
		return response
	}
}

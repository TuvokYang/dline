import dns from "dns/promises"
import type { IncomingHttpHeaders } from "http"
import https from "https"
import { BlockList, isIP } from "net"
import type { ArtifactUrlDownloader, ArtifactUrlDownloadRequest, ArtifactUrlDownloadResult } from "./ArtifactResolver"
import { ArtifactStoreError } from "./TaskArtifactStore"

const DEFAULT_MAX_REDIRECTS = 3
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"])
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308])

export interface SecureArtifactResolvedAddress {
	address: string
	family: 4 | 6
}

export interface SecureArtifactHttpRequest {
	url: URL
	address: string
	family: 4 | 6
	signal?: AbortSignal
}

export interface SecureArtifactHttpResponse {
	statusCode: number
	headers: Record<string, string | undefined>
	body: AsyncIterable<Uint8Array>
	cancel(): void
}

export interface SecureArtifactUrlDownloaderOptions {
	resolveHostname?: (hostname: string) => Promise<SecureArtifactResolvedAddress[]>
	request?: (input: SecureArtifactHttpRequest) => Promise<SecureArtifactHttpResponse>
	maxRedirects?: number
}

const BLOCKED_ADDRESSES = new BlockList()

function blockSubnet(network: string, prefix: number, type: "ipv4" | "ipv6"): void {
	BLOCKED_ADDRESSES.addSubnet(network, prefix, type)
}

for (const [network, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const) {
	blockSubnet(network, prefix, "ipv4")
}

for (const [network, prefix] of [
	["::", 128],
	["::1", 128],
	["64:ff9b::", 96],
	["64:ff9b:1::", 48],
	["100::", 64],
	["2001::", 32],
	["2001:db8::", 32],
	["2001:10::", 28],
	["2002::", 16],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as const) {
	blockSubnet(network, prefix, "ipv6")
}

function normalizeMimeType(value: string | undefined): string {
	return value?.trim().toLowerCase().split(";", 1)[0] ?? ""
}

function parseCanonicalHttpsUrl(value: URL): URL {
	if (value.protocol !== "https:" || value.username || value.password || !value.hostname) {
		throw new ArtifactStoreError("unsafe_artifact_url", "Provider image URL must use HTTPS without embedded credentials.")
	}
	return value
}

function isPublicAddress(address: string, family: 4 | 6): boolean {
	if (isIP(address) !== family) return false
	if (family === 6) {
		const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1]
		if (mappedIpv4) return isPublicAddress(mappedIpv4, 4)
	}
	return !BLOCKED_ADDRESSES.check(address, family === 4 ? "ipv4" : "ipv6")
}

async function defaultResolveHostname(hostname: string): Promise<SecureArtifactResolvedAddress[]> {
	const addresses = await dns.lookup(hostname, { all: true, verbatim: true })
	return addresses.flatMap((entry) =>
		entry.family === 4 || entry.family === 6 ? [{ address: entry.address, family: entry.family }] : [],
	)
}

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string | undefined> {
	const normalized: Record<string, string | undefined> = {}
	for (const [key, value] of Object.entries(headers)) {
		normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : typeof value === "string" ? value : undefined
	}
	return normalized
}

function defaultRequest(input: SecureArtifactHttpRequest): Promise<SecureArtifactHttpResponse> {
	return new Promise((resolve, reject) => {
		const request = https.request(
			input.url,
			{
				method: "GET",
				headers: { accept: "image/png, image/jpeg, image/webp" },
				signal: input.signal,
				lookup: (_hostname, _options, callback) => callback(null, input.address, input.family),
			},
			(response) => {
				resolve({
					statusCode: response.statusCode ?? 0,
					headers: normalizeHeaders(response.headers),
					body: response,
					cancel: () => response.destroy(),
				})
			},
		)
		request.on("error", reject)
		request.end()
	})
}

function parseContentLength(value: string | undefined): number | undefined {
	if (value === undefined) return undefined
	if (!/^\d+$/.test(value)) {
		throw new ArtifactStoreError("artifact_io_error", "Downloaded image Content-Length is invalid.")
	}
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed)) {
		throw new ArtifactStoreError("artifact_size_exceeded", "Downloaded image Content-Length exceeds the supported range.")
	}
	return parsed
}

export class SecureArtifactUrlDownloader implements ArtifactUrlDownloader {
	private readonly resolveHostname: (hostname: string) => Promise<SecureArtifactResolvedAddress[]>
	private readonly request: (input: SecureArtifactHttpRequest) => Promise<SecureArtifactHttpResponse>
	private readonly maxRedirects: number

	constructor(options: SecureArtifactUrlDownloaderOptions = {}) {
		const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
		if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
			throw new ArtifactStoreError("invalid_configuration", "Artifact redirect limit must be a non-negative integer.")
		}
		this.resolveHostname = options.resolveHostname ?? defaultResolveHostname
		this.request = options.request ?? defaultRequest
		this.maxRedirects = maxRedirects
	}

	async download(request: ArtifactUrlDownloadRequest): Promise<ArtifactUrlDownloadResult> {
		let currentUrl = parseCanonicalHttpsUrl(new URL(request.url.href))
		for (let redirectCount = 0; ; redirectCount++) {
			if (request.signal?.aborted) throw request.signal.reason
			const address = await this.resolvePublicAddress(currentUrl.hostname)
			let response: SecureArtifactHttpResponse
			try {
				response = await this.request({ ...address, url: currentUrl, signal: request.signal })
			} catch (error) {
				if (request.signal?.aborted) throw request.signal.reason ?? error
				throw new ArtifactStoreError("artifact_io_error", "Provider image URL could not be downloaded.", { cause: error })
			}

			if (REDIRECT_STATUS_CODES.has(response.statusCode)) {
				response.cancel()
				if (redirectCount >= this.maxRedirects) {
					throw new ArtifactStoreError("unsafe_artifact_url", "Provider image URL exceeded the redirect limit.")
				}
				const location = response.headers.location
				if (!location) {
					throw new ArtifactStoreError(
						"artifact_io_error",
						"Provider image redirect did not include a Location header.",
					)
				}
				try {
					currentUrl = parseCanonicalHttpsUrl(new URL(location, currentUrl))
				} catch (error) {
					if (error instanceof ArtifactStoreError) throw error
					throw new ArtifactStoreError("unsafe_artifact_url", "Provider image redirect URL is invalid.", {
						cause: error,
					})
				}
				continue
			}

			if (response.statusCode !== 200) {
				response.cancel()
				throw new ArtifactStoreError("artifact_io_error", `Provider image URL returned HTTP ${response.statusCode}.`)
			}
			return this.readImageResponse(response, request.maxBytes, request.signal)
		}
	}

	private async resolvePublicAddress(hostname: string): Promise<SecureArtifactResolvedAddress> {
		let addresses: SecureArtifactResolvedAddress[]
		try {
			addresses = await this.resolveHostname(hostname)
		} catch (error) {
			throw new ArtifactStoreError("unsafe_artifact_url", "Provider image hostname could not be resolved safely.", {
				cause: error,
			})
		}
		if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address, entry.family))) {
			throw new ArtifactStoreError("unsafe_artifact_url", "Provider image hostname resolves to a non-public address.")
		}
		return addresses[0]
	}

	private async readImageResponse(
		response: SecureArtifactHttpResponse,
		maxBytes: number,
		signal?: AbortSignal,
	): Promise<ArtifactUrlDownloadResult> {
		const mimeType = normalizeMimeType(response.headers["content-type"])
		if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
			response.cancel()
			throw new ArtifactStoreError("unsupported_format", "Provider image URL returned an unsupported MIME type.")
		}
		const contentLength = parseContentLength(response.headers["content-length"])
		if (contentLength !== undefined && contentLength > maxBytes) {
			response.cancel()
			throw new ArtifactStoreError("artifact_size_exceeded", "Downloaded image exceeds the configured byte limit.")
		}

		const chunks: Uint8Array[] = []
		let totalBytes = 0
		try {
			for await (const chunk of response.body) {
				if (signal?.aborted) throw signal.reason
				const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
				totalBytes += bytes.byteLength
				if (totalBytes > maxBytes) {
					throw new ArtifactStoreError("artifact_size_exceeded", "Downloaded image exceeds the configured byte limit.")
				}
				chunks.push(bytes)
			}
		} catch (error) {
			response.cancel()
			if (error instanceof ArtifactStoreError) throw error
			if (signal?.aborted) throw signal.reason ?? error
			throw new ArtifactStoreError("artifact_io_error", "Provider image response stream failed.", { cause: error })
		}

		const result = new Uint8Array(totalBytes)
		let offset = 0
		for (const chunk of chunks) {
			result.set(chunk, offset)
			offset += chunk.byteLength
		}
		return { bytes: result, mimeType }
	}
}

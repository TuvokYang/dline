import { describe, expect, it, vi } from "vitest"
import {
	type SecureArtifactHttpRequest,
	type SecureArtifactHttpResponse,
	SecureArtifactUrlDownloader,
} from "../SecureArtifactUrlDownloader"
import { ArtifactStoreError } from "../TaskArtifactStore"

const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
	"base64",
)

async function expectArtifactError(promise: Promise<unknown>, code: ArtifactStoreError["code"]): Promise<void> {
	try {
		await promise
		throw new Error(`Expected ArtifactStoreError with code ${code}`)
	} catch (error) {
		expect(error).toBeInstanceOf(ArtifactStoreError)
		expect((error as ArtifactStoreError).code).toBe(code)
	}
}

function response(statusCode: number, headers: Record<string, string>, chunks: Uint8Array[] = []): SecureArtifactHttpResponse {
	return {
		statusCode,
		headers,
		body: (async function* () {
			for (const chunk of chunks) yield chunk
		})(),
		cancel: vi.fn(),
	}
}

describe("SecureArtifactUrlDownloader", () => {
	it.each([
		"127.0.0.1",
		"10.0.0.2",
		"169.254.169.254",
		"172.16.0.1",
		"192.168.1.2",
		"::1",
		"::ffff:127.0.0.1",
		"64:ff9b::7f00:1",
		"2002:7f00:1::",
		"fe80::1",
		"fc00::1",
	])("rejects non-public resolved address %s before opening a connection", async (address) => {
		const request = vi.fn<(input: SecureArtifactHttpRequest) => Promise<SecureArtifactHttpResponse>>()
		const downloader = new SecureArtifactUrlDownloader({
			resolveHostname: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
			request,
		})

		await expectArtifactError(
			downloader.download({ url: new URL("https://images.example.test/generated.png"), maxBytes: 1024 }),
			"unsafe_artifact_url",
		)
		expect(request).not.toHaveBeenCalled()
	})

	it("pins a validated public address and accepts only bounded supported image responses", async () => {
		const request = vi.fn(async (input: SecureArtifactHttpRequest) => {
			expect(input.url.href).toBe("https://images.example.test/generated.png")
			expect(input.address).toBe("8.8.8.8")
			expect(input.family).toBe(4)
			return response(200, { "content-type": "image/png", "content-length": String(PNG_1X1.byteLength) }, [PNG_1X1])
		})
		const downloader = new SecureArtifactUrlDownloader({
			resolveHostname: async () => [{ address: "8.8.8.8", family: 4 }],
			request,
		})

		const result = await downloader.download({
			url: new URL("https://images.example.test/generated.png"),
			maxBytes: PNG_1X1.byteLength,
		})

		expect(Buffer.from(result.bytes)).toEqual(PNG_1X1)
		expect(result.mimeType).toBe("image/png")
		expect(request).toHaveBeenCalledOnce()
	})

	it("revalidates redirects and rejects redirects into private networks", async () => {
		const request = vi.fn(async () => response(302, { location: "https://internal.example.test/generated.png" }))
		const downloader = new SecureArtifactUrlDownloader({
			resolveHostname: async (hostname) =>
				hostname === "images.example.test" ? [{ address: "8.8.8.8", family: 4 }] : [{ address: "10.0.0.5", family: 4 }],
			request,
		})

		await expectArtifactError(
			downloader.download({ url: new URL("https://images.example.test/generated.png"), maxBytes: 1024 }),
			"unsafe_artifact_url",
		)
		expect(request).toHaveBeenCalledOnce()
	})

	it("rejects unsupported MIME types and streamed bodies above the byte cap", async () => {
		const responses = [
			response(200, { "content-type": "image/svg+xml" }, [Buffer.from("<svg/>")]),
			response(200, { "content-type": "image/png" }, [PNG_1X1, Buffer.from([1])]),
		]
		const downloader = new SecureArtifactUrlDownloader({
			resolveHostname: async () => [{ address: "8.8.8.8", family: 4 }],
			request: async () => responses.shift()!,
		})

		await expectArtifactError(
			downloader.download({ url: new URL("https://images.example.test/unsafe.svg"), maxBytes: 1024 }),
			"unsupported_format",
		)
		await expectArtifactError(
			downloader.download({ url: new URL("https://images.example.test/large.png"), maxBytes: PNG_1X1.byteLength }),
			"artifact_size_exceeded",
		)
	})
})

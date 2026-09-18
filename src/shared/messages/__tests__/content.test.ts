import { imageSourceMediaType, imageSourceToUrl } from "@shared/messages/content"
import { expect } from "chai"
import { describe, it } from "vitest"

describe("message image source helpers", () => {
	it("converts base64 sources to data URLs", () => {
		const source = { type: "base64", media_type: "image/png", data: "aGVsbG8=" } as const

		expect(imageSourceToUrl(source)).to.equal("data:image/png;base64,aGVsbG8=")
		expect(imageSourceMediaType(source)).to.equal("image/png")
	})

	it("preserves URL image sources added by the latest Anthropic SDK", () => {
		const source = { type: "url", url: "https://example.com/image.png" } as const

		expect(imageSourceToUrl(source)).to.equal(source.url)
		expect(imageSourceMediaType(source)).to.equal("remote URL")
	})

	it("rejects provider file image sources at the URL conversion boundary", () => {
		const source = { type: "file", file_id: "file_123" } as const

		expect(() => imageSourceToUrl(source)).to.throw("Provider file image sources cannot be replayed as URLs")
		expect(imageSourceMediaType(source)).to.equal("provider file")
	})
})

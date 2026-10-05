import { describe, expect, it } from "vitest"
import { estimateContextValueBreakdown } from "../context-window-projection"

const LARGE_PDF_BASE64 = Buffer.alloc(3_000_000).toString("base64")

describe("PDF context estimation", () => {
	it("charges an attached PDF by pages or extracted text, not by its base64 size", () => {
		const breakdown = estimateContextValueBreakdown({
			type: "attached_document",
			path: "spec.pdf",
			media_type: "application/pdf",
			data: LARGE_PDF_BASE64,
			byte_length: 3_000_000,
			page_count: 4,
			fallback_text: "short text",
		})

		expect(breakdown.imageTokens).toBe(4 * 3000)
		expect(breakdown.totalTokens).toBeLessThan(13_000)
	})

	it("charges a projected PDF document by its page count", () => {
		const breakdown = estimateContextValueBreakdown({
			type: "document",
			source: { type: "base64", media_type: "application/pdf", data: LARGE_PDF_BASE64 },
			title: "spec.pdf",
			page_count: 2,
		})

		expect(breakdown.imageTokens).toBe(2 * 3000)
		expect(breakdown.totalTokens).toBeLessThan(7_000)
	})
})

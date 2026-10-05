import { describe, expect, it } from "vitest"
import { selectNativeDocuments } from "../attached-documents"
import {
	type ClineStorageMessage,
	type ClineUserAttachedDocumentBlock,
	cleanContentBlock,
	convertClineStorageToAnthropicMessage,
	projectInternalMessagesForProvider,
} from "../content"

function attachedPdf(path: string, byteLength: number, pageCount?: number): ClineUserAttachedDocumentBlock {
	return {
		type: "attached_document",
		path,
		media_type: "application/pdf",
		data: Buffer.alloc(byteLength).toString("base64"),
		byte_length: byteLength,
		...(pageCount === undefined ? {} : { page_count: pageCount }),
		fallback_text: `<file_content path="${path}">\nextracted ${path}\n</file_content>`,
	}
}

function userTurn(...content: ClineStorageMessage["content"] & unknown[]): ClineStorageMessage {
	return { role: "user", content }
}

describe("attached PDF projection", () => {
	it("sends the extracted text when the endpoint cannot read PDFs", () => {
		const pdf = attachedPdf("docs/spec.pdf", 10, 2)

		expect(projectInternalMessagesForProvider([userTurn(pdf)])).toEqual([
			{ role: "user", content: [{ type: "text", text: pdf.fallback_text }] },
		])
	})

	it("sends the whole PDF as a document within the endpoint budget", () => {
		const pdf = attachedPdf("docs/spec.pdf", 10, 2)

		const [projected] = projectInternalMessagesForProvider([userTurn(pdf)], { documentInput: { maxTotalBytes: 100 } })

		expect(projected.content).toEqual([
			{ type: "text", text: expect.stringContaining('<file_content path="docs/spec.pdf">') },
			{
				type: "document",
				source: { type: "base64", media_type: "application/pdf", data: pdf.data },
				title: "spec.pdf",
				page_count: 2,
			},
		])
	})

	it("spends the request budget on the newest PDFs and falls back for older ones", () => {
		const older = attachedPdf("old.pdf", 60, 1)
		const newer = attachedPdf("new.pdf", 60, 1)
		const messages = [userTurn(older), { role: "assistant" as const, content: "ok" }, userTurn(newer)]

		const admitted = selectNativeDocuments(messages, { maxTotalBytes: 100 })
		const projected = projectInternalMessagesForProvider(messages, { documentInput: { maxTotalBytes: 100 } })

		expect([...admitted]).toEqual([newer])
		expect(projected[0].content).toEqual([{ type: "text", text: expect.stringContaining(older.fallback_text) }])
		expect(projected[0].content[0]).toMatchObject({ text: expect.stringContaining("exceeds the native document limit") })
		expect((projected[2].content as Array<{ type: string }>).map((block) => block.type)).toEqual(["text", "document"])
	})

	it("enforces the page limit and never admits a PDF with an unknown page count against it", () => {
		const limits = { maxTotalBytes: 1_000, maxTotalPages: 100 }

		expect(selectNativeDocuments([userTurn(attachedPdf("big.pdf", 10, 101))], limits).size).toBe(0)
		expect(selectNativeDocuments([userTurn(attachedPdf("unknown.pdf", 10))], limits).size).toBe(0)
		expect(selectNativeDocuments([userTurn(attachedPdf("fits.pdf", 10, 100))], limits).size).toBe(1)
	})

	it("never sends the canonical block or the page-count hint to Anthropic", () => {
		const pdf = attachedPdf("a.pdf", 10, 3)

		expect(cleanContentBlock(pdf)).toEqual({ type: "text", text: pdf.fallback_text })
		expect(convertClineStorageToAnthropicMessage(userTurn(pdf), "openrouter").content).toEqual([
			{ type: "text", text: pdf.fallback_text },
		])
		const [projected] = projectInternalMessagesForProvider([userTurn(pdf)], { documentInput: { maxTotalBytes: 100 } })
		const anthropic = convertClineStorageToAnthropicMessage(projected).content as unknown as Array<Record<string, unknown>>
		expect(anthropic[1]).toEqual({
			type: "document",
			source: { type: "base64", media_type: "application/pdf", data: pdf.data },
			title: "a.pdf",
		})
	})
})

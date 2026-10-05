import fs from "fs/promises"
import os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { processFilesIntoContent, processFilesIntoText } from "../extract-text"

// The parser is a third-party boundary; the attachment contract only depends on its text and page count.
vi.mock("pdf-parse/lib/pdf-parse", () => ({
	default: async (bytes: Buffer) => {
		if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Invalid PDF structure")
		return { text: "Hello PDF", numpages: 1 }
	},
}))

function onePagePdf(): Buffer {
	return Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n", "latin1")
}

describe("processFilesIntoContent", () => {
	let dir: string

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-attach-"))
	})

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("keeps a PDF whole with its page count and extracted text fallback", async () => {
		const pdfPath = path.join(dir, "report.pdf")
		const bytes = onePagePdf()
		await fs.writeFile(pdfPath, bytes)

		const [header, document] = await processFilesIntoContent([pdfPath])

		expect(header).toEqual({ type: "text", text: "Files attached by the user:" })
		expect(document).toMatchObject({
			type: "attached_document",
			path: pdfPath.toPosix(),
			media_type: "application/pdf",
			data: bytes.toString("base64"),
			byte_length: bytes.byteLength,
			page_count: 1,
		})
		expect(document).toHaveProperty("fallback_text", expect.stringContaining("Hello PDF"))
	})

	it("keeps other files as the same text attachments as before", async () => {
		const notePath = path.join(dir, "note.txt")
		await fs.writeFile(notePath, "plain note")

		const content = await processFilesIntoContent([notePath])

		expect(content).toEqual([{ type: "text", text: await processFilesIntoText([notePath]) }])
		expect(content[0]).toMatchObject({ text: expect.stringContaining("plain note") })
	})

	it("attaches only error text for a PDF the parser cannot read", async () => {
		const brokenPath = path.join(dir, "broken.pdf")
		await fs.writeFile(brokenPath, "not a pdf")

		const content = await processFilesIntoContent([brokenPath])

		expect(content).toHaveLength(1)
		expect(content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Error fetching content") })
	})
})

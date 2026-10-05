import fs from "fs/promises"
import os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { processFilesForToolResult, processFilesIntoContent, processFilesIntoText } from "../extract-text"

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

describe("processFilesForToolResult", () => {
	let dir: string

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-tool-attach-"))
	})

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("returns nothing when no file was attached", async () => {
		await expect(processFilesForToolResult(undefined)).resolves.toEqual({ text: "", documents: [] })
		await expect(processFilesForToolResult([])).resolves.toEqual({ text: "", documents: [] })
	})

	it("separates a PDF from the tool result text instead of inlining its bytes or extracted text", async () => {
		const pdfPath = path.join(dir, "spec.pdf")
		const bytes = onePagePdf()
		await fs.writeFile(pdfPath, bytes)
		const notePath = path.join(dir, "note.txt")
		await fs.writeFile(notePath, "plain note")

		const { text, documents } = await processFilesForToolResult([pdfPath, notePath])

		expect(documents).toHaveLength(1)
		expect(documents[0]).toMatchObject({ type: "attached_document", data: bytes.toString("base64") })
		expect(text).toContain("plain note")
		expect(text).toContain("follow this tool result as documents")
		expect(text).not.toContain(bytes.toString("base64"))
		expect(text).not.toContain("Hello PDF")
	})

	it("keeps text-only attachments identical to the legacy text projection", async () => {
		const notePath = path.join(dir, "note.txt")
		await fs.writeFile(notePath, "plain note")

		const { text, documents } = await processFilesForToolResult([notePath])

		expect(documents).toEqual([])
		expect(text).toBe(await processFilesIntoText([notePath]))
	})
})

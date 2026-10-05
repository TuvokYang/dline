import { describe, expect, it } from "vitest"
import { classifyTransferFiles, isDocumentAttachmentUri, parseAttachableFileUris, readResourceUris } from "./composer-transfer"

function transfer(data: Record<string, string>): Pick<DataTransfer, "getData"> {
	return { getData: (format: string) => data[format] ?? "" }
}

function file(name: string, type: string, size = 10): File {
	const value = new File([new Uint8Array(1)], name, { type })
	Object.defineProperty(value, "size", { value: size })
	return value
}

describe("composer transfer classification", () => {
	it("reads VS Code Explorer resource URIs and attaches binary documents instead of mentioning them", () => {
		const uris = readResourceUris(
			transfer({ resourceurls: JSON.stringify(["file:///c%3A/work/report.pdf", "file:///c%3A/work/main.ts"]) }),
		)

		expect(uris).toEqual(["file:///c:/work/report.pdf", "file:///c:/work/main.ts"])
		expect(uris.filter(isDocumentAttachmentUri)).toEqual(["file:///c:/work/report.pdf"])
	})

	it("falls back to the VS Code uri-list and ignores non-file schemes", () => {
		const uris = readResourceUris(
			transfer({ "application/vnd.code.uri-list": "file:///home/u/a.xlsx\nhttps://example.com/x\n" }),
		)

		expect(uris).toEqual(["file:///home/u/a.xlsx"])
	})

	it("splits OS-dropped files into images, attachable files, and rejected files", () => {
		const screenshot = file("shot.png", "image/png")
		const pdf = file("paper.pdf", "application/pdf", 30 * 1000 * 1000)
		const hugePdf = file("huge.pdf", "application/pdf", 60 * 1000 * 1000)
		const archive = file("bundle.zip", "application/zip")

		const result = classifyTransferFiles([screenshot, pdf, hugePdf, archive])

		expect(result.images).toEqual([screenshot])
		expect(result.attachments).toEqual([pdf])
		expect(result.rejected).toEqual([hugePdf, archive])
	})

	it("treats text made only of attachable file URIs as attachments (Linux file managers)", () => {
		expect(parseAttachableFileUris("file:///home/u/a.pdf\r\nfile:///home/u/b.docx\n")).toEqual([
			"file:///home/u/a.pdf",
			"file:///home/u/b.docx",
		])
	})

	it("keeps ordinary text and non-attachable file URIs as text", () => {
		expect(parseAttachableFileUris("see file:///home/u/a.pdf")).toEqual([])
		expect(parseAttachableFileUris("file:///home/u/script.sh")).toEqual([])
		expect(parseAttachableFileUris("https://example.com/a.pdf")).toEqual([])
	})
})

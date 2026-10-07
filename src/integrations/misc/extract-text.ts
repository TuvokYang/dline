import ExcelJS from "exceljs"
import fs from "fs/promises"
import * as iconv from "iconv-lite"
import { isBinaryFile } from "isbinaryfile"
import * as chardet from "jschardet"
import mammoth from "mammoth"
import * as path from "path"
// @ts-expect-error-next-line
import pdf from "pdf-parse/lib/pdf-parse"
import { MAX_ATTACHED_PDF_BYTES } from "@/shared/attachments"
import { truncateContent } from "@/shared/content-limits"
import type { ClineTextContentBlock, ClineUserAttachedDocumentBlock } from "@/shared/messages/content"
import { Logger } from "@/shared/services/Logger"
import { sanitizeNotebookForLLM } from "./notebook-utils"

export async function detectEncoding(fileBuffer: Buffer, fileExtension?: string): Promise<string> {
	const detected = chardet.detect(fileBuffer)
	if (typeof detected === "string") {
		return detected
	}
	if (detected && (detected as any).encoding) {
		return (detected as any).encoding
	}
	if (fileExtension) {
		const isBinary = await isBinaryFile(fileBuffer).catch(() => false)
		if (isBinary) {
			throw new Error(`Cannot read text for file type: ${fileExtension}`)
		}
	}
	return "utf8"
}

export async function extractTextFromFile(filePath: string): Promise<string> {
	try {
		await fs.access(filePath)
	} catch (_error) {
		throw new Error(`File not found: ${filePath}`)
	}

	return callTextExtractionFunctions(filePath)
}

/**
 * Expects the fs.access call to have already been performed prior to calling.
 * Content is automatically truncated if it exceeds 400KB to prevent context overflow.
 */
export async function callTextExtractionFunctions(filePath: string): Promise<string> {
	const fileExtension = path.extname(filePath).toLowerCase()

	let content: string

	switch (fileExtension) {
		case ".pdf":
			content = await extractTextFromPDF(filePath)
			break
		case ".docx":
			content = await extractTextFromDOCX(filePath)
			break
		case ".ipynb":
			content = await extractTextFromIPYNB(filePath)
			break
		case ".xlsx":
			content = await extractTextFromExcel(filePath)
			break
		default:
			// Check file size with stat() first - faster than reading entire file for size check
			const fileStat = await fs.stat(filePath)
			if (fileStat.size > 20 * 1000 * 1024) {
				// 20MB limit (20 * 1000 * 1024 bytes, decimal MB)
				throw new Error(`File is too large to read into context.`)
			}
			const fileBuffer = await fs.readFile(filePath)
			const encoding = await detectEncoding(fileBuffer, fileExtension)
			content = iconv.decode(fileBuffer, encoding)
	}

	// Truncate content if it exceeds 400KB to prevent context overflow
	return truncateContent(content)
}

async function extractTextFromPDF(filePath: string): Promise<string> {
	const dataBuffer = await fs.readFile(filePath)
	const data = await pdf(dataBuffer)
	return data.text
}

async function extractTextFromDOCX(filePath: string): Promise<string> {
	const result = await mammoth.extractRawText({ path: filePath })
	return result.value
}

async function extractTextFromIPYNB(filePath: string): Promise<string> {
	const fileBuffer = await fs.readFile(filePath)
	const encoding = await detectEncoding(fileBuffer)
	const data = iconv.decode(fileBuffer, encoding)

	// Strip all outputs to reduce context size - outputs aren't needed for understanding
	// notebook structure. For Jupyter commands, the specific cell's outputs are included
	// separately via sanitizeCellForLLM which preserves text outputs.
	return sanitizeNotebookForLLM(data, true)
}

/**
 * Format the data inside Excel cells
 */
function formatCellValue(cell: ExcelJS.Cell): string {
	const value = cell.value
	if (value === null || value === undefined) {
		return ""
	}

	// Handle error values (#DIV/0!, #N/A, etc.)
	if (typeof value === "object" && "error" in value) {
		return `[Error: ${value.error}]`
	}

	// Handle dates - ExcelJS can parse them as Date objects
	if (value instanceof Date) {
		return value.toISOString().split("T")[0] // Just the date part
	}

	// Handle rich text
	if (typeof value === "object" && "richText" in value) {
		return value.richText.map((rt) => rt.text).join("")
	}

	// Handle hyperlinks
	if (typeof value === "object" && "text" in value && "hyperlink" in value) {
		return `${value.text} (${value.hyperlink})`
	}

	// Handle formulas - get the calculated result
	if (typeof value === "object" && "formula" in value) {
		if ("result" in value && value.result !== undefined && value.result !== null) {
			return value.result.toString()
		}
		return `[Formula: ${value.formula}]`
	}

	return value.toString()
}

/**
 * Extract and format text from xlsx files
 */
async function extractTextFromExcel(filePath: string): Promise<string> {
	const workbook = new ExcelJS.Workbook()
	let excelText = ""

	try {
		await workbook.xlsx.readFile(filePath)

		workbook.eachSheet((worksheet, _sheetId) => {
			// Skip hidden sheets
			if (worksheet.state === "hidden" || worksheet.state === "veryHidden") {
				return
			}

			excelText += `--- Sheet: ${worksheet.name} ---\n`

			worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
				// Optional: limit processing for very large sheets
				if (rowNumber > 50000) {
					excelText += `[... truncated at row ${rowNumber} ...]\n`
					return false
				}

				const rowTexts: string[] = []
				let hasContent = false

				row.eachCell({ includeEmpty: true }, (cell, _colNumber) => {
					const cellText = formatCellValue(cell)
					if (cellText.trim()) {
						hasContent = true
					}
					rowTexts.push(cellText)
				})

				// Only add rows with actual content
				if (hasContent) {
					excelText += `${rowTexts.join("\t")}\n`
				}

				return true
			})

			excelText += "\n" // Blank line between sheets
		})

		return excelText.trim()
	} catch (error: any) {
		Logger.error(`Error extracting text from Excel ${filePath}:`, error)
		throw new Error(`Failed to extract text from Excel: ${error.message}`)
	}
}

const ATTACHED_FILES_HEADER = "Files attached by the user:"

/**
 * Helper function used to load file(s) and format them into a string
 */
export async function processFilesIntoText(files: string[]): Promise<string> {
	const fileContents = await Promise.all(files.map(readFileContentEntry))
	return fileContents.length > 0 ? `${ATTACHED_FILES_HEADER}\n\n${fileContents.join("\n\n")}` : ""
}

/**
 * Load attached files as user-message content.
 *
 * PDFs keep their bytes so each request can send them natively where the endpoint allows it; their
 * extracted text travels with them as the fallback. Every other file becomes the same `<file_content>`
 * text {@link processFilesIntoText} produces. A PDF that cannot be parsed is attached as its error text
 * only, because an endpoint would reject it on every later request of the task.
 */
export async function processFilesIntoContent(
	files: string[],
): Promise<Array<ClineTextContentBlock | ClineUserAttachedDocumentBlock>> {
	if (files.length === 0) return []
	const pdfResults = await Promise.all(files.filter(isPdfPath).map(readAttachedPdf))
	const documents = pdfResults.filter((result): result is ClineUserAttachedDocumentBlock => typeof result !== "string")
	const textEntries = [
		...(await Promise.all(files.filter((filePath) => !isPdfPath(filePath)).map(readFileContentEntry))),
		...pdfResults.filter((result): result is string => typeof result === "string"),
	]
	const header = textEntries.length > 0 ? `${ATTACHED_FILES_HEADER}\n\n${textEntries.join("\n\n")}` : ATTACHED_FILES_HEADER
	return [{ type: "text", text: header }, ...documents]
}

/** Attached files of a tool result, split by where each can travel. */
export interface ToolResultAttachments {
	/** Text for inside the tool result; empty when no file was attached. */
	text: string
	/** PDFs for the same user message after the tool result, where native document blocks are allowed. */
	documents: ClineUserAttachedDocumentBlock[]
}

const PDFS_FOLLOW_NOTE = "(The attached PDFs follow this tool result as documents.)"

/**
 * Load files a user attached while answering a tool, such as feedback on an approval or a follow-up answer.
 *
 * A tool result carries only text and images, so PDFs are returned separately for the caller to place
 * beside the result; extracting them into the result instead would lose the document and cost context
 * for its text. Every other file becomes the same `<file_content>` text {@link processFilesIntoText} makes.
 */
export async function processFilesForToolResult(files: string[] | undefined): Promise<ToolResultAttachments> {
	if (!files?.length) return { text: "", documents: [] }
	const content = await processFilesIntoContent(files)
	const documents = content.filter((block): block is ClineUserAttachedDocumentBlock => block.type === "attached_document")
	const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n\n")
	return { text: documents.length > 0 ? `${text}\n\n${PDFS_FOLLOW_NOTE}` : text, documents }
}

function isPdfPath(filePath: string): boolean {
	return path.extname(filePath).toLowerCase() === ".pdf"
}

function formatFileContent(filePath: string, content: string): string {
	return `<file_content path="${filePath.toPosix()}">\n${content}\n</file_content>`
}

async function readFileContentEntry(filePath: string): Promise<string> {
	try {
		return formatFileContent(filePath, await extractTextFromFile(filePath))
	} catch (error) {
		Logger.error(`Error processing file ${filePath}:`, error)
		return formatFileContent(filePath, `Error fetching content: ${error.message}`)
	}
}

/** Read a PDF once for both its bytes and its extracted text; returns error text when it cannot be used. */
async function readAttachedPdf(filePath: string): Promise<ClineUserAttachedDocumentBlock | string> {
	try {
		const { size } = await fs.stat(filePath)
		if (size > MAX_ATTACHED_PDF_BYTES) {
			throw new Error(`PDF exceeds the ${MAX_ATTACHED_PDF_BYTES / (1000 * 1000)} MB attachment limit.`)
		}
		const bytes = await fs.readFile(filePath)
		const parsed = await pdf(bytes)
		return {
			type: "attached_document",
			path: filePath.toPosix(),
			media_type: "application/pdf",
			data: bytes.toString("base64"),
			byte_length: bytes.byteLength,
			...(typeof parsed.numpages === "number" ? { page_count: parsed.numpages } : {}),
			fallback_text: formatFileContent(filePath, truncateContent(parsed.text)),
		}
	} catch (error) {
		Logger.error(`Error processing PDF ${filePath}:`, error)
		return formatFileContent(filePath, `Error fetching content: ${error.message}`)
	}
}

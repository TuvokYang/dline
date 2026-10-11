import {
    DOCX_MEDIA_TYPE,
    NOTEBOOK_MEDIA_TYPE,
    PDF_MEDIA_TYPE,
    PLAIN_TEXT_MEDIA_TYPE,
    XLSX_MEDIA_TYPE,
} from "@shared/input-semantics/media-types"
import ExcelJS from "exceljs"
import * as iconv from "iconv-lite"
import mammoth from "mammoth"
// @ts-expect-error-next-line
import pdf from "pdf-parse/lib/pdf-parse"
import { truncateContent } from "@/shared/content-limits"
import { detectEncoding } from "./extract-text"
import { sanitizeNotebookForLLM } from "./notebook-utils"

/** Media types whose bytes are the text itself. */
const PLAIN_TEXT_MEDIA_TYPES: ReadonlySet<string> = new Set([
    PLAIN_TEXT_MEDIA_TYPE,
    "text/markdown",
    "text/csv",
    "application/json",
    "application/xml",
])

/** The text a resource contributes when it is read rather than attached natively. */
export interface ExtractedResourceText {
    readonly text: string
    /** Page count reported by the PDF parser, for PDFs only. */
    readonly pageCount?: number
}

/** Raised for a media type no extractor reads, so a caller reports it instead of guessing. */
export class UnsupportedResourceMediaTypeError extends Error {
    constructor(readonly mediaType: string) {
        super(`No text extractor reads ${mediaType}`)
        this.name = "UnsupportedResourceMediaTypeError"
    }
}

/**
 * Extract the text of an input resource from the exact bytes that were verified.
 *
 * Unlike the path-based readers, nothing here touches the file system: the
 * caller already holds the frozen bytes, and reading the file again could
 * observe different content than the one whose hash was checked. The media type
 * selects the extractor, so it must be the one recorded for the bytes.
 */
export async function extractResourceText(mediaType: string, bytes: Buffer): Promise<ExtractedResourceText> {
    switch (mediaType) {
        case PDF_MEDIA_TYPE: {
            const parsed = await pdf(bytes)
            return {
                text: truncateContent(parsed.text),
                ...(typeof parsed.numpages === "number" ? { pageCount: parsed.numpages } : {}),
            }
        }
        case DOCX_MEDIA_TYPE:
            return { text: truncateContent((await mammoth.extractRawText({ buffer: bytes })).value) }
        case XLSX_MEDIA_TYPE:
            return { text: truncateContent(await extractWorkbookText(bytes)) }
        case NOTEBOOK_MEDIA_TYPE:
            // Outputs are stripped as for attached notebooks: they cost context
            // without describing the notebook's structure.
            return { text: truncateContent(sanitizeNotebookForLLM(await decodeText(bytes), true)) }
    }
    if (PLAIN_TEXT_MEDIA_TYPES.has(mediaType)) return { text: truncateContent(await decodeText(bytes)) }
    throw new UnsupportedResourceMediaTypeError(mediaType)
}

async function decodeText(bytes: Buffer): Promise<string> {
    return iconv.decode(bytes, await detectEncoding(bytes))
}

/** Visible sheets as tab-separated rows, using each cell's displayed text. */
async function extractWorkbookText(bytes: Buffer): Promise<string> {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer)
    const sheets: string[] = []
    workbook.eachSheet((worksheet) => {
        if (worksheet.state === "hidden" || worksheet.state === "veryHidden") return
        const rows: string[] = []
        worksheet.eachRow({ includeEmpty: false }, (row) => {
            const cells: string[] = []
            row.eachCell({ includeEmpty: true }, (cell) => {
                cells.push(cell.text)
            })
            if (cells.some((cell) => cell.trim())) rows.push(cells.join("\t"))
        })
        sheets.push(`--- Sheet: ${worksheet.name} ---\n${rows.join("\n")}`)
    })
    return sheets.join("\n\n").trim()
}

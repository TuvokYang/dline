import { open } from "node:fs/promises"
import * as path from "node:path"
import * as iconv from "iconv-lite"
import { detectEncoding } from "./extract-text"

/** Bytes sampled from the head of the file to detect its encoding. */
const ENCODING_SAMPLE_BYTES = 64 * 1024
const READ_CHUNK_BYTES = 64 * 1024

/** How far one read may scan to reach its start line; bounds the cost of a single call. */
export const MAX_LINE_SCAN_BYTES = 256 * 1024 * 1024

/** How far past the collected range a read keeps counting so it can report the total line count. */
export const TOTAL_LINE_COUNT_LOOKAHEAD_BYTES = 8 * 1024 * 1024

export interface TextLineRangeRequest {
    /** One-based first line to collect. */
    readonly startLine: number
    /** Most lines to collect. */
    readonly maxLines: number
    /**
     * Budget for the collected lines. Each line costs its UTF-8 bytes, a line break,
     * and `lineOverheadBytes(lineNumber)` for whatever the caller prefixes to it.
     * The first line is always collected so a read never comes back empty-handed.
     */
    readonly maxBytes: number
    /** Longest part of one line that is kept; the rest is counted in `omittedBytes`. */
    readonly maxLineBytes: number
    /** Bytes the caller adds around one line, given how much of the line was cut. */
    readonly lineOverheadBytes?: (lineNumber: number, omittedBytes: number) => number
    readonly signal?: AbortSignal
    readonly maxScanBytes?: number
    readonly countLookaheadBytes?: number
}

/** Why the collection ended. */
export type TextLineRangeStop = "end_of_file" | "max_lines" | "max_bytes" | "scan_limit"

export interface TextLine {
    readonly text: string
    /** UTF-8 bytes cut from the end of the line by `maxLineBytes`. */
    readonly omittedBytes: number
}

export interface TextLineRange {
    readonly startLine: number
    readonly lines: readonly TextLine[]
    /** Last collected line, or `startLine - 1` when nothing was collected. */
    readonly endLine: number
    readonly stop: TextLineRangeStop
    /** Known only when the scan reached the end of the file. */
    readonly totalLines?: number
    /** Lines seen by the scan; a lower bound on the total when `totalLines` is unknown. */
    readonly scannedLines: number
}

/**
 * Read a range of lines from a text file without loading the whole file.
 *
 * The scan is bounded by the file size observed when the read starts, so a file
 * that keeps growing cannot extend it, and by `maxScanBytes` for very large files.
 * Lines are split on `\n` with a trailing `\r` removed, and a trailing line break
 * does not add an empty last line, matching how whole-file reads number lines.
 */
export async function readTextLineRange(filePath: string, request: TextLineRangeRequest): Promise<TextLineRange> {
    const normalized = normalizeRequest(request)
    const handle = await open(filePath, "r")
    try {
        const { size } = await handle.stat()
        const head = await detectStreamEncoding(handle, size, path.extname(filePath).toLowerCase())
        let decoder = iconv.getDecoder(head.encoding)
        let encodingSettled = head.settled
        const collector = new LineCollector(normalized)
        const scanLimit = Math.min(size, normalized.maxScanBytes)
        let countLimit: number | undefined
        let position = 0
        let reachedEnd = size === 0
        while (!reachedEnd) {
            throwIfAborted(normalized.signal)
            if (collector.stopped && countLimit === undefined) {
                countLimit = Math.min(size, position + normalized.countLookaheadBytes)
            }
            const limit = countLimit ?? scanLimit
            if (position >= limit) break
            // A fresh buffer per read: a stateful decoder may keep a reference to the previous chunk.
            const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, limit - position))
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
            // A file that shrank while being read ends where its content does.
            if (bytesRead === 0) {
                reachedEnd = true
                break
            }
            position += bytesRead
            const bytes = chunk.subarray(0, bytesRead)
            if (!encodingSettled && containsNonAscii(bytes)) {
                // Everything decoded so far was ASCII, so the decoder holds no partial character to lose.
                encodingSettled = true
                decoder = iconv.getDecoder(streamableEncoding(await detectEncoding(bytes)))
            }
            collector.feed(decoder.write(bytes))
            if (position >= size) reachedEnd = true
        }
        if (reachedEnd) {
            const tail = decoder.end()
            if (tail) collector.feed(tail)
        }
        return collector.result(reachedEnd)
    } finally {
        await handle.close()
    }
}

type NormalizedRequest = Required<Omit<TextLineRangeRequest, "signal">> & { readonly signal?: AbortSignal }

function normalizeRequest(request: TextLineRangeRequest): NormalizedRequest {
    const maxBytes = Math.max(1, Math.floor(request.maxBytes))
    return {
        startLine: Math.max(1, Math.floor(request.startLine)),
        maxLines: Math.max(1, Math.floor(request.maxLines)),
        maxBytes,
        maxLineBytes: Math.min(maxBytes, Math.max(1, Math.floor(request.maxLineBytes))),
        lineOverheadBytes: request.lineOverheadBytes ?? (() => 0),
        maxScanBytes: request.maxScanBytes ?? MAX_LINE_SCAN_BYTES,
        countLookaheadBytes: request.countLookaheadBytes ?? TOTAL_LINE_COUNT_LOOKAHEAD_BYTES,
        signal: request.signal,
    }
}

/** Collects the requested lines and keeps counting the rest without retaining them. */
class LineCollector {
    private readonly lines: TextLine[] = []
    private scannedLines = 0
    private usedBytes = 0
    private stop: TextLineRangeStop | undefined
    private parts: string[] = []
    private keptBytes = 0
    private omittedBytes = 0
    /** Whether the line in progress has content, tracked when its text is not kept. */
    private pendingContent = false
    /** Whether the raw line in progress ends with `\r`, which belongs to its line break. */
    private endsWithCarriageReturn = false

    constructor(private readonly request: NormalizedRequest) {}

    get stopped(): boolean {
        return this.stop !== undefined
    }

    feed(text: string): void {
        let from = 0
        while (from < text.length) {
            const newline = text.indexOf("\n", from)
            const end = newline === -1 ? text.length : newline
            if (end > from) this.append(text, from, end)
            if (newline === -1) return
            this.completeLine()
            from = newline + 1
        }
    }

    result(reachedEnd: boolean): TextLineRange {
        if (reachedEnd && this.pendingContent) this.completeLine()
        const stop = this.stop ?? (reachedEnd ? "end_of_file" : "scan_limit")
        return {
            startLine: this.request.startLine,
            lines: this.lines,
            endLine: this.request.startLine + this.lines.length - 1,
            stop,
            ...(reachedEnd ? { totalLines: this.scannedLines } : {}),
            scannedLines: this.scannedLines,
        }
    }

    private collectsCurrentLine(): boolean {
        return this.stop === undefined && this.scannedLines + 1 >= this.request.startLine
    }

    private append(text: string, from: number, end: number): void {
        this.pendingContent = true
        if (!this.collectsCurrentLine()) return
        const segment = text.slice(from, end)
        this.endsWithCarriageReturn = segment.endsWith("\r")
        const bytes = Buffer.byteLength(segment, "utf8")
        // Once a line is cut the rest of it is omitted too, so no later fragment is spliced onto the kept prefix.
        if (this.omittedBytes > 0) {
            this.omittedBytes += bytes
            return
        }
        const room = this.request.maxLineBytes - this.keptBytes
        if (bytes <= room) {
            this.parts.push(segment)
            this.keptBytes += bytes
            return
        }
        const kept = room > 0 ? sliceUtf8(segment, room) : ""
        const keptBytes = Buffer.byteLength(kept, "utf8")
        if (kept) this.parts.push(kept)
        this.keptBytes += keptBytes
        this.omittedBytes += bytes - keptBytes
    }

    private completeLine(): void {
        const lineNumber = this.scannedLines + 1
        if (this.collectsCurrentLine()) this.collectLine(lineNumber)
        this.scannedLines = lineNumber
        this.parts = []
        this.keptBytes = 0
        this.omittedBytes = 0
        this.pendingContent = false
        this.endsWithCarriageReturn = false
    }

    private collectLine(lineNumber: number): void {
        let text = this.parts.join("")
        let textBytes = this.keptBytes
        let omittedBytes = this.omittedBytes
        if (this.endsWithCarriageReturn) {
            // The `\r` of a CRLF break is either the last kept byte or the last cut one.
            if (omittedBytes > 0) omittedBytes -= 1
            else {
                text = text.slice(0, -1)
                textBytes -= 1
            }
        }
        const cost = textBytes + 1 + this.request.lineOverheadBytes(lineNumber, omittedBytes)
        if (this.lines.length > 0 && this.usedBytes + cost > this.request.maxBytes) {
            this.stop = "max_bytes"
            return
        }
        this.lines.push({ text, omittedBytes })
        this.usedBytes += cost
        if (this.lines.length >= this.request.maxLines) this.stop = "max_lines"
    }
}

interface HeadEncoding {
    readonly encoding: string
    /**
     * False when the head is plain ASCII: it says nothing about later bytes, so
     * the first chunk with a byte above 0x7F decides the encoding instead.
     */
    readonly settled: boolean
}

async function detectStreamEncoding(
    handle: Awaited<ReturnType<typeof open>>,
    size: number,
    extension: string,
): Promise<HeadEncoding> {
    const buffer = Buffer.alloc(Math.min(size, ENCODING_SAMPLE_BYTES))
    if (buffer.length === 0) return { encoding: "utf8", settled: true }
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const sample = buffer.subarray(0, bytesRead)
    const detected = await detectEncoding(sample, extension || undefined)
    // NUL bytes mark UTF-16 text whose characters all fall in the ASCII range; keep that verdict.
    if (!containsNonAscii(sample) && !sample.includes(0)) return { encoding: "utf8", settled: false }
    return { encoding: streamableEncoding(detected), settled: true }
}

function containsNonAscii(bytes: Buffer): boolean {
    for (const byte of bytes) if (byte > 0x7f) return true
    return false
}

/**
 * A head sample that is pure ASCII says nothing about later bytes, and UTF-8
 * decodes ASCII identically while keeping any multi-byte text further down.
 */
function streamableEncoding(detected: string): string {
    if (/^(us-)?ascii$/i.test(detected)) return "utf8"
    return iconv.encodingExists(detected) ? detected : "utf8"
}

/** The longest prefix of `text` that fits in `maxBytes` UTF-8 bytes without splitting a character. */
function sliceUtf8(text: string, maxBytes: number): string {
    let bytes = 0
    let end = 0
    for (const character of text) {
        const size = utf8Size(character.codePointAt(0) ?? 0)
        if (bytes + size > maxBytes) break
        bytes += size
        end += character.length
    }
    return text.slice(0, end)
}

function utf8Size(codePoint: number): number {
    if (codePoint < 0x80) return 1
    if (codePoint < 0x800) return 2
    if (codePoint < 0x10000) return 3
    return 4
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new Error("Read cancelled")
}

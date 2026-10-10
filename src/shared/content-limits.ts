/** Content size limits that keep file extraction and canonical tool results bounded. */

/** Maximum raw extracted content size in bytes (400KB). */
export const MAX_CONTENT_SIZE_BYTES = 400 * 1024

/** Maximum text contributed by one canonical tool result (64KB). */
export const MAX_TOOL_RESULT_TEXT_BYTES = 64 * 1024

/**
 * Format bytes into a human-readable string (e.g., "1.5 MB", "400 KB").
 */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Truncate content if it exceeds the maximum size limit.
 * Shows the beginning of the content with a clear truncation notice at the very end.
 *
 * @param content The content to potentially truncate
 * @param maxSize Maximum size in bytes (defaults to MAX_CONTENT_SIZE_BYTES)
 * @returns The original content if under limit, or truncated content with message at end
 */
export function truncateContent(content: string, maxSize: number = MAX_CONTENT_SIZE_BYTES): string {
    const normalizedMaxSize = Math.max(0, Math.floor(maxSize))
    const contentBytes = Buffer.byteLength(content, "utf8")
    if (contentBytes <= normalizedMaxSize) {
        return content
    }
    if (normalizedMaxSize === 0) {
        return ""
    }

    const marker = `\n\n---\n\n[FILE TRUNCATED: This content is ${formatBytes(contentBytes)} but exceeds the ${formatBytes(normalizedMaxSize)} result limit. Read a smaller range or use search_files for targeted reading.]`
    const markerBytes = Buffer.byteLength(marker, "utf8")
    if (markerBytes >= normalizedMaxSize) {
        return sliceUtf8ToByteLimit(marker, normalizedMaxSize)
    }

    const body = sliceUtf8ToByteLimit(content, normalizedMaxSize - markerBytes)
    return `${body}${marker}`
}

function sliceUtf8ToByteLimit(content: string, maxBytes: number): string {
    let low = 0
    let high = content.length
    let best = 0
    while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        const candidate = content.slice(0, middle)
        if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
            best = middle
            low = middle + 1
        } else {
            high = middle - 1
        }
    }
    if (best > 0 && /[\uD800-\uDBFF]/.test(content.charAt(best - 1))) {
        best--
    }
    return content.slice(0, best)
}

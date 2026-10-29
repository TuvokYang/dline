/**
 * The media types input content is recorded under.
 *
 * One vocabulary for every stage that reads it: classification assigns these
 * types, extraction and rendering dispatch on them, and model capabilities are
 * declared in them. Format-to-type tables stay with the stage that owns the
 * format decision; only the shared names live here.
 */

export const PDF_MEDIA_TYPE = "application/pdf"
export const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
export const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
export const NOTEBOOK_MEDIA_TYPE = "application/x-ipynb+json"
export const PLAIN_TEXT_MEDIA_TYPE = "text/plain"

/** Content no reader understands; the model receives it whole as base64 text. */
export const OPAQUE_BINARY_MEDIA_TYPE = "application/octet-stream"

/** Image formats admitted as images and sent as inline image blocks. */
export const INLINE_IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const

export type InlineImageMediaType = (typeof INLINE_IMAGE_MEDIA_TYPES)[number]

export function isInlineImageMediaType(mediaType: string): mediaType is InlineImageMediaType {
    return (INLINE_IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)
}

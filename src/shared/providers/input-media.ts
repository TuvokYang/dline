import { INLINE_IMAGE_MEDIA_TYPES, PDF_MEDIA_TYPE } from "@shared/input-semantics/media-types"
import type { ModelInfo } from "./types"

/**
 * What a model is assumed to read natively when its metadata predates
 * `input_media_types`: `supportsImages` has always meant "accepts the inline
 * images we send", and only such models were ever sent native PDFs, so the
 * legacy set keeps exactly that behavior.
 */
const LEGACY_VISION_MEDIA_TYPES: readonly string[] = [...INLINE_IMAGE_MEDIA_TYPES, PDF_MEDIA_TYPE]

/**
 * The media types a model reads natively as user input.
 *
 * This is the single place that answers the question. A non-empty declaration
 * wins; an empty or missing one is undeclared, because protobuf cannot tell an
 * empty repeated field from an absent one and the answer must not depend on how
 * the metadata travelled. Undeclared metadata derives the legacy set from
 * `supportsImages`, so a text-only model is expressed by `supportsImages: false`.
 * Catalog JSON is not schema-checked, so malformed entries are ignored rather
 * than trusted. Whether a request can carry a type natively is a separate,
 * transport-level question answered by the API format.
 */
export function resolveInputMediaTypes(info: Pick<ModelInfo, "capabilities"> | undefined): ReadonlySet<string> {
    const declared = declaredMediaTypes(info?.capabilities?.inputMediaTypes)
    if (declared.length > 0) return new Set(declared)
    return new Set(info?.capabilities?.supportsImages === true ? LEGACY_VISION_MEDIA_TYPES : [])
}

function declaredMediaTypes(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value
        .filter((entry): entry is string => typeof entry === "string")
        .map(normalizeMediaType)
        .filter(Boolean)
}

/** Media types compare case-insensitively and without parameters such as `; charset=…`. */
export function normalizeMediaType(mediaType: string): string {
    return mediaType.split(";")[0].trim().toLowerCase()
}

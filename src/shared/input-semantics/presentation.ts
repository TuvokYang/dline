import type { ResourceInputNode, SemanticInputDocument, SemanticInputNode, SemanticResourceRef } from "./document"

/**
 * Stable text projection of one node.
 *
 * A resource is addressed by its stable resource id rather than its display
 * name, so renaming a display label never changes the projection that Core
 * compares against `rawText`.
 */
export function presentationTextOfNode(node: SemanticInputNode): string {
    switch (node.kind) {
        case "text":
        case "literal":
            return node.text
        case "slash_command":
        case "mention":
            return node.sourceText
        case "image":
            return `[image:${node.resourceId}]`
        case "file":
            return `[file:${node.resourceId}]`
    }
}

/** Stable text projection of the whole document, in node order. */
export function presentationTextOf(document: SemanticInputDocument): string {
    return document.nodes.map(presentationTextOfNode).join("")
}

/**
 * Whether `rawText` still matches the ordered nodes.
 *
 * A mismatch means the two views of the same draft disagree. Core may report it,
 * but it must never resolve the disagreement by re-reading `rawText`.
 */
export function documentMatchesPresentation(document: SemanticInputDocument): boolean {
    return document.rawText === presentationTextOf(document)
}

/** The visual family a resource is shown as; the composer maps each to an icon. */
export type ResourceVisualKind = "image" | "pdf" | "text" | "code" | "document" | "spreadsheet" | "notebook" | "data" | "file"

/** What the composer shows for one resource, independent of any rendering technology. */
export interface ResourcePresentation {
    readonly visualKind: ResourceVisualKind
    /** Short uppercase format label, e.g. "PDF" or "XLSX"; never longer than eight characters. */
    readonly formatBadge: string
}

const VISUAL_KIND_BY_EXTENSION: Readonly<Record<string, ResourceVisualKind>> = {
    pdf: "pdf",
    txt: "text",
    log: "text",
    md: "text",
    markdown: "text",
    rst: "text",
    doc: "document",
    docx: "document",
    odt: "document",
    rtf: "document",
    xls: "spreadsheet",
    xlsx: "spreadsheet",
    ods: "spreadsheet",
    ipynb: "notebook",
    csv: "data",
    tsv: "data",
    json: "data",
    jsonl: "data",
    xml: "data",
    yaml: "data",
    yml: "data",
    toml: "data",
    ts: "code",
    tsx: "code",
    js: "code",
    jsx: "code",
    mjs: "code",
    cjs: "code",
    py: "code",
    java: "code",
    kt: "code",
    go: "code",
    rs: "code",
    c: "code",
    h: "code",
    cpp: "code",
    hpp: "code",
    cs: "code",
    rb: "code",
    php: "code",
    swift: "code",
    sh: "code",
    ps1: "code",
    sql: "code",
    html: "code",
    css: "code",
    scss: "code",
    vue: "code",
}

const EXTENSION_BY_MEDIA_TYPE: Readonly<Record<string, string>> = {
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/webp": "webp",
    "image/gif": "gif",
    "application/pdf": "pdf",
    "text/plain": "txt",
    "text/markdown": "md",
    "text/csv": "csv",
    "application/json": "json",
    "application/xml": "xml",
    "text/xml": "xml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/x-ipynb+json": "ipynb",
}

/** Media types that say nothing about the format, so the display name decides. */
const GENERIC_MEDIA_TYPES: ReadonlySet<string> = new Set(["text/plain", "application/octet-stream"])

const MAX_BADGE_LENGTH = 8
const DEFAULT_FILE_BADGE = "FILE"
const DEFAULT_IMAGE_BADGE = "IMG"

/** The lowercase extension of a display name, without the dot. */
function extensionOf(displayName: string): string | undefined {
    const dot = displayName.lastIndexOf(".")
    if (dot <= 0 || dot === displayName.length - 1) return undefined
    return displayName.slice(dot + 1).toLowerCase()
}

/** The essence of a media type: lowercase, without parameters such as `charset`. */
function normalizeMediaType(mediaType: string): string {
    return mediaType.split(";")[0].trim().toLowerCase()
}

/** An extension reduced to a badge that cannot carry markup or prose. */
function badgeOf(extension: string | undefined, fallback: string): string {
    const badge = (extension ?? "").toUpperCase().replace(/[^A-Z0-9-]/g, "")
    return badge.length > 0 && badge.length <= MAX_BADGE_LENGTH ? badge : fallback
}

/**
 * How one resource node is shown.
 *
 * A specific media type verified by Core decides first, because the display
 * name is user-controlled and may claim a format the bytes do not have. A
 * generic media type (plain text, octet stream) says nothing about the format,
 * so the name's extension decides then, and the media type only fills in when
 * the name has none. An image node is always an image, whatever its name says.
 */
export function describeResourcePresentation(node: ResourceInputNode, resource?: SemanticResourceRef): ResourcePresentation {
    const mediaType = resource ? normalizeMediaType(resource.mediaType) : undefined
    const verifiedExtension = mediaType ? EXTENSION_BY_MEDIA_TYPE[mediaType] : undefined
    const specificExtension = mediaType && !GENERIC_MEDIA_TYPES.has(mediaType) ? verifiedExtension : undefined
    const extension = specificExtension ?? extensionOf(node.displayName) ?? verifiedExtension
    if (node.kind === "image") return { visualKind: "image", formatBadge: badgeOf(extension, DEFAULT_IMAGE_BADGE) }
    const visualKind = (extension && VISUAL_KIND_BY_EXTENSION[extension]) || "file"
    return { visualKind, formatBadge: badgeOf(extension, DEFAULT_FILE_BADGE) }
}

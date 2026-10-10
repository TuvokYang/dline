/**
 * The semantic input document: the single truth for one chat submission.
 *
 * The composer decides which semantic entities the user chose; the ordered
 * `nodes` are the authority for send order. `rawText` exists for accessibility,
 * history display and legacy mirroring, and is never re-parsed to discover
 * additional commands or mentions.
 *
 * Schema version 1 only grows additively: every persisted version 1 document
 * must stay readable, so a field or node kind is never removed or repurposed.
 */

export const SEMANTIC_INPUT_SCHEMA_VERSION = 1

/** How a semantic entity stands at submission time. */
export type SemanticEntityState = "recognized" | "partial" | "unresolved" | "invalid" | "disabled" | "stale" | "literal"

/** Where a slash command comes from. */
export type SlashCommandNamespace = "cmd" | "workflow" | "skill" | "mcp"

/** Whether a command composes with later commands or closes the turn's command sequence. */
export type SlashCommandComposition = "composable" | "lifecycle_barrier"

export type MentionKind = "file" | "folder" | "url" | "problems" | "terminal" | "git_changes" | "git_commit"

/** When a mention's content is captured. */
export type MentionCapturePolicy = "snapshot_at_submit" | "resolve_at_execute"

/** How a file node entered the document. */
export type FileNodeOrigin = "pasted_text" | "pasted_file" | "uploaded_file"

/** Where a span of input came from. */
export type InputSource = "typed" | "pasted" | "app_action" | "editor_selection" | "model_prefill" | "restored"

export const INPUT_SOURCES: readonly InputSource[] = [
    "typed",
    "pasted",
    "app_action",
    "editor_selection",
    "model_prefill",
    "restored",
]

export interface TextInputNode {
    readonly kind: "text"
    readonly text: string
}

/**
 * Opaque text.
 *
 * Content the user did not type as intent, such as an editor selection, a
 * pasted log or a model prefill, stays a literal: a `/command` or `@target`
 * shape inside it never activates, whatever the catalog says.
 */
export interface LiteralInputNode {
    readonly kind: "literal"
    readonly text: string
    readonly source: InputSource
}

export interface SlashCommandInputNode {
    readonly kind: "slash_command"
    readonly entityId: string
    /** Catalog descriptor identity, e.g. "command.compact". */
    readonly commandId: string
    readonly sourceText: string
    readonly canonicalName: string
    readonly namespace: SlashCommandNamespace
    readonly compositionMode: SlashCommandComposition
    readonly state: SemanticEntityState
}

export interface MentionInputNode {
    readonly kind: "mention"
    readonly entityId: string
    readonly mentionKind: MentionKind
    readonly sourceText: string
    readonly canonicalRef: string
    readonly workspaceHint?: string
    readonly capturePolicy?: MentionCapturePolicy
    readonly state: SemanticEntityState
}

export interface ImageInputNode {
    readonly kind: "image"
    readonly entityId: string
    readonly resourceId: string
    readonly displayName: string
    readonly altText?: string
}

export interface FileInputNode {
    readonly kind: "file"
    readonly entityId: string
    readonly resourceId: string
    readonly fileOrigin: FileNodeOrigin
    readonly displayName: string
    readonly lineCount?: number
}

export type SemanticInputNode =
    | TextInputNode
    | LiteralInputNode
    | SlashCommandInputNode
    | MentionInputNode
    | ImageInputNode
    | FileInputNode

/** A node that only contributes text and carries no entity identity. */
export type ContentInputNode = TextInputNode | LiteralInputNode

/** A node that carries an identity the composer, queue and diagnostics address directly. */
export type IdentifiedInputNode = Exclude<SemanticInputNode, ContentInputNode>

/** A node backed by an owned local resource. */
export type ResourceInputNode = ImageInputNode | FileInputNode

/** Who holds a resource's bytes: a composer draft before its task exists, or a task. */
export type InputResourceOwner =
    | { readonly kind: "draft"; readonly draftId: string }
    | { readonly kind: "task"; readonly taskId: string }

/**
 * A reference to an owned input resource.
 *
 * The document never carries a path or payload: the hash freezes which content
 * this submission agreed to, so a later edit of the same file cannot silently
 * change an already confirmed input. Media type and size are what the composer
 * may show; owner and generation are claims Core verifies against its own
 * record, and both change when a draft is adopted or a successor copies it.
 */
export interface SemanticResourceRef {
    readonly resourceId: string
    readonly expectedContentHash: string
    readonly mediaType: string
    readonly byteLength: number
    readonly owner: InputResourceOwner
    readonly generation: number
}

export interface SemanticInputDocument {
    readonly schemaVersion: typeof SEMANTIC_INPUT_SCHEMA_VERSION
    readonly parserVersion: string
    readonly catalogRevision: string
    readonly documentId: string
    readonly rawText: string
    readonly nodes: readonly SemanticInputNode[]
    readonly resources: readonly SemanticResourceRef[]
}

export function isTextNode(node: SemanticInputNode): node is TextInputNode {
    return node.kind === "text"
}

export function isLiteralNode(node: SemanticInputNode): node is LiteralInputNode {
    return node.kind === "literal"
}

export function isContentNode(node: SemanticInputNode): node is ContentInputNode {
    return isTextNode(node) || isLiteralNode(node)
}

export function isSlashCommandNode(node: SemanticInputNode): node is SlashCommandInputNode {
    return node.kind === "slash_command"
}

export function isMentionNode(node: SemanticInputNode): node is MentionInputNode {
    return node.kind === "mention"
}

export function isResourceNode(node: SemanticInputNode): node is ResourceInputNode {
    return node.kind === "image" || node.kind === "file"
}

export function isIdentifiedNode(node: SemanticInputNode): node is IdentifiedInputNode {
    return !isContentNode(node)
}

/** The reference a resource node points at, when the document binds it. */
export function resourceRefOf(document: SemanticInputDocument, node: ResourceInputNode): SemanticResourceRef | undefined {
    return document.resources.find((resource) => resource.resourceId === node.resourceId)
}

/** True when the entity takes effect on submit; any other state is content, not intent. */
export function isActiveEntity(node: SlashCommandInputNode | MentionInputNode): boolean {
    return node.state === "recognized"
}

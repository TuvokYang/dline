/**
 * The semantic input document: the single truth for one chat submission.
 *
 * The composer decides which semantic entities the user chose; the ordered
 * `nodes` are the authority for send order. `rawText` exists for accessibility,
 * history display and legacy mirroring, and is never re-parsed to discover
 * additional commands or mentions.
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

export interface TextInputNode {
    readonly kind: "text"
    readonly text: string
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

export type SemanticInputNode = TextInputNode | SlashCommandInputNode | MentionInputNode | ImageInputNode | FileInputNode

/** A node that carries an identity the composer, queue and diagnostics address directly. */
export type IdentifiedInputNode = Exclude<SemanticInputNode, TextInputNode>

/** A node backed by a task-owned local resource. */
export type ResourceInputNode = ImageInputNode | FileInputNode

/**
 * A binding to a task-owned resource.
 *
 * The document never carries a path or payload: the hash freezes which content
 * this submission agreed to, so a later edit of the same file cannot silently
 * change an already confirmed input.
 */
export interface SemanticResourceBindingRef {
    readonly resourceId: string
    readonly expectedContentHash: string
}

export interface SemanticInputDocument {
    readonly schemaVersion: typeof SEMANTIC_INPUT_SCHEMA_VERSION
    readonly parserVersion: string
    readonly catalogRevision: string
    readonly documentId: string
    readonly rawText: string
    readonly nodes: readonly SemanticInputNode[]
    readonly resources: readonly SemanticResourceBindingRef[]
}

export function isTextNode(node: SemanticInputNode): node is TextInputNode {
    return node.kind === "text"
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
    return !isTextNode(node)
}

/** True when the entity takes effect on submit; any other state is content, not intent. */
export function isActiveEntity(node: SlashCommandInputNode | MentionInputNode): boolean {
    return node.state === "recognized"
}

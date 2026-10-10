import type { SemanticInputDocument } from "./input-semantics/document"

/**
 * The draft a mode or profile transition carries.
 *
 * When `semanticInput` is present it is the only semantic truth: its nodes keep
 * the commands, mentions, literals and resource references the user composed.
 * `message`, `images` and `files` are the legacy mirror older clients send;
 * they are never parsed again while a document is present.
 *
 * The RPC boundary decodes and validates the document. Carrying it through the
 * transition snapshot, confirmation and reply chain is owned by WS-041
 * TASK-4106; until then that chain still forwards only the mirror.
 */
export interface ChatContent {
    message?: string
    images?: string[]
    files?: string[]
    semanticInput?: SemanticInputDocument
}

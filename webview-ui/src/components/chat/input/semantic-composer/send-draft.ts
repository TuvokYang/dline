import type { InputSemanticCatalog } from "@shared/input-semantics/catalog"
import type { SemanticInputDocument } from "@shared/input-semantics/document"
import { type ComposerSegment, resourceAtomsOf } from "./model"
import { composeComposerSubmission } from "./projection"

/**
 * One send, frozen at the moment the user sent it.
 *
 * `text` and `semanticInput` are what every submission path dispatches.
 * `segments` is the draft itself: a path that adds its own literal, such as a
 * new task's quote, composes from the structure instead of the text, and a
 * refused send can put back exactly what was sent. The flat `images` and
 * `files` stay empty because attachments travel as resource nodes of the
 * document; they remain only for the mode-switch and interaction contracts that
 * still carry them.
 */
export interface ComposerSendDraft {
    readonly segments: readonly ComposerSegment[]
    text: string
    images: string[]
    files: string[]
    semanticInput?: SemanticInputDocument
}

/** Why the draft cannot be sent as it stands; the user can see and resolve each one. */
export type ComposerSendBlock =
    /** An attachment is still being staged by the host. */
    | "staging"
    /** An attachment failed to stage and must be retried or removed. */
    | "failed"

/**
 * Why a send the user made did not go out. Besides the draft's own blocks,
 * the task may not take input yet while nothing can hold the draft for it;
 * the draft then stays in the composer and the user is told so instead of
 * the send vanishing without a trace.
 */
export type ComposerSendRefusal = ComposerSendBlock | "input_not_ready"

export interface ComposerSendContext {
    readonly catalog: InputSemanticCatalog
    readonly documentId: string
    /** Freeze the draft as plain text, so no command or mention in it runs; see `composeComposerSubmission`. */
    readonly plainText?: boolean
}

export type ComposerSendCapture =
    | { readonly ok: true; readonly draft: ComposerSendDraft }
    | { readonly ok: false; readonly block: ComposerSendBlock }

/** The reason the draft cannot be sent, or undefined when it can. */
export function composerSendBlock(segments: readonly ComposerSegment[]): ComposerSendBlock | undefined {
    const resources = resourceAtomsOf(segments)
    if (resources.some((atom) => atom.status === "staging")) return "staging"
    if (resources.some((atom) => atom.status === "failed")) return "failed"
    return undefined
}

/**
 * Freeze the draft into one send.
 *
 * The composition is the same one the chat view derives its interaction draft
 * from, with the same document identity, so an accepted send is recognized as
 * the draft the composer still shows and clears it.
 */
export function captureComposerSend(segments: readonly ComposerSegment[], context: ComposerSendContext): ComposerSendCapture {
    const block = composerSendBlock(segments)
    if (block) return { ok: false, block }
    const { text, semanticInput } = composeComposerSubmission(segments, context)
    return {
        ok: true,
        draft: {
            segments,
            text,
            images: [],
            files: [],
            ...(semanticInput === undefined ? {} : { semanticInput }),
        },
    }
}

/** The message shown while a send is refused. */
export function describeSendBlock(refusal: ComposerSendRefusal): string {
    switch (refusal) {
        case "staging":
            return "Attachments are still being added. Send again once they are ready."
        case "failed":
            return "An attachment could not be added. Retry or remove it before sending."
        case "input_not_ready":
            return "Dline cannot take input yet. Your message was kept; send it again once the input is ready."
    }
}

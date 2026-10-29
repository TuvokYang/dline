import type { InputSemanticCatalog } from "@shared/input-semantics/catalog"
import { createMentionAtom } from "./atoms"
import type { SemanticComposerEngine } from "./engine"
import { type ComposerTextSource, contentLength } from "./model"

/** Content an app action adds to the composer; mirrors the `AddToInputEvent` wire message. */
export interface AddToInputContent {
    /** The complete content as plain text. */
    readonly text: string
    /** Workspace mention reference of an editor selection's file, without the leading "@". */
    readonly mentionReference?: string
    /** An editor selection's fenced code plus any notebook context or problems. */
    readonly selection?: string
}

/**
 * Append an app action's content to the end of the draft, on its own line.
 *
 * An editor selection arrives as its file's mention atom followed by the fenced
 * code as one `editor_selection` literal, so nothing inside the code can run as
 * a command or mention. Plain text keeps the typed-text behaviour, and so does a
 * selection whose file the catalog cannot mention: inserting the code without
 * its file would silently drop the context the user asked to add.
 */
export function appendAddToInput(
    engine: SemanticComposerEngine,
    catalog: InputSemanticCatalog,
    content: AddToInputContent,
): void {
    const separator = contentLength(engine.getState().segments) > 0 ? "\n" : ""
    const { selection, mentionReference } = content
    const atom = selection && mentionReference ? createMentionAtom(catalog, mentionReference) : undefined
    if (!selection || (mentionReference && !atom)) {
        appendText(engine, `${separator}${content.text}\n`, "typed")
        return
    }
    if (separator) appendText(engine, separator, "app_action")
    if (atom) {
        const end = contentLength(engine.getState().segments)
        engine.apply({ type: "insert_atom", atom, range: { start: end, end } })
    }
    appendText(engine, selection, "editor_selection")
    appendText(engine, "\n", "app_action")
}

function appendText(engine: SemanticComposerEngine, text: string, source: ComposerTextSource): void {
    const end = contentLength(engine.getState().segments)
    engine.apply({ type: "insert_text", text, source, range: { start: end, end } })
}

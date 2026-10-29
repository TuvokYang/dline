import type { MentionKind } from "./document"

/**
 * The spelling rules of a mention reference: what follows the `@` sigil.
 *
 * The scanner decides where a mention starts and ends; this module decides
 * what a matched reference means and how a reference must be written so the
 * scanner reads it back whole. Keeping both directions here is what lets a menu
 * pick, an application insertion and admission agree on the same entity.
 */

/** A mention reference with its spelling removed. */
export interface MentionReference {
    readonly kind: MentionKind
    /** The reference without quotes and without a workspace prefix, e.g. `/src/my file.ts`. */
    readonly ref: string
    /** The workspace root named by a `name:` prefix, when the reference has one. */
    readonly workspaceHint?: string
}

const QUOTE = '"'
const GIT_COMMIT = /^[a-f0-9]{7,40}$/
const URL_SCHEME = /^\w+:\/\//
/** A workspace prefix addresses a root by name and is followed by a path, quoted or not. */
const WORKSPACE_PREFIXED = /^([\w-]+):("?\/.*)$/
/**
 * An unquoted path ends at whitespace, and trailing punctuation is read as
 * prose after the mention, so a path containing either must be quoted.
 */
const NEEDS_QUOTES = /\s|[.,;:!?()]$/

const SELF_CONTAINED: Readonly<Record<string, MentionKind>> = {
    problems: "problems",
    terminal: "terminal",
    "git-changes": "git_changes",
}

function unquote(path: string): string {
    return path.length >= 2 && path.startsWith(QUOTE) && path.endsWith(QUOTE) ? path.slice(1, -1) : path
}

function pathKind(path: string): MentionKind {
    return path.endsWith("/") ? "folder" : "file"
}

/**
 * Read a reference as the scanner matched it, without its `@` sigil.
 *
 * Quotes only delimit a path that contains spaces, so they never become part
 * of `ref` and never decide its kind: `"/a b/"` is the folder `/a b/`.
 */
export function parseMentionReference(reference: string): MentionReference {
    const selfContained = SELF_CONTAINED[reference]
    if (selfContained) return { kind: selfContained, ref: reference }
    if (GIT_COMMIT.test(reference)) return { kind: "git_commit", ref: reference }
    if (URL_SCHEME.test(reference)) return { kind: "url", ref: reference }

    const prefixed = WORKSPACE_PREFIXED.exec(reference)
    if (prefixed) {
        const ref = unquote(prefixed[2])
        return { kind: pathKind(ref), ref, workspaceHint: prefixed[1] }
    }
    const ref = unquote(reference)
    return { kind: pathKind(ref), ref }
}

/**
 * Spell an unquoted reference so the scanner reads it back as one mention.
 *
 * A path that would end early - at a space or before trailing punctuation - is
 * quoted, after its workspace prefix when it has one. Anything else is written
 * as given; a reference the grammar cannot express at all, such as a path that
 * contains a quote, is left for the caller's read-back check to refuse.
 */
export function formatMentionReference(reference: string): string {
    if (SELF_CONTAINED[reference] || GIT_COMMIT.test(reference) || URL_SCHEME.test(reference)) return reference
    const prefixed = WORKSPACE_PREFIXED.exec(reference)
    const prefix = prefixed ? `${prefixed[1]}:` : ""
    const path = prefixed ? prefixed[2] : reference
    if (!path.startsWith("/") || !NEEDS_QUOTES.test(path)) return reference
    return `${prefix}${QUOTE}${path}${QUOTE}`
}

/** True when two references name the same entity, whatever their spelling. */
export function sameMentionReference(left: MentionReference, right: MentionReference): boolean {
    return left.kind === right.kind && left.ref === right.ref && left.workspaceHint === right.workspaceHint
}

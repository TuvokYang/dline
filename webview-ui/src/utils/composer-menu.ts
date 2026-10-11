import { semanticTriggerAt } from "@shared/input-semantics/lexer"

/** The completion menu the caret opens, with the partial name it completes. */
export type ComposerMenuQuery =
    | { readonly menu: "slash"; readonly query: string }
    | { readonly menu: "mention"; readonly query: string }

/** Mention references that are complete as typed, so the mention menu has nothing to offer for them. */
const SELF_CONTAINED_MENTION_PREFIXES = ["http", "problems", "terminal"] as const

function offersMentionCompletions(query: string): boolean {
    const reference = query.toLowerCase()
    return !SELF_CONTAINED_MENTION_PREFIXES.some((prefix) => reference.startsWith(prefix))
}

/**
 * Which completion menu the caret opens, from one scan of the draft.
 *
 * Uses the scanner's own trigger rules, so a menu never opens where a picked
 * entity would be sent as text: inside code, after an escaping backslash, or
 * inside a URL, path or e-mail address. At most one menu applies, because the
 * caret completes at most one sigil.
 */
export function composerMenuQueryAt(text: string, caret: number): ComposerMenuQuery | undefined {
    const trigger = semanticTriggerAt(text, caret)
    if (trigger?.kind === "command") return { menu: "slash", query: trigger.query }
    if (trigger?.kind === "mention" && offersMentionCompletions(trigger.query)) return { menu: "mention", query: trigger.query }
    return undefined
}

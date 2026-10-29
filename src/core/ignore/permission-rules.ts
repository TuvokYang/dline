/**
 * Permission attributes for agent ignore files.
 *
 * A plain ignore file can only say "excluded" or "not excluded", which forces
 * one decision onto every operation. Listing a huge generated tree and opening
 * one named file inside it have very different costs and very different risks,
 * so a single boolean cannot express what a project actually wants.
 *
 * An `.agentignore` line may therefore carry trailing attributes that remove
 * individual permissions, following two established conventions: attributes sit
 * after the pattern as in `.gitattributes`, and `-x` removes a permission as in
 * `chmod`.
 *
 * ```gitignore
 * secrets/            # no attributes: every permission is removed
 * tmp/          -s    # hidden from listings, still readable and writable
 * vendor/       -w    # read-only
 * build/        -s -w # hidden and read-only
 * coverage/     -sw   # the same, written compactly
 * ```
 *
 * Keeping the attributes at the end means the pattern reaches the matcher
 * untouched, so negation, globs and escapes keep their exact gitignore meaning.
 */

/** One agent-controlled operation on a path. */
export type IgnorePermission = "read" | "write" | "execute" | "scan"

/** Every permission, in the order used for diagnostics. */
export const IGNORE_PERMISSIONS: readonly IgnorePermission[] = ["read", "write", "execute", "scan"]

/** Rule text grouped by the permission each rule removes. */
export type PermissionRuleSet = Record<IgnorePermission, string>

const ATTRIBUTE_LETTERS: Readonly<Record<string, IgnorePermission>> = {
    r: "read",
    w: "write",
    x: "execute",
    s: "scan",
}

/** A trailing token that removes one or more permissions, such as `-s` or `-sw`. */
const ATTRIBUTE_TOKEN = /^-[rwxs]+$/

/** Create an empty rule set. */
function emptyRuleSet(): Record<IgnorePermission, string[]> {
    return { read: [], write: [], execute: [], scan: [] }
}

/**
 * Report whether the character at an index is escaped by a preceding backslash.
 *
 * Gitignore escapes a literal space as `\ `, so `build\ -w` names the file
 * `build -w` rather than carrying a `-w` attribute. Counting the run of
 * backslashes distinguishes an escaped space from a literal backslash that
 * merely happens to precede one.
 */
function isEscaped(text: string, index: number): boolean {
    let backslashes = 0
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
        backslashes++
    }
    return backslashes % 2 === 1
}

/**
 * Split one line into its gitignore pattern and the permissions it removes.
 *
 * Tokens are consumed from the end while they look like attributes. The scan
 * stops at the first token that does not match, and at any separator the
 * pattern escaped, so a filename containing spaces is never mistaken for an
 * attribute list.
 *
 * @param line One raw line, already known to be neither blank nor a comment.
 * @returns The pattern and the permissions to remove; an empty set means all.
 */
function splitLine(line: string): { pattern: string; removed: Set<IgnorePermission> } {
    const removed = new Set<IgnorePermission>()
    let pattern = line

    while (true) {
        const match = /\s+(\S+)$/.exec(pattern)
        const token = match?.[1]
        if (!match || !token || !ATTRIBUTE_TOKEN.test(token)) break
        if (isEscaped(pattern, match.index)) break

        for (const letter of token.slice(1)) {
            const permission = ATTRIBUTE_LETTERS[letter]
            if (permission) removed.add(permission)
        }
        pattern = pattern.slice(0, match.index)
    }

    return { pattern: pattern.trimEnd(), removed }
}

/**
 * Group the lines of an agent ignore file by the permission each one removes.
 *
 * Blank lines and comments are dropped. A line without attributes removes every
 * permission, which is what a plain ignore file has always meant, so existing
 * files keep working unchanged.
 *
 * @param content Raw file text, or undefined when no file contributed.
 * @returns One gitignore-syntax rule text per permission; empty when unused.
 */
export function parsePermissionRules(content: string | undefined): PermissionRuleSet {
    const grouped = emptyRuleSet()
    if (!content) return { read: "", write: "", execute: "", scan: "" }

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith("#")) continue

        const { pattern, removed } = splitLine(line)
        if (!pattern) continue

        const targets = removed.size > 0 ? removed : IGNORE_PERMISSIONS
        for (const permission of targets) {
            grouped[permission].push(pattern)
        }
    }

    return {
        read: grouped.read.join("\n"),
        write: grouped.write.join("\n"),
        execute: grouped.execute.join("\n"),
        scan: grouped.scan.join("\n"),
    }
}

/**
 * Layer additional rule text underneath one permission of an existing set.
 *
 * Used to add repository rules and the built-in directory floor to the scan
 * permission without touching the others. The extra rules go first because a
 * later gitignore rule wins: keeping the workspace's own lines last lets a
 * negation such as `!audit.log` re-admit a path the repository excluded.
 *
 * @param rules The set to extend; not modified.
 * @param permission Which permission receives the extra rules.
 * @param additional Rule text in gitignore syntax; ignored when empty.
 */
export function withAdditionalRules(
    rules: PermissionRuleSet,
    permission: IgnorePermission,
    additional: string | undefined,
): PermissionRuleSet {
    if (!additional) return rules
    const existing = rules[permission]
    return { ...rules, [permission]: existing ? `${additional}\n${existing}` : additional }
}

const TOKEN_MARKER = "@"

/**
 * Expands explicitly declared structural prompt slots without resolving runtime env tokens.
 * Inserted fragments are not rescanned, so nested runtime tokens remain unresolved for the
 * single complete-template generation boundary.
 */
export function assemblePromptFragments(template: string, fragments: Readonly<Record<string, string>>): string {
    let output = ""
    let index = 0

    while (index < template.length) {
        if (template[index] !== TOKEN_MARKER) {
            output += template[index]
            index += 1
            continue
        }

        const endIndex = template.indexOf(TOKEN_MARKER, index + 1)
        if (endIndex < 0) {
            output += TOKEN_MARKER
            index += 1
            continue
        }

        const key = template.slice(index + 1, endIndex)
        if (!Object.hasOwn(fragments, key)) {
            output += template.slice(index, endIndex + 1)
            index = endIndex + 1
            continue
        }

        output += fragments[key]
        index = endIndex + 1
    }

    return output
}

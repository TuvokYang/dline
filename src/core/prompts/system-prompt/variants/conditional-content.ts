/** Removes exact optional prompt fragments while preserving all remaining source text. */
export function withoutPromptFragments(text: string, fragments: readonly string[]): string {
    return fragments.reduce((result, fragment) => result.replace(fragment, ""), text)
}

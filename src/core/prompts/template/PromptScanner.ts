const TOKEN_START = "@"

/** Reads prompt tokens with a single left-to-right scan. */
export class PromptScanner {
    /**
     * Renders supported prompt tokens without rescanning inserted values.
     *
     * @param template Raw prompt template.
     * @param resolve Resolves a valid token key or returns undefined when missing.
     * @param missing Records a missing valid token key.
     * @returns Rendered prompt text.
     */
    public render(template: string, resolve: (key: string) => string | undefined, missing: (key: string) => void): string {
        let output = ""
        let index = 0

        while (index < template.length) {
            if (template[index] !== TOKEN_START) {
                output += template[index]
                index += 1
                continue
            }

            const escaped = this.readEscaped(template, index)
            if (escaped) {
                output += `@${escaped.key}@`
                index = escaped.nextIndex
                continue
            }

            const token = this.readToken(template, index)
            if (!token) {
                output += TOKEN_START
                index += 1
                continue
            }

            const value = resolve(token.key)
            if (value === undefined) {
                output += template.slice(index, token.nextIndex)
                missing(token.key)
            } else {
                output += value
            }
            index = token.nextIndex
        }

        return output
    }

    /**
     * Reads an escaped token beginning at an index.
     *
     * @param template Raw prompt template.
     * @param index Candidate token index.
     * @returns Escaped token data or undefined when not matched.
     */
    private readEscaped(template: string, index: number): { readonly key: string; readonly nextIndex: number } | undefined {
        if (template[index + 1] !== TOKEN_START) {
            return undefined
        }

        const endIndex = template.indexOf("@@", index + 2)
        if (endIndex < 0) {
            return undefined
        }

        const key = template.slice(index + 2, endIndex)
        if (!this.isTokenKey(key)) {
            return undefined
        }

        return { key, nextIndex: endIndex + 2 }
    }

    /**
     * Reads a regular token beginning at an index.
     *
     * @param template Raw prompt template.
     * @param index Candidate token index.
     * @returns Token data or undefined when not matched.
     */
    private readToken(template: string, index: number): { readonly key: string; readonly nextIndex: number } | undefined {
        const endIndex = template.indexOf(TOKEN_START, index + 1)
        if (endIndex < 0) {
            return undefined
        }

        const key = template.slice(index + 1, endIndex)
        if (!this.isTokenKey(key)) {
            return undefined
        }

        return { key, nextIndex: endIndex + 1 }
    }

    /**
     * Validates the uppercase prompt token key grammar.
     *
     * @param key Candidate token key.
     * @returns Whether the key follows the prompt token grammar.
     */
    private isTokenKey(key: string): boolean {
        return /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(key)
    }
}

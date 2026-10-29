import { PromptScanner } from "../../template/PromptScanner"
import { PromptPackError } from "./errors"
import type { PromptDescriptor, PromptEntries } from "./types"

const promptScanner = new PromptScanner()

/**
 * Defines and validates one static prompt module descriptor.
 *
 * @param descriptor Static prompt module metadata and entries.
 * @returns The same descriptor with literal name and keys preserved.
 */
export function definePromptModule<Name extends string, Entries extends PromptEntries>(
    descriptor: PromptDescriptor<Name, Entries>,
): PromptDescriptor<Name, Entries> {
    if (descriptor.name.length === 0) {
        throw new PromptPackError({ reason: "empty-module", source: descriptor.source })
    }

    const allowedEmpty = new Set<string>((descriptor.allowEmptyKeys ?? []).map(String))
    for (const [key, prompt] of Object.entries(descriptor.prompts)) {
        validatePrompt(descriptor, key, prompt, allowedEmpty)
    }
    for (const key of Object.keys(descriptor.contracts)) {
        if (!(key in descriptor.prompts)) {
            throw new PromptPackError({
                reason: "contract-key-mismatch",
                module: descriptor.name,
                key,
                source: descriptor.source,
            })
        }
    }

    return descriptor
}

/**
 * Validates one prompt entry and its optional contract.
 *
 * @param descriptor Owning prompt descriptor.
 * @param key Prompt entry key.
 * @param prompt Raw prompt text.
 * @param allowedEmpty Explicitly allowed empty keys.
 */
function validatePrompt(descriptor: PromptDescriptor, key: string, prompt: string, allowedEmpty: ReadonlySet<string>): void {
    if (key.length === 0) {
        throw new PromptPackError({ reason: "empty-key", module: descriptor.name, source: descriptor.source })
    }
    if (prompt.length === 0 && !allowedEmpty.has(key)) {
        throw new PromptPackError({
            reason: "empty-prompt",
            module: descriptor.name,
            key,
            source: descriptor.source,
        })
    }

    const contract = descriptor.contracts[key]
    const tokens = extractTokens(prompt)
    if (tokens.length > 0 && !contract) {
        throw new PromptPackError({
            reason: "missing-contract",
            module: descriptor.name,
            key,
            source: descriptor.source,
        })
    }
    if (!contract) {
        return
    }

    const tokenSet = new Set(tokens)
    for (const variable of Object.keys(contract.variables)) {
        if (!tokenSet.has(variable)) {
            throw new PromptPackError({
                reason: "unused-contract-variable",
                module: descriptor.name,
                key,
                source: descriptor.source,
            })
        }
    }
}

/**
 * Extracts unique unescaped prompt token keys.
 *
 * @param prompt Raw prompt text.
 * @returns Unique prompt token keys in declaration order.
 */
function extractTokens(prompt: string): string[] {
    const tokens: string[] = []
    promptScanner.render(
        prompt,
        (key) => {
            if (!tokens.includes(key)) {
                tokens.push(key)
            }
            return ""
        },
        () => undefined,
    )
    return tokens
}

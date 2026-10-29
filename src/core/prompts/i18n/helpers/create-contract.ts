import type { EnvRule, PromptContract } from "../../template/types"
import type { PromptEntries } from "./types"

const RUNTIME_RULE: EnvRule = {
    stages: ["runtime"],
    required: true,
}

/**
 * Creates a required runtime-stage contract for the supplied token keys.
 *
 * @param keys Declared UPPER_SNAKE_CASE prompt token keys.
 * @returns A prompt contract that accepts every key only at runtime.
 */
export function createRuntimeContract(...keys: readonly string[]): PromptContract {
    const variables: Record<string, EnvRule> = {}
    for (const key of keys) {
        variables[key] = RUNTIME_RULE
    }
    return { variables }
}

/**
 * Creates per-key runtime contracts from statically imported prompt entries.
 *
 * @param entries Static prompt entries whose tokens use the canonical protocol.
 * @returns Contracts for entries that declare one or more runtime tokens.
 */
export function createRuntimeContracts(entries: PromptEntries): Readonly<Record<string, PromptContract>> {
    const contracts: Record<string, PromptContract> = {}
    for (const [entryKey, prompt] of Object.entries(entries)) {
        const keys = [...prompt.matchAll(/@([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)@/g)].map((match) => match[1])
        const uniqueKeys = [...new Set(keys)]
        if (uniqueKeys.length > 0) {
            contracts[entryKey] = createRuntimeContract(...uniqueKeys)
        }
    }
    return contracts
}

import type { CollectCapabilitiesInput } from "@core/prompts/capabilities/CapabilitiesAggregator"
import { collectCapabilities } from "@core/prompts/capabilities/CapabilitiesAggregator"
import { renderCapabilitiesSection } from "@core/prompts/capabilities/CapabilitiesSection"
import { hashPromptContent } from "@core/prompts/system-prompt-cache/hash"

/**
 * Detect whether the frozen system prompt cache has gone stale
 * relative to the current capability configuration.
 */
export class StaleDetector {
    /**
     * Compare current capabilities hash against the frozen cache hash.
     * @param frozenHash Hash from context.json frozen prompt.
     * @param input Capability collection input.
     * @returns True when stale (hashes differ).
     */
    async checkStaleness(frozenHash: string, input: CollectCapabilitiesInput): Promise<boolean> {
        try {
            const capabilities = await collectCapabilities(input)
            const section = renderCapabilitiesSection(capabilities)
            const currentHash = hashPromptContent(section)
            return currentHash !== frozenHash
        } catch {
            return false
        }
    }
}

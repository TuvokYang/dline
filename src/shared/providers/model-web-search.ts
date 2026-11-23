import type { ModelInfo } from "@shared/proto/dline/models"
import { ServerTool } from "@shared/proto/dline/models/metadata"

/** Only providers with an editable hosted Search control accept an undeclared-model choice. */
export function supportsSearchOverride(provider: string): boolean {
    return provider === "openai" || provider === "anthropic"
}

/** Keep only the user's Search declaration, and only while the catalog leaves tools undeclared. */
export function pickSearchOverride(base: ModelInfo, configured: ModelInfo | undefined): ModelInfo | undefined {
    if (
        base.capabilities?.tools !== undefined ||
        !configured ||
        configured.id !== base.id ||
        !configured.capabilities?.tools?.includes(ServerTool.WEB_SEARCH)
    ) {
        return undefined
    }
    return { id: base.id, capabilities: { tools: [ServerTool.WEB_SEARCH] } }
}

/** Supplement an undeclared catalog entry without replacing its other metadata or mutating it. */
export function resolveSearchModel(base: ModelInfo, configured: ModelInfo | undefined): ModelInfo {
    const choice = pickSearchOverride(base, configured)
    return choice ? { ...base, capabilities: { ...base.capabilities, ...choice.capabilities } } : base
}

/** Record an explicit choice against the selected identity, never a compatibility-generated snapshot. */
export function withSearchChoice(modelId: string, configured: ModelInfo | undefined): ModelInfo {
    const matching = configured?.id === modelId ? configured : undefined
    return {
        ...matching,
        id: modelId,
        capabilities: {
            ...matching?.capabilities,
            tools: [...new Set([...(matching?.capabilities?.tools ?? []), ServerTool.WEB_SEARCH])],
        },
    }
}

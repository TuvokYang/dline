import type { ModelCapabilities } from "@shared/proto/dline/models/metadata"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"

/** OpenCode defaults are client policy, not facts to write into the remote catalog. */
export function resolveOpenCodeReasoningConfig(
    capabilities: ModelCapabilities | undefined,
    stored: ReasoningConfig | undefined,
): ReasoningConfig | undefined {
    const thinking = capabilities?.thinking
    if (capabilities?.supportsReasoning === false || thinking?.supported !== true) return stored ? { ...stored } : undefined
    const levels = thinking.effortLevels ?? []
    const defaultEffort = thinking.mode === "effort" ? levels[Math.max(0, levels.length - 2)] : undefined
    return {
        ...stored,
        enableThinking: stored?.enableThinking ?? true,
        effort: stored?.effort ?? defaultEffort,
    }
}

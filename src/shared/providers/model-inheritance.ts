import type { ModelInfo } from "@shared/proto/dline/models"
import type { ModelCapabilities } from "@shared/proto/dline/models/metadata"
import { mergeCapabilities } from "./effective-model-info"

type ModelFamily = "gpt" | "claude"

interface ModelVersion {
    family: string
    major: number
    minor: number
    variant: string
}

/** Match versioned identities without stripping aliases, variants or date suffixes. */
function readVersion(id: string, family: ModelFamily): ModelVersion | undefined {
    if (family === "gpt") {
        const match = /^gpt-(\d+)(?:\.(\d+))?(-[a-z][a-z0-9-]*)?$/.exec(id)
        if (!match) return undefined
        return { family, major: Number(match[1]), minor: Number(match[2] ?? 0), variant: match[3] ?? "" }
    }
    const match = /^claude-([a-z][a-z0-9]*)-(\d+)(?:[-.](\d+))?((?:-[a-z][a-z0-9-]*)?(?::[a-z][a-z0-9-]*)?)$/.exec(id)
    // A major-date snapshot is not a very large minor version.
    if (!match || /^\d{8}$/.test(match[3] ?? "")) return undefined
    return { family: match[1], major: Number(match[2]), minor: Number(match[3] ?? 0), variant: match[4] }
}

function hasInheritedCaps(capabilities: ModelCapabilities | undefined): boolean {
    return (
        capabilities?.supportsPromptCache !== undefined ||
        capabilities?.supportsReasoning !== undefined ||
        capabilities?.thinking !== undefined
    )
}

function findAncestor(id: string, models: Readonly<Record<string, ModelInfo>>, family: ModelFamily): ModelInfo | undefined {
    const target = readVersion(id, family)
    if (!target) return undefined
    let nearest: ModelInfo | undefined
    let nearestMinor = -1
    for (const [candidateId, candidate] of Object.entries(models)) {
        const version = readVersion(candidateId, family)
        if (
            version &&
            version.family === target.family &&
            version.major === target.major &&
            version.variant === target.variant &&
            version.minor < target.minor &&
            version.minor > nearestMinor &&
            hasInheritedCaps(candidate.capabilities)
        ) {
            nearest = candidate
            nearestMinor = version.minor
        }
    }
    return nearest
}

/**
 * Fill only cache and thinking from the nearest older minor in this catalog.
 * Selected declarations win, including false, zero and empty lists. Provider
 * overrides apply afterward; identity, prices, limits and protocols never inherit.
 */
export function inheritModelInfo(
    modelId: string,
    base: ModelInfo | undefined,
    models: Readonly<Record<string, ModelInfo>>,
    family: ModelFamily,
): ModelInfo & { capabilities: ModelCapabilities } {
    const ancestor = findAncestor(modelId, models, family)?.capabilities
    const capabilities = ancestor
        ? mergeCapabilities(
              {
                  supportsPromptCache: ancestor.supportsPromptCache,
                  supportsReasoning: ancestor.supportsReasoning,
                  thinking: ancestor.thinking,
              },
              base?.capabilities ?? {},
          )
        : { ...base?.capabilities }
    if (capabilities.thinking) {
        capabilities.thinking = {
            ...capabilities.thinking,
            ...(capabilities.thinking.effortLevels !== undefined
                ? { effortLevels: [...capabilities.thinking.effortLevels] }
                : {}),
        }
    }
    return { ...base, id: modelId, capabilities }
}

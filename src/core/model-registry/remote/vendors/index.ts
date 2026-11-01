/**
 * Vendors this build knows how to enumerate.
 *
 * Adding a provider means adding one subclass file and one entry here; the
 * orchestration, storage, credential and merge layers stay untouched.
 */
import type { ProviderRemoteSource } from "../model-source"
import { aiHubMixModelSource } from "./aihubmix"
import { anthropicModelSource } from "./anthropic"
import { basetenModelSource } from "./baseten"
import { claudeCodeModelSource } from "./claude-code"
import { clineModelSource } from "./cline"
import { deepSeekModelSource } from "./deepseek"
import { groqModelSource } from "./groq"
import { hicapModelSource } from "./hicap"
import { huggingFaceModelSource } from "./huggingface"
import { liteLlmModelSource } from "./litellm"
import { lmStudioModelSource } from "./lmstudio"
import { ocaModelSource } from "./oca"
import { ollamaModelSource } from "./ollama"
import { openAiModelSource } from "./openai"
import { openAiCodexModelSource } from "./openai-codex"
import { openCodeModelSource } from "./opencode"
import { openRouterModelSource } from "./openrouter"
import { requestyModelSource } from "./requesty"
import { sapAiCoreModelSource } from "./sapaicore"
import { vercelAiGatewayModelSource } from "./vercel"

export const MODEL_SOURCES: readonly ProviderRemoteSource[] = [
    aiHubMixModelSource,
    anthropicModelSource,
    basetenModelSource,
    claudeCodeModelSource,
    clineModelSource,
    deepSeekModelSource,
    groqModelSource,
    hicapModelSource,
    huggingFaceModelSource,
    liteLlmModelSource,
    lmStudioModelSource,
    ocaModelSource,
    ollamaModelSource,
    openAiModelSource,
    openAiCodexModelSource,
    openCodeModelSource,
    openRouterModelSource,
    requestyModelSource,
    sapAiCoreModelSource,
    vercelAiGatewayModelSource,
]

const sourcesById = new Map<string, ProviderRemoteSource>(MODEL_SOURCES.map((source) => [source.providerId, source]))

/**
 * Catalog keys that read a provider's listing without being its provider id.
 *
 * A Profile option can select an alternative catalog (a billing plan, a region)
 * while the vendor still serves one listing. The key the settings form sends is
 * that catalog key, so it must resolve to the owning provider's source instead
 * of reporting that the provider cannot be listed.
 */
const CATALOG_KEY_OWNERS: Readonly<Record<string, string>> = {
    "opencode-go": "opencode",
}

export function getModelSource(providerId: string): ProviderRemoteSource | undefined {
    const direct = sourcesById.get(providerId)
    if (direct) {
        return direct
    }
    const ownerId = CATALOG_KEY_OWNERS[providerId]
    return ownerId ? sourcesById.get(ownerId) : undefined
}

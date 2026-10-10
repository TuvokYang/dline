// Re-export the proto-generated ApiProfile as the canonical profile type.
// Do NOT create a separate UI type — the proto type is the source of truth.
export type { ApiProfile } from "@shared/proto/dline/profile"

import { type ApiProfile, ImageGenerationSource } from "@shared/proto/dline/profile"
import { WebToolsMode } from "@shared/proto/dline/provider/common"

/**
 * Generate default profile name from provider and modelId.
 */
export function generateApiProfileName(provider: string, modelId: string, existingNames: string[]): string {
    const base = `${provider}:${modelId}`
    if (!existingNames.includes(base)) {
        return base
    }
    let counter = 2
    while (existingNames.includes(`${base}:${counter}`)) {
        counter++
    }
    return `${base}:${counter}`
}

/**
 * Create a new empty ApiProfile with defaults.
 */
export function createEmptyApiProfile(): ApiProfile {
    return {
        id: crypto.randomUUID(),
        name: "",
        provider: "",
        apiKey: "",
        baseUrl: undefined,
        modelId: "",
        imageModelId: undefined,
        imageGeneration: undefined,
        imageSource: ImageGenerationSource.IMAGE_GENERATION_SOURCE_UNSPECIFIED,
        imageProfileId: undefined,
        modelInfo: undefined,
        legacyNames: [],
        webToolsMode: WebToolsMode.WEB_TOOLS_MODE_AUTO,
        usedFor: ["act", "plan", "subagents"],
        enabled: true,
        anthropic: undefined,
        bedrock: undefined,
        vertex: undefined,
        sapaicore: undefined,
        claudeCode: undefined,
        openrouter: undefined,
        openai: undefined,
        ollama: undefined,
        lmstudio: undefined,
        qwen: undefined,
        qwenCode: undefined,
        litellm: undefined,
        moonshot: undefined,
        asksage: undefined,
        clineProvider: undefined,
        zai: undefined,
        oca: undefined,
        aihubmix: undefined,
        minimax: undefined,
        deepseek: undefined,
        doubao: undefined,
        mistral: undefined,
        vscodeLm: undefined,
        nebius: undefined,
        fireworks: undefined,
        xai: undefined,
        sambanova: undefined,
        cerebras: undefined,
        groq: undefined,
        huggingface: undefined,
        huaweiCloudMaas: undefined,
        baseten: undefined,
        vercelAiGateway: undefined,
        together: undefined,
        requesty: undefined,
        hicap: undefined,
        openaiCodex: undefined,
        openaiNative: undefined,
        gemini: undefined,
        nousResearch: undefined,
        wandb: undefined,
        dify: undefined,
    }
}

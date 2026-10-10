import {
    canStoreRegistryModelInfoOverrides,
    getModelInfoOverrideFields,
    pickModelInfoOverride,
} from "@shared/providers/model-info-overrides"
import { AIhubmixProvider } from "./AihubmixProvider"
import { AnthropicProvider } from "./AnthropicProvider"
import { AskSageProvider } from "./AskSageProvider"
import { BasetenProvider } from "./BasetenProvider"
import { BedrockProvider } from "./BedrockProvider"
import { CerebrasProvider } from "./CerebrasProvider"
import { ClaudeCodeProvider } from "./ClaudeCodeProvider"
import { ClineProvider } from "./ClineProvider"
import { DeepSeekProvider } from "./DeepSeekProvider"
import { DifyProvider } from "./DifyProvider"
import { DoubaoProvider } from "./DoubaoProvider"
import { FireworksProvider } from "./FireworksProvider"
import { GeminiProvider } from "./GeminiProvider"
import { GroqProvider } from "./GroqProvider"
import { HicapProvider } from "./HicapProvider"
import { HuaweiCloudMaasProvider } from "./HuaweiCloudMaasProvider"
import { HuggingFaceProvider } from "./HuggingFaceProvider"
import { LiteLlmProvider } from "./LiteLlmProvider"
import { LMStudioProvider } from "./LMStudioProvider"
import { MinimaxProvider } from "./MiniMaxProvider"
import { MistralProvider } from "./MistralProvider"
import { MoonshotProvider } from "./MoonshotProvider"
import { NebiusProvider } from "./NebiusProvider"
import { NousResearchProvider } from "./NousresearchProvider"
import { OcaProvider } from "./OcaProvider"
import { OllamaProvider } from "./OllamaProvider"
import { OpenAIProvider } from "./OpenAIProvider"
import { OpenAiCodexProvider } from "./OpenAiCodexProvider"
import { OpenRouterProvider } from "./OpenRouterProvider"
import type { ApiProfile } from "./ProviderProfile"
import { QwenCodeProvider } from "./QwenCodeProvider"
import { QwenProvider } from "./QwenProvider"
import { RequestyProvider } from "./RequestyProvider"
import { SambanovaProvider } from "./SambanovaProvider"
import { SapAiCoreProvider } from "./SapAiCoreProvider"
import { TogetherProvider } from "./TogetherProvider"
import { useProviderModels } from "./useProviderModels"
import { VercelAIGatewayProvider } from "./VercelAIGatewayProvider"
import { VertexProvider } from "./VertexProvider"
import { VSCodeLmProvider } from "./VSCodeLmProvider"
import { WandbProvider } from "./WandbProvider"
import { XaiProvider } from "./XaiProvider"
import { ZAiProvider } from "./ZAiProvider"

interface ApiProfileEditorProps {
    profile: ApiProfile
    isPopup?: boolean
    onUpdateProfile: (updates: Partial<ApiProfile>) => void
}

/**
 * Glue component that renders the appropriate existing Provider component
 * based on profile.provider, passing profile + onUpdate for profile-driven API.
 * Does NOT know about profile list structure.
 */
const ApiProfileEditor: React.FC<ApiProfileEditorProps> = ({ profile, isPopup, onUpdateProfile }) => {
    const showModelOptions = true
    const { models } = useProviderModels(profile.provider || "")

    const onUpdate = (updates: Partial<ApiProfile>) => {
        const normalized = { ...updates }
        if ("modelInfo" in normalized && normalized.modelInfo) {
            const modelId = normalized.modelId ?? profile.modelId
            const baseModelInfo = modelId ? models[modelId] : undefined
            if (baseModelInfo) {
                normalized.modelInfo = canStoreRegistryModelInfoOverrides(profile.provider)
                    ? (pickModelInfoOverride(
                          normalized.modelInfo,
                          baseModelInfo,
                          getModelInfoOverrideFields(profile.provider),
                      ) as ApiProfile["modelInfo"])
                    : undefined
            }
        }
        onUpdateProfile(normalized)
    }

    switch (profile.provider) {
        case "cline":
            return <ClineProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
        case "openai-codex":
            return (
                <OpenAiCodexProvider
                    isPopup={isPopup}
                    onUpdate={onUpdate}
                    profile={profile}
                    showModelOptions={showModelOptions}
                />
            )
        case "gemini":
            return <GeminiProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
        case "openai":
            return <OpenAIProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
        case "anthropic":
            return (
                <AnthropicProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
            )
        case "bedrock":
            return <BedrockProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
        case "vscode-lm":
            return <VSCodeLmProvider onUpdate={onUpdate} profile={profile} />
        case "deepseek":
            return (
                <DeepSeekProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
            )
        case "openrouter":
            return (
                <OpenRouterProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
            )
        case "ollama":
            return <OllamaProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
        case "vertex":
            return <VertexProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
        case "litellm":
            return <LiteLlmProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
        case "claude-code":
            return (
                <ClaudeCodeProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
            )
        case "sapaicore":
            return (
                <SapAiCoreProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
            )
        case "mistral":
            return <MistralProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
        case "zai":
            return <ZAiProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
        case "groq":
            return <GroqProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
        case "cerebras":
            return (
                <CerebrasProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
            )
        case "vercel-ai-gateway":
            return (
                <VercelAIGatewayProvider
                    isPopup={isPopup}
                    onUpdate={onUpdate}
                    profile={profile}
                    showModelOptions={showModelOptions}
                />
            )
        case "baseten":
            return <BasetenProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
        case "requesty":
            return (
                <RequestyProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
            )
        case "fireworks":
            return (
                <FireworksProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
            )
        case "together":
            return (
                <TogetherProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
            )
        case "qwen":
            return <QwenProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
        case "qwen-code":
            return (
                <QwenCodeProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
            )
        case "doubao":
            return <DoubaoProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
        case "lmstudio":
            return (
                <LMStudioProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
            )
        case "moonshot":
            return (
                <MoonshotProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
            )
        case "huggingface":
            return (
                <HuggingFaceProvider
                    isPopup={isPopup}
                    onUpdate={onUpdate}
                    profile={profile}
                    showModelOptions={showModelOptions}
                />
            )
        case "nebius":
            return <NebiusProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
        case "asksage":
            return <AskSageProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
        case "xai":
            return <XaiProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
        case "sambanova":
            return (
                <SambanovaProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
            )
        case "huawei-cloud-maas":
            return (
                <HuaweiCloudMaasProvider
                    isPopup={isPopup}
                    onUpdate={onUpdate}
                    profile={profile}
                    showModelOptions={showModelOptions}
                />
            )
        case "dify":
            return <DifyProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
        case "oca":
            return <OcaProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
        case "minimax":
            return <MinimaxProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
        case "hicap":
            return <HicapProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
        case "aihubmix":
            return (
                <AIhubmixProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
            )
        case "nousResearch":
            return (
                <NousResearchProvider
                    isPopup={isPopup}
                    onUpdate={onUpdate}
                    profile={profile}
                    showModelOptions={showModelOptions}
                />
            )
        case "wandb":
            return <WandbProvider isPopup={isPopup} onUpdate={onUpdate} profile={profile} showModelOptions={showModelOptions} />
        default:
            return <div className="text-xs text-description">Select a provider to configure.</div>
    }
}

export default ApiProfileEditor

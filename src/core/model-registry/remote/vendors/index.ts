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
	openRouterModelSource,
	requestyModelSource,
	sapAiCoreModelSource,
	vercelAiGatewayModelSource,
]

const sourcesById = new Map<string, ProviderRemoteSource>(MODEL_SOURCES.map((source) => [source.providerId, source]))

export function getModelSource(providerId: string): ProviderRemoteSource | undefined {
	return sourcesById.get(providerId)
}

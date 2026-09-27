import type { ApiProvider } from "@shared/api"
import { getProviderLabel as resolveProviderLabel } from "@shared/providers/providers"
import type { RemoteConfigFields } from "@shared/storage/state-keys"
import type { ApiProfile } from "@/components/settings/providers/ProviderProfile"

/**
 * Providers that are always available regardless of configuration.
 *
 * Subscription providers sign in from their own settings panel rather than
 * through a credential field, so a profile is selectable before sign-in.
 */
const ALWAYS_AVAILABLE: ApiProvider[] = ["cline", "openai-codex", "claude-code", "vscode-lm"]

/**
 * Check whether a profile has the minimum required credentials for its provider.
 * Checks apiKey first, then falls back to provider-specific config fields.
 *
 * @param profile - The ApiProfile to validate
 * @returns true if the profile has sufficient credentials configured
 */
function isProfileConfigured(profile: ApiProfile): boolean {
	switch (profile.provider) {
		// Providers requiring only apiKey
		case "anthropic":
		case "openrouter":
		case "gemini":
		case "deepseek":
		case "xai":
		case "qwen":
		case "doubao":
		case "mistral":
		case "requesty":
		case "fireworks":
		case "together":
		case "moonshot":
		case "nebius":
		case "asksage":
		case "sambanova":
		case "cerebras":
		case "zai":
		case "groq":
		case "huggingface":
		case "baseten":
		case "minimax":
		case "hicap":
		case "huawei-cloud-maas":
		case "vercel-ai-gateway":
		case "aihubmix":
		case "nousResearch":
		case "qwen-code":
		case "wandb":
			return !!profile.apiKey

		// Bedrock: requires awsRegion in oneof bedrock config
		case "bedrock":
			return !!profile.bedrock?.awsRegion

		// Vertex: requires projectId and region in oneof vertex config
		case "vertex":
			return !!(profile.vertex?.vertexProjectId && profile.vertex?.vertexRegion)

		// SAP AI Core: requires baseUrl + clientId + clientSecret + tokenUrl
		case "sapaicore":
			return !!(
				profile.baseUrl &&
				profile.sapaicore?.clientId &&
				profile.sapaicore?.clientSecret &&
				profile.sapaicore?.tokenUrl
			)

		// Dify: requires baseUrl and apiKey
		case "dify":
			return !!(profile.baseUrl && profile.apiKey)

		// OpenAI Compatible: requires (baseUrl + apiKey) or modelId
		case "openai":
			return !!(profile.baseUrl && profile.apiKey) || !!profile.modelId

		// Local providers: check baseUrl or modelId (no apiKey needed)
		case "ollama":
		case "lmstudio":
			return !!(profile.baseUrl || profile.modelId)

		// LiteLLM: check baseUrl, apiKey, or modelId
		case "litellm":
			return !!(profile.baseUrl || profile.apiKey || profile.modelId)

		// Claude Code: a subscription OAuth session, not a stored credential field
		case "claude-code":
			return true

		// OCA: requires baseUrl
		case "oca":
			return !!profile.baseUrl

		// Unknown provider — fall back to apiKey check
		default:
			return !!profile.apiKey
	}
}

/**
 * Returns a list of API providers that are configured (have required credentials).
 * Profile-driven: iterates over ApiProfile[] instead of flat ApiConfiguration fields.
 *
 * Always-available providers (cline, openai-codex, vscode-lm) are included unconditionally.
 * Other providers are included only when at least one enabled profile with sufficient
 * credentials exists for that provider.
 *
 * @param remoteConfig - Optional remote configuration with pre-set provider list
 * @param _apiConfiguration - Deprecated, kept for caller compatibility (ignored)
 * @param profiles - List of configured API profiles
 * @returns Deduplicated list of configured ApiProvider values
 */
export function getConfiguredProviders(
	remoteConfig: Partial<RemoteConfigFields> | undefined,
	_apiConfiguration: unknown,
	profiles: ApiProfile[] = [],
): ApiProvider[] {
	if (remoteConfig?.remoteConfiguredProviders?.length) {
		return remoteConfig.remoteConfiguredProviders as ApiProvider[]
	}

	const configured = new Set<ApiProvider>(ALWAYS_AVAILABLE)

	for (const profile of profiles) {
		if (!profile.enabled) {
			continue
		}
		if (isProfileConfigured(profile)) {
			configured.add(profile.provider as ApiProvider)
		}
	}

	return [...configured]
}

/**
 * Get provider display label from provider value.
 * Uses the canonical provider list as source of truth.
 */
export function getProviderLabel(provider: ApiProvider): string {
	return resolveProviderLabel(provider)
}

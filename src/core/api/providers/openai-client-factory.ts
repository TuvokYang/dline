import { DefaultAzureCredential, getBearerTokenProvider } from "@azure/identity"
import { azureOpenAiDefaultApiVersion } from "@shared/api"
import type { ApiProfile } from "@shared/proto/dline/profile"
import OpenAI, { AzureOpenAI } from "openai"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { createOpenAIClient, providerFetch } from "@/shared/net"

export interface OpenAIClientFactoryOptions {
	azureADTokenProvider?: () => Promise<string>
}

function getAzureAudienceScope(baseUrl?: string): string {
	const url = baseUrl?.toLowerCase() ?? ""
	return url.includes("azure.us")
		? "https://cognitiveservices.azure.us/.default"
		: "https://cognitiveservices.azure.com/.default"
}

/** Create an OpenAI SDK client using the complete Profile authentication and transport contract. */
export function createOpenAIClientForProfile(profile: ApiProfile, options: OpenAIClientFactoryOptions = {}): OpenAI {
	const config = profile.openai
	const baseUrl = (profile.baseUrl ?? "").toLowerCase()
	const isAzureDomain = baseUrl.includes("azure.com") || baseUrl.includes("azure.us")
	const useAzure = Boolean(config?.azureApiVersion) || (isAzureDomain && !profile.modelId?.toLowerCase().includes("deepseek"))
	if (!profile.apiKey && !config?.azureIdentity) {
		throw new Error("OpenAI API key or Azure Identity Authentication is required")
	}
	if (!useAzure) {
		return createOpenAIClient({
			baseURL: profile.baseUrl,
			apiKey: profile.apiKey,
			defaultHeaders: config?.openAiHeaders,
		})
	}

	const common = {
		baseURL: profile.baseUrl,
		apiVersion: config?.azureApiVersion || azureOpenAiDefaultApiVersion,
		maxRetries: 0,
		defaultHeaders: { ...buildExternalBasicHeaders(), ...config?.openAiHeaders },
		fetch: providerFetch,
	}
	if (config?.azureIdentity) {
		return new AzureOpenAI({
			...common,
			azureADTokenProvider:
				options.azureADTokenProvider ??
				getBearerTokenProvider(new DefaultAzureCredential(), getAzureAudienceScope(profile.baseUrl)),
		})
	}
	return new AzureOpenAI({ ...common, apiKey: profile.apiKey })
}

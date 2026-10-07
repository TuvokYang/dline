import { openAiCodexDefaultModelId, openAiCodexModelInfoSaneDefaults } from "@core/api/providers/models/openai-codex"
import { openAiCodexOAuthManager } from "@integrations/openai-codex/oauth"
import {
	OPENAI_CODEX_PRODUCTION_RUNTIME_CONFIG,
	resolveOpenAiCodexRuntimeConfig,
} from "@integrations/openai-codex/runtime-config"
import type { ModelCapabilities, ModelInfo } from "@shared/providers/types"
import { Logger } from "@shared/services/Logger"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { telemetryService } from "@/services/telemetry"
import type { ProviderModelReconciliationMode } from "../../provider-model-reconciliation"
import { isRecord, ModelListingSource, readString } from "../model-listing-source"
import type { ProviderRemoteContext } from "../model-source"
import {
	OPENAI_CODEX_MODEL_LIST_MINIMUM_VERSION,
	type OpenAiCodexClientVersionSource,
	openAiCodexClientVersionResolver,
} from "./openai-codex-client-version"

/** Decode the backend's explicit effort presets without consulting model identities. */
function readListedThinking(raw: unknown): ModelCapabilities["thinking"] {
	if (!isRecord(raw) || !Array.isArray(raw.supported_reasoning_levels)) return undefined
	const effortLevels = raw.supported_reasoning_levels.flatMap((option) => {
		const effort = readString(option, "effort")?.trim()
		return effort ? [effort] : []
	})
	if (raw.supported_reasoning_levels.length > 0 && effortLevels.length === 0) return undefined
	const supported = effortLevels.some((effort) => effort !== "none")
	const candidate = readString(raw, "default_reasoning_level")?.trim()
	const defaultEffort = candidate && effortLevels.includes(candidate) ? candidate : undefined
	return {
		supported,
		mode: "effort",
		effortLevels,
		...(supported ? { canDisable: effortLevels.includes("none") } : {}),
		...(defaultEffort !== undefined ? { defaultEffort, defaultEnabled: defaultEffort !== "none" } : {}),
	}
}

/** Stable fallback retained for callers that need the minimum supported listing version. */
export const OPENAI_CODEX_MODEL_LIST_CLIENT_VERSION = OPENAI_CODEX_MODEL_LIST_MINIMUM_VERSION

/** Lists the models visible to one ChatGPT Codex OAuth account. */
export class OpenAiCodexModelSource extends ModelListingSource {
	readonly providerId = "openai-codex"
	readonly providerName = "OpenAI Codex"
	override readonly billingMode = "subscription"
	override readonly reconciliation: ProviderModelReconciliationMode = "overlay-remote"
	override readonly requiresApiKey = false
	override readonly preferredDefaultModelId = openAiCodexDefaultModelId
	protected override readonly defaultBaseUrl = OPENAI_CODEX_PRODUCTION_RUNTIME_CONFIG.apiBaseUrl

	constructor(private readonly clientVersionSource: OpenAiCodexClientVersionSource = openAiCodexClientVersionResolver) {
		super()
	}

	override async fetchModels(context: ProviderRemoteContext): Promise<Record<string, ModelInfo>> {
		const profileId = context.profileId?.trim()
		if (!profileId) {
			Logger.debug("[OpenAiCodexModelSource] Listing skipped: Profile identity is missing")
			return {}
		}

		Logger.debug("[OpenAiCodexModelSource] Resolving Profile OAuth credential")
		let credential = await openAiCodexOAuthManager.getCredentialContext(profileId)
		if (!credential) {
			Logger.warn("[OpenAiCodexModelSource] Listing skipped: Profile OAuth credential is unavailable")
			return {}
		}
		Logger.debug(
			`[OpenAiCodexModelSource] Profile OAuth credential resolved accountIdPresent=${Boolean(credential.accountId)}`,
		)

		const baseUrl = resolveOpenAiCodexRuntimeConfig().apiBaseUrl
		const clientVersion = await this.clientVersionSource.resolve(context.signal)
		Logger.debug(`[OpenAiCodexModelSource] Client version resolved version=${clientVersion}`)
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const requestContext: ProviderRemoteContext = {
					...context,
					profileId,
					baseUrl,
					apiKey: credential.accessToken,
					vendorCredentials: {
						...(credential.accountId ? { accountId: credential.accountId } : {}),
						clientVersion,
					},
				}
				Logger.debug(
					`[OpenAiCodexModelSource] Listing request started url=${this.buildListingUrl(requestContext)} attempt=${attempt + 1}`,
				)
				telemetryService.captureButtonClick("settings_openai_codex_models_query_sent")
				const models = await super.fetchModels(requestContext)
				const modelCount = Object.keys(models).length
				Logger.debug(`[OpenAiCodexModelSource] Listing request completed models=${modelCount}`)
				telemetryService.captureButtonClick(
					modelCount > 0
						? "settings_openai_codex_models_query_result_nonempty"
						: "settings_openai_codex_models_query_result_empty",
				)
				return models
			} catch (error) {
				const unauthorized = error instanceof Error && /status 401\b/.test(error.message)
				if (!unauthorized || attempt > 0) {
					telemetryService.captureButtonClick("settings_openai_codex_models_query_result_failed")
					throw error
				}
				telemetryService.captureButtonClick("settings_openai_codex_models_query_result_unauthorized")
				Logger.debug("[OpenAiCodexModelSource] Listing received 401; refreshing the Profile OAuth credential")
				const refreshed = await openAiCodexOAuthManager.forceRefreshCredentialContext(profileId)
				if (!refreshed) throw error
				credential = refreshed
			}
		}
		return {}
	}

	protected override buildListingUrl(context: ProviderRemoteContext): string {
		const url = new URL(context.baseUrl || this.defaultBaseUrl)
		const pathName = url.pathname.replace(/\/+$/, "")
		url.pathname = /\/models$/i.test(pathName) ? pathName : `${pathName}/models`
		url.search = ""
		url.searchParams.set("client_version", context.vendorCredentials?.clientVersion ?? OPENAI_CODEX_MODEL_LIST_CLIENT_VERSION)
		url.hash = ""
		return url.toString()
	}

	protected override buildHeaders(context: ProviderRemoteContext): Record<string, string> {
		const headers: Record<string, string> = {
			...buildExternalBasicHeaders(),
			version: context.vendorCredentials?.clientVersion ?? OPENAI_CODEX_MODEL_LIST_CLIENT_VERSION,
		}
		if (context.apiKey) headers.Authorization = `Bearer ${context.apiKey}`
		const accountId = context.vendorCredentials?.accountId
		if (accountId) headers["ChatGPT-Account-Id"] = accountId
		return headers
	}

	protected override async fetchAllPages(context: ProviderRemoteContext): Promise<unknown[]> {
		const payload = await this.requestJson(this.buildListingUrl(context), context)
		const entries = this.readPageEntries(payload)
		const records = entries.filter(isRecord)
		const slugs = records.filter((entry) => this.readModelId(entry) !== undefined).length
		const supported = records.filter((entry) => entry.supported_in_api !== false).length
		const visible = records.filter((entry) => entry.visibility !== "hide").length
		const listedModels = records
			.map(
				(entry) =>
					`${this.readModelId(entry) ?? "<missing>"}:${typeof entry.visibility === "string" ? entry.visibility : "unspecified"}`,
			)
			.join(",")
		const topLevelKeys = isRecord(payload) ? Object.keys(payload).sort().join(",") : typeof payload
		Logger.debug(
			`[OpenAiCodexModelSource] Listing response shape topLevelKeys=${topLevelKeys || "none"} entries=${entries.length} records=${records.length} slugs=${slugs} supported=${supported} visible=${visible} listedModels=${listedModels || "none"}`,
		)
		return entries
	}

	protected override readPageEntries(payload: unknown): unknown[] {
		return isRecord(payload) && Array.isArray(payload.models) ? payload.models : []
	}

	protected override readModelId(raw: unknown): string | undefined {
		return readString(raw, "slug")
	}

	protected override isChatModel(raw: unknown): boolean {
		if (!isRecord(raw) || raw.supported_in_api === false || raw.visibility === "hide") return false
		return this.readModelId(raw) !== undefined
	}

	protected override readModelName(raw: unknown, modelId: string): string {
		return readString(raw, "display_name") ?? modelId
	}

	protected override readDescription(raw: unknown): string | undefined {
		return readString(raw, "description")
	}

	protected override readCapabilities(raw: unknown): ModelCapabilities {
		const listed = Object.fromEntries(
			Object.entries(super.readCapabilities(raw)).filter(([, value]) => value !== undefined),
		) as ModelCapabilities
		const thinking = readListedThinking(raw)
		const supportsReasoning = listed.supportsReasoning === false ? false : (thinking?.supported ?? listed.supportsReasoning)
		return {
			...openAiCodexModelInfoSaneDefaults.capabilities,
			...listed,
			...(supportsReasoning !== undefined ? { supportsReasoning } : {}),
			...(thinking ? { thinking: { ...thinking, supported: supportsReasoning } } : {}),
		}
	}

	protected override toModelInfo(raw: unknown, modelId: string): ModelInfo {
		const listed = super.toModelInfo(raw, modelId)
		return {
			...openAiCodexModelInfoSaneDefaults,
			...listed,
			id: modelId,
			apiFormats: openAiCodexModelInfoSaneDefaults.apiFormats,
			capabilities: {
				...openAiCodexModelInfoSaneDefaults.capabilities,
				...listed.capabilities,
			},
			pricing: openAiCodexModelInfoSaneDefaults.pricing,
		}
	}
}

export const openAiCodexModelSource = new OpenAiCodexModelSource()

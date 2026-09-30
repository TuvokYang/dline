import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ApiHandler } from "@core/api"
import { getProfileModelInfo } from "@core/api/model-info"
import type { ApiStream } from "@core/api/transform/stream"
import { PROVIDER_API_KEY_MAP, readApiProfiles, readApiProfilesFresh } from "@core/controller/file/getApiProfiles"
import { resolveProfileReference } from "@core/profiles/profile-binding"
import type { ApiConfiguration } from "@shared/api"
import type { ApiProfile } from "@shared/proto/dline/profile"
import type { Mode } from "@shared/storage/types"
import type { OpenAiCodexProfileAuthStatus } from "@/integrations/openai-codex/oauth"

export type ApiProfileInvalidReason =
	| "missing"
	| "ambiguous"
	| "disabled"
	| "credential_unavailable"
	| "credential_malformed"
	| "credential_legacy_shared"
	| "reauthentication_required"
	| "configuration_invalid"

export interface ApiProfileValidity {
	status: "valid" | "invalid"
	profileId?: string
	displayName?: string
	reason?: ApiProfileInvalidReason
	message?: string
}

export interface ApiProfileRecoveryResult {
	configuration: ApiConfiguration
	requestedProfile?: string
	resolvedProfile?: string
	resolvedProfileId?: string
	resolvedApiProfile?: ApiProfile
	usedFallback: boolean
	validity: ApiProfileValidity
	error?: string
}

function profileForMode(configuration: ApiConfiguration, mode: Mode): string | undefined {
	return mode === "plan" ? configuration.planModeProfile : configuration.actModeProfile
}

function profileIdForMode(configuration: ApiConfiguration, mode: Mode): string | undefined {
	return mode === "plan" ? configuration.planModeProfileId : configuration.actModeProfileId
}

function withProfile(configuration: ApiConfiguration, mode: Mode, profile: ApiProfile): ApiConfiguration {
	return mode === "plan"
		? { ...configuration, planModeProfileId: profile.id, planModeProfile: profile.name }
		: { ...configuration, actModeProfileId: profile.id, actModeProfile: profile.name }
}

function invalidProfile(profile: ApiProfile, reason: ApiProfileInvalidReason, message: string): ApiProfileValidity {
	return {
		status: "invalid",
		profileId: profile.id,
		displayName: profile.name,
		reason,
		message,
	}
}

function validProfile(profile: ApiProfile): ApiProfileValidity {
	return {
		status: "valid",
		profileId: profile.id,
		displayName: profile.name,
	}
}

const PROVIDERS_WITH_NON_FLAT_CREDENTIALS = new Set(["bedrock", "cline", "oca", "openai-codex", "qwen-code", "sapaicore"])

function requiresFlatApiKey(profile: ApiProfile): boolean {
	if (PROVIDERS_WITH_NON_FLAT_CREDENTIALS.has(profile.provider)) return false
	if (profile.provider === "openai" && profile.openai?.azureIdentity) {
		const baseUrl = profile.baseUrl?.toLowerCase() ?? ""
		return false
	}
	if (profile.provider === "ollama" || profile.provider === "lmstudio") return false
	return Boolean(PROVIDER_API_KEY_MAP[profile.provider])
}

function validateProfile(profile: ApiProfile): ApiProfileValidity {
	if (profile.enabled === false) {
		return invalidProfile(profile, "disabled", `Profile not valid: "${profile.name}" is disabled.`)
	}

	if (!profile.provider || !profile.modelId) {
		return invalidProfile(
			profile,
			"configuration_invalid",
			`Profile not valid: "${profile.name}" has incomplete provider configuration.`,
		)
	}

	if (profile.provider === "bedrock" && profile.bedrock?.awsAuthentication === "apikey") {
		if (!profile.bedrock.awsBedrockApiKey.trim()) {
			return invalidProfile(
				profile,
				"credential_unavailable",
				`Profile not valid: credentials for "${profile.name}" are unavailable.`,
			)
		}
	}

	if (profile.provider === "sapaicore") {
		const config = profile.sapaicore
		if (!config?.clientId?.trim() || !config.tokenUrl?.trim() || !profile.baseUrl?.trim()) {
			return invalidProfile(
				profile,
				"configuration_invalid",
				`Profile not valid: "${profile.name}" has incomplete SAP AI Core configuration.`,
			)
		}
		if (!config.clientSecret.trim()) {
			return invalidProfile(
				profile,
				"credential_unavailable",
				`Profile not valid: credentials for "${profile.name}" are unavailable.`,
			)
		}
	}

	if (profile.provider === "vertex") {
		if (!profile.vertex?.vertexProjectId.trim() || !profile.vertex.vertexRegion.trim()) {
			return invalidProfile(
				profile,
				"configuration_invalid",
				`Profile not valid: "${profile.name}" requires a Vertex project and region.`,
			)
		}
	}

	if (profile.provider === "openai" && profile.openai?.azureIdentity) {
		const baseUrl = profile.baseUrl?.toLowerCase() ?? ""
		const isAzureEndpoint = baseUrl.includes("azure.com") || baseUrl.includes("azure.us")
		if (!isAzureEndpoint) {
			return invalidProfile(
				profile,
				"configuration_invalid",
				`Profile not valid: "${profile.name}" requires an Azure endpoint for Azure Identity authentication.`,
			)
		}
	}

	if (requiresFlatApiKey(profile) && !profile.apiKey?.trim()) {
		return invalidProfile(
			profile,
			"credential_unavailable",
			`Profile not valid: credentials for "${profile.name}" are unavailable.`,
		)
	}

	return validProfile(profile)
}

export interface ApiProfileCredentialProbes {
	getOpenAiCodexAuthStatus?: (profile: ApiProfile) => Promise<OpenAiCodexProfileAuthStatus>
	getOcaAuthToken?: () => Promise<string | null>
	getClineAuthToken?: () => Promise<string | null>
	hasQwenCodeCredentials?: (profile: ApiProfile) => Promise<boolean>
}

async function defaultOpenAiCodexProbe(profile: ApiProfile): Promise<OpenAiCodexProfileAuthStatus> {
	try {
		const { openAiCodexOAuthManager } = await import("@integrations/openai-codex/oauth")
		return await openAiCodexOAuthManager.getAuthStatus(profile.id)
	} catch {
		return "missing"
	}
}

async function defaultOcaProbe(): Promise<string | null> {
	try {
		const { OcaAuthService } = await import("@services/auth/oca/OcaAuthService")
		return await OcaAuthService.getInstance().getAuthToken()
	} catch {
		return null
	}
}

async function defaultClineProbe(): Promise<string | null> {
	try {
		const { AuthService } = await import("@services/auth/AuthService")
		return await AuthService.getInstance().getAuthToken()
	} catch {
		return null
	}
}

async function defaultQwenCodeProbe(profile: ApiProfile): Promise<boolean> {
	const configuredPath = profile.qwenCode?.qwenCodeOauthPath
	const credentialPath = configuredPath
		? configuredPath.startsWith("~/")
			? path.join(os.homedir(), configuredPath.slice(2))
			: path.resolve(configuredPath)
		: path.join(os.homedir(), ".qwen", "oauth_creds.json")

	try {
		const credentials = JSON.parse(await fs.readFile(credentialPath, "utf8")) as {
			access_token?: unknown
			refresh_token?: unknown
		}
		return typeof credentials.access_token === "string" || typeof credentials.refresh_token === "string"
	} catch {
		return false
	}
}

/** Validate credentials at the Provider boundary without reducing all auth modes to profile.apiKey. */
export async function validateApiProfileCredentials(
	profile: ApiProfile,
	probes: ApiProfileCredentialProbes = {},
): Promise<ApiProfileValidity> {
	const structuralValidity = validateProfile(profile)
	if (structuralValidity.status === "invalid") return structuralValidity

	switch (profile.provider) {
		case "openai-codex": {
			const status = await (probes.getOpenAiCodexAuthStatus ?? defaultOpenAiCodexProbe)(profile)
			switch (status) {
				case "authenticated":
				case "refreshable-expired":
					return validProfile(profile)
				case "malformed":
					return invalidProfile(
						profile,
						"credential_malformed",
						`Profile not valid: the stored credential for "${profile.name}" is invalid. Sign in again.`,
					)
				case "legacy-shared":
					return invalidProfile(
						profile,
						"credential_legacy_shared",
						`Profile not valid: "${profile.name}" requires its own OpenAI Codex sign-in.`,
					)
				case "reauthentication-required":
					return invalidProfile(
						profile,
						"reauthentication_required",
						`Profile not valid: "${profile.name}" must sign in to OpenAI Codex again.`,
					)
				case "missing":
				default:
					return invalidProfile(
						profile,
						"credential_unavailable",
						`Profile not valid: credentials for "${profile.name}" are unavailable. Sign in to OpenAI Codex.`,
					)
			}
		}
		case "oca": {
			const token = await (probes.getOcaAuthToken ?? defaultOcaProbe)()
			return token?.trim()
				? validProfile(profile)
				: invalidProfile(
						profile,
						"credential_unavailable",
						`Profile not valid: credentials for "${profile.name}" are unavailable.`,
					)
		}
		case "qwen-code": {
			const authenticated = await (probes.hasQwenCodeCredentials ?? defaultQwenCodeProbe)(profile)
			return authenticated
				? validProfile(profile)
				: invalidProfile(
						profile,
						"credential_unavailable",
						`Profile not valid: credentials for "${profile.name}" are unavailable.`,
					)
		}
		case "cline": {
			if (profile.apiKey?.trim()) return validProfile(profile)
			const token = await (probes.getClineAuthToken ?? defaultClineProbe)()
			return token?.trim()
				? validProfile(profile)
				: invalidProfile(
						profile,
						"credential_unavailable",
						`Profile not valid: credentials for "${profile.name}" are unavailable.`,
					)
		}
		default:
			return structuralValidity
	}
}

/** Re-read the selected Profile by stable ID before admission or external Catalog reconciliation. */
export async function validateResolvedTaskApiProfile(resolution: ApiProfileRecoveryResult): Promise<ApiProfileValidity> {
	if (resolution.validity.status === "invalid" || !resolution.resolvedProfileId) return resolution.validity
	const profile = (await readApiProfilesFresh()).find((candidate) => candidate.id === resolution.resolvedProfileId)
	if (!profile) {
		return {
			status: "invalid",
			profileId: resolution.resolvedProfileId,
			displayName: resolution.resolvedProfile,
			reason: "missing",
			message: `Profile not valid: "${resolution.resolvedProfile}" no longer exists.`,
		}
	}
	return validateApiProfileCredentials(profile)
}

function invalidResult(
	configuration: ApiConfiguration,
	requestedProfile: string | undefined,
	requestedProfileId: string | undefined,
	validity: ApiProfileValidity,
): ApiProfileRecoveryResult {
	return {
		configuration,
		requestedProfile,
		resolvedProfile: undefined,
		resolvedProfileId: undefined,
		usedFallback: false,
		validity,
		error: validity.message,
	}
}

/** Resolves a session-only profile fallback without mutating the persisted task binding. */
export function resolveTaskApiProfile(
	configuration: ApiConfiguration,
	mode: Mode,
	historyProviderId?: string,
	profiles: readonly ApiProfile[] = readApiProfiles(),
): ApiProfileRecoveryResult {
	const requestedProfile = profileForMode(configuration, mode)
	const requestedProfileId = profileIdForMode(configuration, mode)

	if (requestedProfileId || requestedProfile) {
		const referenceResolution = resolveProfileReference(profiles, requestedProfileId ?? requestedProfile)
		if (referenceResolution.status === "invalid") {
			return invalidResult(configuration, requestedProfile, requestedProfileId, {
				status: "invalid",
				profileId: requestedProfileId,
				displayName: requestedProfile,
				reason: referenceResolution.reason,
				message: referenceResolution.error,
			})
		}
		const selectedProfile = referenceResolution.profile

		const validity = validateProfile(selectedProfile)
		if (validity.status === "invalid") {
			return invalidResult(configuration, requestedProfile, requestedProfileId, validity)
		}

		return {
			configuration: withProfile(configuration, mode, selectedProfile),
			requestedProfile,
			resolvedProfile: selectedProfile.name,
			resolvedProfileId: selectedProfile.id,
			resolvedApiProfile: selectedProfile,
			usedFallback: false,
			validity,
		}
	}

	// Preserve legacy initialization for a task that has never selected a profile.
	// An explicitly missing or invalid binding is handled above and never falls through here.
	const fallback =
		profiles.find((profile) => profile.provider === historyProviderId && validateProfile(profile).status === "valid") ??
		profiles.find((profile) => validateProfile(profile).status === "valid")
	if (!fallback) {
		return invalidResult(configuration, requestedProfile, requestedProfileId, {
			status: "invalid",
			reason: "missing",
			message: `Profile not valid: no enabled profile is available for ${mode} mode.`,
		})
	}

	const validity = validateProfile(fallback)
	return {
		configuration: withProfile(configuration, mode, fallback),
		requestedProfile,
		resolvedProfile: fallback.name,
		resolvedProfileId: fallback.id,
		resolvedApiProfile: fallback,
		usedFallback: true,
		validity,
	}
}

/** Resolve the selected Profile from the latest persisted Catalog and hydrated Secret Store. */
export async function resolveTaskApiProfileFresh(
	configuration: ApiConfiguration,
	mode: Mode,
	historyProviderId?: string,
): Promise<ApiProfileRecoveryResult> {
	return resolveTaskApiProfile(configuration, mode, historyProviderId, await readApiProfilesFresh())
}

/** Metadata-only projection; reading history never constructs a Provider transport. */
export function createInertApiHandler(profile: ApiProfile): ApiHandler {
	const info = getProfileModelInfo(profile)
	return {
		createMessage: async function* (): ApiStream {
			throw new Error("Task execution resources have not been admitted")
		},
		getModel: () => ({ id: profile.modelId || info.id || "unavailable", info }),
		getProviderId: () => profile.provider,
		supportsAccountUsagePolling: false,
	}
}

export function createUnavailableApiHandler(message: string): ApiHandler {
	return {
		createMessage: async function* (): ApiStream {
			throw new Error(message)
		},
		getModel: () => ({
			id: "unavailable",
			info: {
				id: "unavailable",
				name: "Unavailable API profile",
				description: message,
				capabilities: { maxTokens: 0, contextWindow: 0 },
				pricing: { inputPrice: 0, outputPrice: 0, cacheWritesPrice: 0, cacheReadsPrice: 0, currency: "USD" },
			},
		}),
		getProviderId: () => "unavailable",
	}
}

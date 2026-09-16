import { createHash } from "node:crypto"
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { allProviderModels } from "../../../core/api/providers/models"
import { getOpenAiCodexProfileAuthFileName } from "../../../core/storage/secrets/OpenAiCodexProfileAuthPath"
import { SETTINGS_MIGRATION_VERSION, SETTINGS_MIGRATION_VERSION_KEY } from "../../../core/storage/settings/settings-types"
import { getE2EMockProviderBaseUrl, getE2EOpenAIImageBaseUrl } from "../fixtures/server/api"

export const E2E_PROFILE_NAMES = {
	mockOpenAi: "E2E OpenAI Custom Chat Mock",
	mockOpenAiResponses: "E2E OpenAI Custom Responses Mock",
	mockOpenAiOfficialResponses: "E2E OpenAI Official Responses Mock",
	mockOpenAIImage: "E2E OpenAI Image Mock",
	mockDeepSeek: "E2E DeepSeek Thinking Mock",
	mockAnthropic: "E2E Anthropic Mock",
	persistence: "E2E Profile Persistence",
} as const

export interface LiveE2EProfile {
	credentialSource: "environment" | "local"
	environmentVariable?: string
	profileId: string
	profileName: string
	provider: string
	modelId: string
}

export interface EnvironmentE2EProfile extends LiveE2EProfile {
	credentialSource: "environment"
	environmentVariable: string
}

interface StoredApiProfile {
	id: string
	name: string
	provider: string
	modelId: string
	usedFor: string[]
	enabled: boolean
	baseUrl?: string
	[key: string]: unknown
}

interface PrepareE2EStateOptions {
	dlineDir: string
	mockBaseUrl: string
	sourceDataDir?: string
	env?: NodeJS.ProcessEnv
	profileMode?: E2EProfileMode
}

export type E2EProfileMode = "mock" | "live"

export interface PreparedE2EState {
	dlineDir: string
	selectedProfileName: string
	profileNames: string[]
	liveProfiles: LiveE2EProfile[]
	localProfileNames: string[]
}

interface ApiKeyEntry {
	apiKey: string
	name: string
}

interface ProviderSecretEntry {
	name: string
	provider: string
	secrets: Record<string, string>
}

interface LocalProfileSource {
	profiles: StoredApiProfile[]
	apiKeys: Record<string, ApiKeyEntry>
	providerSecrets: Record<string, ProviderSecretEntry>
	openAiCodexProfileIds: ReadonlySet<string>
}

const PROFILE_IDS = {
	mockOpenAi: "dline-e2e-mock-openai",
	mockOpenAiResponses: "dline-e2e-mock-openai-responses",
	mockOpenAiOfficialResponses: "dline-e2e-mock-openai-official-responses",
	mockOpenAIImage: "dline-e2e-mock-openai-image",
	mockDeepSeek: "dline-e2e-mock-deepseek",
	mockAnthropic: "dline-e2e-mock-anthropic",
	persistence: "dline-e2e-profile-persistence",
} as const

const PROVIDER_CONFIG_FIELDS: Record<string, string> = {
	anthropic: "anthropic",
	bedrock: "bedrock",
	vertex: "vertex",
	sapaicore: "sapaicore",
	"claude-code": "claudeCode",
	openrouter: "openrouter",
	openai: "openai",
	ollama: "ollama",
	lmstudio: "lmstudio",
	qwen: "qwen",
	"qwen-cn": "qwen",
	"qwen-code": "qwenCode",
	litellm: "litellm",
	moonshot: "moonshot",
	asksage: "asksage",
	cline: "clineProvider",
	"zai-intl": "zai",
	"zai-cn": "zai",
	oca: "oca",
	aihubmix: "aihubmix",
	minimax: "minimax",
	deepseek: "deepseek",
	doubao: "doubao",
	mistral: "mistral",
	"vscode-lm": "vscodeLm",
	nebius: "nebius",
	fireworks: "fireworks",
	xai: "xai",
	sambanova: "sambanova",
	cerebras: "cerebras",
	groq: "groq",
	huggingface: "huggingface",
	"huawei-cloud-maas": "huaweiCloudMaas",
	baseten: "baseten",
	"vercel-ai-gateway": "vercelAiGateway",
	together: "together",
	requesty: "requesty",
	hicap: "hicap",
	"openai-codex": "openaiCodex",
	gemini: "gemini",
	nousResearch: "nousResearch",
	wandb: "wandb",
	dify: "dify",
}

function highReasoning() {
	return { enableThinking: true, effort: "high", thinkingBudget: 0 }
}

type StoredApiFormat = "OPENAI_CHAT" | "OPENAI_RESPONSES" | "ANTHROPIC_CHAT"

function value(env: NodeJS.ProcessEnv, key: string): string | undefined {
	const candidate = env[key]?.trim()
	return candidate ? candidate : undefined
}

function environmentToken(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toUpperCase()
}

function resolveEnvironmentModelId(provider: string, modelToken: string): string {
	const models = allProviderModels[provider]?.models ?? {}
	const registered = Object.keys(models).find((modelId) => environmentToken(modelId) === modelToken)
	if (registered) return registered
	// The unified OpenAI provider retains the former Compatible provider's
	// free-form model IDs alongside its official catalog.
	if (provider === "openai") return modelToken.toLowerCase().replaceAll("_", "-")
	if (Object.keys(models).length > 0) {
		throw new Error(`No registered ${provider} model matches environment token ${modelToken}`)
	}
	return modelToken.toLowerCase().replaceAll("_", "-")
}

export function discoverEnvironmentE2EProfiles(env: NodeJS.ProcessEnv = process.env): EnvironmentE2EProfile[] {
	const providers = Object.keys(allProviderModels)
		.map((provider) => ({ provider, token: environmentToken(provider) }))
		.sort((left, right) => right.token.length - left.token.length)
	const discovered: EnvironmentE2EProfile[] = []

	for (const [environmentVariable, apiKey] of Object.entries(env)) {
		if (!environmentVariable.startsWith("API_KEY_") || !apiKey?.trim()) continue
		const remainder = environmentVariable.slice("API_KEY_".length).toUpperCase()
		const matchedProvider = providers.find(({ token }) => remainder.startsWith(`${token}_`))
		if (!matchedProvider) {
			throw new Error(`No registered provider matches environment variable ${environmentVariable}`)
		}
		const modelToken = remainder.slice(matchedProvider.token.length + 1)
		if (!modelToken) throw new Error(`Missing model ID in environment variable ${environmentVariable}`)
		const modelId = resolveEnvironmentModelId(matchedProvider.provider, modelToken)
		const profileId = `dline-e2e-live-${createHash("sha256").update(environmentVariable).digest("hex").slice(0, 12)}`
		discovered.push({
			credentialSource: "environment",
			environmentVariable,
			profileId,
			profileName: `${matchedProvider.provider}:${modelId}`,
			provider: matchedProvider.provider,
			modelId,
		})
	}

	return discovered.sort((left, right) => left.environmentVariable.localeCompare(right.environmentVariable))
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath)
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
		throw error
	}
}

async function copyFileIfPresent(sourcePath: string, destinationPath: string): Promise<void> {
	if (!(await pathExists(sourcePath))) return
	await mkdir(path.dirname(destinationPath), { recursive: true })
	await cp(sourcePath, destinationPath)
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
	if (!(await pathExists(filePath))) return fallback
	return JSON.parse(await readFile(filePath, "utf8")) as T
}

async function writeJson(filePath: string, data: unknown, mode?: number): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true })
	await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode })
}

function hasNonEmptyValues(values: Record<string, string> | undefined): boolean {
	return Boolean(values && Object.values(values).some((entry) => entry.trim().length > 0))
}

function localLiveProfiles(source: LocalProfileSource): LiveE2EProfile[] {
	return source.profiles
		.filter((profile) => {
			if (!profile.enabled || !profile.provider || !profile.modelId) return false
			if (source.apiKeys[profile.id]?.apiKey.trim()) return true
			if (hasNonEmptyValues(source.providerSecrets[profile.id]?.secrets)) return true
			return profile.provider === "openai-codex" && source.openAiCodexProfileIds.has(profile.id)
		})
		.map((profile) => ({
			credentialSource: "local" as const,
			profileId: profile.id,
			profileName: profile.name,
			provider: profile.provider,
			modelId: profile.modelId,
		}))
}

function mergeLiveProfiles(...sources: readonly LiveE2EProfile[][]): LiveE2EProfile[] {
	const profiles = new Map<string, LiveE2EProfile>()
	for (const source of sources) {
		for (const profile of source) profiles.set(profile.profileId, profile)
	}
	return [...profiles.values()]
}

async function loadLocalProfileSource(sourceDataDir: string, destinationDataDir: string): Promise<LocalProfileSource> {
	const sourceSettingsDir = path.join(sourceDataDir, "settings")
	const sourceSecretsDir = path.join(sourceDataDir, "secrets")
	const settingsDir = path.join(destinationDataDir, "settings")
	const secretsDir = path.join(destinationDataDir, "secrets")
	const profilesPath = path.join(settingsDir, "api_profiles.json")
	await copyFileIfPresent(path.join(sourceSettingsDir, "api_profiles.json"), profilesPath)
	const storedProfiles = await readJson<StoredApiProfile[]>(profilesPath, [])

	await Promise.all([
		copyFileIfPresent(path.join(sourceSecretsDir, "api_keys.json"), path.join(secretsDir, "api_keys.json")),
		copyFileIfPresent(path.join(sourceSecretsDir, "provider_secrets.json"), path.join(secretsDir, "provider_secrets.json")),
	])
	const openAiCodexProfileIds = new Set<string>()
	for (const profile of storedProfiles) {
		if (profile.provider !== "openai-codex") continue
		const fileName = getOpenAiCodexProfileAuthFileName(profile.id)
		const sourcePath = path.join(sourceSecretsDir, fileName)
		if (!(await pathExists(sourcePath))) continue
		await copyFileIfPresent(sourcePath, path.join(secretsDir, fileName))
		openAiCodexProfileIds.add(profile.id)
	}

	const [apiKeys, providerSecrets] = await Promise.all([
		readJson<Record<string, ApiKeyEntry>>(path.join(secretsDir, "api_keys.json"), {}),
		readJson<Record<string, ProviderSecretEntry>>(path.join(secretsDir, "provider_secrets.json"), {}),
	])
	const profiles: StoredApiProfile[] = []
	for (const profile of storedProfiles) upsertProfile(profiles, profile)

	return { profiles, apiKeys, providerSecrets, openAiCodexProfileIds }
}

async function loadEnvironmentProfileSource(env: NodeJS.ProcessEnv): Promise<EnvironmentE2EProfile[]> {
	return discoverEnvironmentE2EProfiles(env)
}

function upsertProfile(profiles: StoredApiProfile[], profile: StoredApiProfile): void {
	const index = profiles.findIndex((candidate) => candidate.id === profile.id)
	if (index === -1) profiles.push(profile)
	else profiles[index] = profile
}

function openAiProfile(
	id: string,
	name: string,
	baseUrl: string,
	modelId: string,
	apiFormat: Extract<StoredApiFormat, "OPENAI_CHAT" | "OPENAI_RESPONSES">,
	customModelEnabled = true,
): StoredApiProfile {
	return {
		id,
		name,
		provider: "openai",
		baseUrl,
		modelId,
		usedFor: ["act", "plan", "subagents"],
		enabled: true,
		openai: {
			apiFormat,
			customModelEnabled,
			reasoning: highReasoning(),
			streamIncludeUsage: true,
			...(customModelEnabled
				? {
						capabilities: {
							maxTokens: 8_192,
							contextWindow: 131_072,
							supportsImages: true,
							supportsPromptCache: true,
							supportsTools: true,
						},
						pricing: {
							inputPrice: 1,
							outputPrice: 2,
							cacheReadsPrice: 0.1,
							cacheWritesPrice: 1.25,
						},
					}
				: {}),
		},
	}
}

function openAIImageProfile(id: string, name: string, baseUrl: string): StoredApiProfile {
	return {
		id,
		name,
		provider: "openai",
		baseUrl,
		modelId: "dline-e2e-model",
		imageModelId: "gpt-image-2",
		usedFor: [],
		enabled: true,
		openai: { apiFormat: "OPENAI_CHAT" satisfies StoredApiFormat, customModelEnabled: true },
	}
}

function deepSeekProfile(id: string, name: string, baseUrl: string): StoredApiProfile {
	return {
		id,
		name,
		provider: "deepseek",
		baseUrl,
		modelId: "deepseek-v4-flash",
		usedFor: ["act", "plan", "subagents"],
		enabled: true,
		deepseek: {
			apiFormat: "OPENAI_CHAT" satisfies StoredApiFormat,
			reasoning: highReasoning(),
		},
	}
}

function anthropicProfile(id: string, name: string, baseUrl: string): StoredApiProfile {
	return {
		id,
		name,
		provider: "anthropic",
		baseUrl,
		modelId: "claude-sonnet-4-6",
		usedFor: ["act", "plan", "subagents"],
		enabled: true,
		anthropic: {
			reasoning: highReasoning(),
		},
	}
}

function liveProfile(configuration: LiveE2EProfile): StoredApiProfile {
	const providerConfig = allProviderModels[configuration.provider]
	const providerConfigField = PROVIDER_CONFIG_FIELDS[configuration.provider]
	const providerSettings = providerConfigField
		? {
				[providerConfigField]: {
					reasoning: highReasoning(),
					...(configuration.provider === "openai"
						? { customModelEnabled: providerConfig?.models[configuration.modelId] === undefined }
						: {}),
				},
			}
		: {}
	return {
		id: configuration.profileId,
		name: configuration.profileName,
		provider: configuration.provider,
		...(providerConfig?.baseUrl ? { baseUrl: providerConfig.baseUrl } : {}),
		modelId: configuration.modelId,
		usedFor: ["act", "plan", "subagents"],
		enabled: true,
		...providerSettings,
	}
}

function setApiKey(apiKeys: Record<string, { apiKey: string; name: string }>, profile: StoredApiProfile, apiKey: string): void {
	apiKeys[profile.id] = { apiKey, name: profile.name }
}

/**
 * Build an isolated DLINE_DIR template for one Playwright worker or preprocessing test.
 * Only authentication/profile files are copied from the user's default data directory.
 */
export async function prepareE2EState(options: PrepareE2EStateOptions): Promise<PreparedE2EState> {
	const env = options.env ?? process.env
	const sourceDataDir = options.sourceDataDir ?? path.join(os.homedir(), ".dline", "data")
	const profileMode = options.profileMode ?? "mock"
	const destinationDataDir = path.join(options.dlineDir, "data")
	const settingsDir = path.join(destinationDataDir, "settings")
	const secretsDir = path.join(destinationDataDir, "secrets")
	const profilesPath = path.join(settingsDir, "api_profiles.json")
	if (path.resolve(sourceDataDir) === path.resolve(destinationDataDir)) {
		throw new Error("E2E profile source and isolated destination must be different directories")
	}

	await Promise.all([rm(profilesPath, { force: true }), rm(secretsDir, { recursive: true, force: true })])
	await mkdir(destinationDataDir, { recursive: true })
	const [localSource, environmentProfiles] =
		profileMode === "live"
			? await Promise.all([loadLocalProfileSource(sourceDataDir, destinationDataDir), loadEnvironmentProfileSource(env)])
			: [
					{
						profiles: [],
						apiKeys: {},
						providerSecrets: {},
						openAiCodexProfileIds: new Set<string>(),
					} satisfies LocalProfileSource,
					[],
				]
	const localProfiles = localLiveProfiles(localSource)

	const profiles = localSource.profiles
	const localProfileNames = profiles.map((profile) => profile.name)
	const apiKeysPath = path.join(secretsDir, "api_keys.json")
	const apiKeys = localSource.apiKeys

	const mockProfile = openAiProfile(
		PROFILE_IDS.mockOpenAi,
		E2E_PROFILE_NAMES.mockOpenAi,
		getE2EMockProviderBaseUrl(options.mockBaseUrl, "openai-compatible-chat"),
		"dline-e2e-model",
		"OPENAI_CHAT",
	)
	mockProfile.imageSource = "IMAGE_GENERATION_SOURCE_INDEPENDENT"
	mockProfile.imageProfileId = PROFILE_IDS.mockOpenAIImage
	mockProfile.imageModelId = "gpt-image-2"
	upsertProfile(profiles, mockProfile)
	setApiKey(apiKeys, mockProfile, "dline-e2e-api-key")

	const mockResponsesProfile = openAiProfile(
		PROFILE_IDS.mockOpenAiResponses,
		E2E_PROFILE_NAMES.mockOpenAiResponses,
		getE2EMockProviderBaseUrl(options.mockBaseUrl, "openai-compatible-responses"),
		"dline-e2e-model",
		"OPENAI_RESPONSES",
	)
	upsertProfile(profiles, mockResponsesProfile)
	setApiKey(apiKeys, mockResponsesProfile, "dline-e2e-api-key")

	const mockOfficialResponsesProfile = openAiProfile(
		PROFILE_IDS.mockOpenAiOfficialResponses,
		E2E_PROFILE_NAMES.mockOpenAiOfficialResponses,
		getE2EMockProviderBaseUrl(options.mockBaseUrl, "openai-official-responses"),
		"gpt-5.4-mini",
		"OPENAI_RESPONSES",
		false,
	)
	upsertProfile(profiles, mockOfficialResponsesProfile)
	setApiKey(apiKeys, mockOfficialResponsesProfile, "dline-e2e-api-key")

	const mockImageProfile = openAIImageProfile(
		PROFILE_IDS.mockOpenAIImage,
		E2E_PROFILE_NAMES.mockOpenAIImage,
		getE2EOpenAIImageBaseUrl(options.mockBaseUrl),
	)
	upsertProfile(profiles, mockImageProfile)
	apiKeys[`image:${mockImageProfile.id}`] = { apiKey: "dline-e2e-api-key", name: mockImageProfile.name }

	const mockDeepSeekProfile = deepSeekProfile(
		PROFILE_IDS.mockDeepSeek,
		E2E_PROFILE_NAMES.mockDeepSeek,
		getE2EMockProviderBaseUrl(options.mockBaseUrl, "deepseek-chat"),
	)
	upsertProfile(profiles, mockDeepSeekProfile)
	setApiKey(apiKeys, mockDeepSeekProfile, "dline-e2e-api-key")

	const mockAnthropicProfile = anthropicProfile(
		PROFILE_IDS.mockAnthropic,
		E2E_PROFILE_NAMES.mockAnthropic,
		getE2EMockProviderBaseUrl(options.mockBaseUrl, "anthropic-messages"),
	)
	upsertProfile(profiles, mockAnthropicProfile)
	setApiKey(apiKeys, mockAnthropicProfile, "dline-e2e-api-key")

	const persistenceProfile = openAiProfile(
		PROFILE_IDS.persistence,
		E2E_PROFILE_NAMES.persistence,
		getE2EMockProviderBaseUrl(options.mockBaseUrl, "openai-compatible-chat"),
		"dline-e2e-model",
		"OPENAI_CHAT",
	)
	upsertProfile(profiles, persistenceProfile)
	setApiKey(apiKeys, persistenceProfile, "dline-e2e-api-key")

	for (const configuration of environmentProfiles) {
		const profile = liveProfile(configuration)
		upsertProfile(profiles, profile)
		setApiKey(apiKeys, profile, value(env, configuration.environmentVariable)!)
	}
	const liveProfiles = mergeLiveProfiles(localProfiles, environmentProfiles)

	const selectedProfileName = E2E_PROFILE_NAMES.mockOpenAi

	await writeJson(profilesPath, profiles)
	await writeJson(path.join(settingsDir, "image_generation_profiles.json"), [
		{
			id: mockImageProfile.id,
			name: mockImageProfile.name,
			provider: mockImageProfile.provider,
			baseUrl: mockImageProfile.baseUrl,
			enabled: true,
			legacyNames: [],
		},
	])
	await writeJson(apiKeysPath, apiKeys, 0o600)
	// Seed an already-migrated document: without the current version, startup
	// replays the legacy migration and revives stale global-state values.
	await writeJson(path.join(settingsDir, "settings.json"), {
		[SETTINGS_MIGRATION_VERSION_KEY]: SETTINGS_MIGRATION_VERSION,
		actModeProfile: selectedProfileName,
		planModeProfile: selectedProfileName,
		imageGenerationEnabled: false,
		enableParallelToolCalling: true,
	})
	await writeJson(path.join(destinationDataDir, "globalState.json"), {
		isNewUser: false,
		mode: "act",
		nativeToolCallEnabled: true,
		welcomeViewCompleted: true,
	})

	return {
		dlineDir: options.dlineDir,
		selectedProfileName,
		profileNames: profiles.map((profile) => profile.name),
		liveProfiles,
		localProfileNames,
	}
}

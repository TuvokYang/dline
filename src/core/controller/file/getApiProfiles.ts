/**
 * Handler for getApiProfiles RPC.
 *
 * Reads ApiProfile configurations from ~/.dline/data/settings/api_profiles.json.
 */

import { allProviderModels } from "@core/api/providers/models"
import { anthropicModels } from "@core/api/providers/models/anthropic"
import { ModelRegistry } from "@core/model-registry/ModelRegistry"
import { recordProfileCatalogBaseline } from "@core/profiles/profile-catalog-state"
import { FileLock } from "@core/storage/backend/jsonl/FileLock"
import { getDlineDataDir, getDlineHomePath } from "@core/storage/disk"
import {
	getAllProviderSecrets,
	getApiKey,
	getProviderSecret,
	type ProviderSecretEntry,
	reloadApiKeyStore,
	reloadProviderSecretStore,
	setApiKey,
	setProviderSecretsBatch,
} from "@core/storage/secrets"
import { GPT_IMAGE_2_5_MODEL_ID, GPT_IMAGE_2_SUBSCRIPTION_MODEL_ID } from "@shared/image-generation"
import { EmptyRequest } from "@shared/proto/dline/common"
import type { ModelCapabilities, ServerTool } from "@shared/proto/dline/models/metadata"
import { ApiProfile, ApiProfilesResponse, ImageGenerationSource } from "@shared/proto/dline/profile"
import { AnthropicProviderConfig } from "@shared/proto/dline/provider/anthropic"
import { BedrockProviderConfig } from "@shared/proto/dline/provider/bedrock"
import { OpenAiProviderConfig } from "@shared/proto/dline/provider/openai"
import { SapAiCoreProviderConfig } from "@shared/proto/dline/provider/sapaicore"
import { openAiEndpointToApiFormat } from "@shared/providers/api-format"
import { normalizeApiProfileUses } from "@shared/providers/api-profile-use"
import { updateSelectedContextWindow } from "@shared/providers/effective-model-info"
import {
	canStoreRegistryModelInfoOverrides,
	getModelInfoOverrideFields,
	mergeModelInfo,
	modelInfoToStorageJson,
	pickModelInfoOverride,
} from "@shared/providers/model-info-overrides"
import { PROFILE_PROVIDER_KEYS } from "@shared/providers/profile-model-info"
import { declaredServerTools } from "@shared/providers/server-tool-switches"
import { Logger } from "@shared/services/Logger"
import { ProviderToApiKeyMap } from "@shared/storage/provider-keys"
import fsSync from "fs"
import fs from "fs/promises"
import path from "path"
import { recordPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"
import type { Controller } from ".."

const API_PROFILES_FILE = "api_profiles.json"

/**
 * Storage revision understood by this build.
 *
 * Bump this whenever stored profiles need a one-time repair, and handle the
 * older revisions in `upgradeProfileSchema`.
 *
 * 1: clear hosted-tool disables that a legacy empty `capabilities.tools` was
 *    misread into.
 * 2: migrate image source naming and the legacy subscription model alias.
 */
const CURRENT_PROFILE_SCHEMA_VERSION = 2

/**
 * Bring one stored profile up to the current storage revision.
 *
 * Revision 1 drops every hosted-tool disable. An earlier migration read a legacy
 * empty `capabilities.tools` as "the user turned every hosted tool off" and wrote
 * that reading into the profile, where it is indistinguishable from a real
 * choice. Resetting the switches is the only way to release the profiles it
 * pinned to the local route; the revision then keeps the reset from erasing the
 * choices people make afterwards.
 */
function upgradeProfileSchema(profile: ApiProfile): boolean {
	const revision = profile.schemaVersion ?? 0
	if (revision >= CURRENT_PROFILE_SCHEMA_VERSION) return false

	if (revision < 1) {
		const providerKey = PROFILE_PROVIDER_KEYS[profile.provider]
		const config = providerKey ? (profile[providerKey] as { disabledServerTools?: ServerTool[] } | undefined) : undefined
		if (config?.disabledServerTools?.length) config.disabledServerTools = []
	}
	profile.schemaVersion = CURRENT_PROFILE_SCHEMA_VERSION
	return true
}

let apiProfilesWriteQueue: Promise<void> = Promise.resolve()
const cleanRewriteFileLock = new FileLock()
/**
 * Registry-derived modelInfo drift is repaired on disk at most once per process.
 *
 * `getApiProfiles` is a read RPC served by every Controller (sidebar and each
 * editor panel). Writing on every read created a self-sustaining storm: the write
 * woke the Catalog watcher, the watcher advanced the Catalog revision, every
 * Webview reloaded, and each reload wrote again. With several panels open the
 * amplification kept `api_profiles.json` from ever reaching the watcher's write
 * stability window, so newly opened panels stayed on "Loading profiles…"
 * regardless of how small the file was.
 */
let registryModelInfoRepairedPaths = new Set<string>()

/** Reset the process-local registry repair gate. Test-only seam. */
export function resetRegistryModelInfoRepairGateForTest(): void {
	registryModelInfoRepairedPaths = new Set<string>()
}
let apiProfilesReadCache:
	| {
			filePath: string
			mtimeMs: number
			size: number
			registryVersion: number
			profiles: ApiProfile[]
	  }
	| undefined

const ATOMIC_WRITE_RENAME_RETRY_DELAYS_MS = [20, 50, 100, 200, 500]

function isRetryableRenameError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException)?.code
	return code === "EPERM" || code === "EBUSY" || code === "EACCES"
}

async function renameWithRetry(tmpPath: string, filePath: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await fs.rename(tmpPath, filePath)
			return
		} catch (error) {
			if (!isRetryableRenameError(error) || attempt >= ATOMIC_WRITE_RENAME_RETRY_DELAYS_MS.length) {
				throw error
			}
			await new Promise((resolve) => setTimeout(resolve, ATOMIC_WRITE_RENAME_RETRY_DELAYS_MS[attempt]))
		}
	}
}

async function atomicWriteApiProfilesFile(filePath: string, data: string): Promise<void> {
	const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.json`
	try {
		await fs.writeFile(tmpPath, data, "utf8")
		await renameWithRetry(tmpPath, filePath)
	} catch (error) {
		fs.unlink(tmpPath).catch(() => {})
		throw error
	}
}

async function persistApiProfilesFile(filePath: string, profiles: ApiProfile[]): Promise<void> {
	await persistProviderSecrets(profiles)
	const data = JSON.stringify(serializeApiProfilesForStorage(profiles), null, "\t")
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	await atomicWriteApiProfilesFile(filePath, data)
	apiProfilesReadCache = undefined
}

function enqueueApiProfilesWrite<T>(write: () => Promise<T>): Promise<T> {
	const nextWrite = apiProfilesWriteQueue.then(write, write)
	apiProfilesWriteQueue = nextWrite.then(
		() => undefined,
		() => undefined,
	)
	return nextWrite
}

export function writeApiProfilesToFile(filePath: string, profiles: ApiProfile[]): Promise<void> {
	return enqueueApiProfilesWrite(() => persistApiProfilesFile(filePath, profiles))
}

function findFirstJsonValueEnd(raw: string): number | undefined {
	let started = false
	let depth = 0
	let inString = false
	let escaped = false

	for (let i = 0; i < raw.length; i++) {
		const char = raw[i]
		if (!started) {
			if (/\s/.test(char)) continue
			if (char !== "[" && char !== "{") return undefined
			started = true
			depth = 1
			continue
		}

		if (inString) {
			if (escaped) {
				escaped = false
			} else if (char === "\\") {
				escaped = true
			} else if (char === '"') {
				inString = false
			}
			continue
		}

		if (char === '"') {
			inString = true
		} else if (char === "[" || char === "{") {
			depth++
		} else if (char === "]" || char === "}") {
			depth--
			if (depth === 0) return i + 1
		}
	}

	return undefined
}

interface ParsedApiProfiles {
	profiles: ApiProfile[]
	recovered: boolean
	migrated: boolean
}

function parseApiProfilesJson(raw: string): ParsedApiProfiles {
	try {
		return { ...readProfilesFromJson(JSON.parse(raw)), recovered: false }
	} catch (error) {
		const end = findFirstJsonValueEnd(raw)
		if (end === undefined || raw.slice(end).trim().length === 0) {
			throw error
		}
		const parsed = readProfilesFromJson(JSON.parse(raw.slice(0, end)))
		Logger.warn("[getApiProfiles] Recovered api_profiles.json by trimming trailing invalid JSON")
		return { ...parsed, recovered: true }
	}
}

function readProfilesFromJson(data: unknown): Omit<ParsedApiProfiles, "recovered"> {
	const rawProfiles: unknown[] = Array.isArray(data)
		? data
		: data && typeof data === "object" && Array.isArray((data as any).profiles)
			? (data as any).profiles
			: []
	let migrated = false
	const profiles = rawProfiles.map((profile) => {
		const result = normalizeApiProfileWithMigration(profile)
		migrated ||= result.migrated
		return result.profile
	})
	return { profiles, migrated }
}

function clearImageBindings(profile: ApiProfile): boolean {
	if (profile.imageSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_INDEPENDENT) return false
	let changed = false
	if (profile.imageProfileId !== undefined) {
		profile.imageProfileId = undefined
		changed = true
	}
	if (
		(profile.imageSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_HOSTED ||
			profile.imageSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_UNSPECIFIED) &&
		profile.imageModelId !== undefined
	) {
		profile.imageModelId = undefined
		changed = true
	}
	return changed
}

/**
 * Move a legacy `capabilities.tools` override onto the profile's disable list.
 *
 * Older builds stored the user's hosted-tool switch inside the model's capability
 * declaration, so a switched-off tool became "this model has no such capability"
 * and the hosted route disappeared for good. The declaration belongs to the
 * registry, so a non-empty stored list is reinterpreted as "these were left on"
 * and the complement against the registry declaration becomes the disable list.
 *
 * An empty list carries no such statement. Those builds also wrote `[]` as their
 * plain default, so it cannot be told apart from a deliberate "turn everything
 * off" and reading it as one silently pins a hosted-capable model to the local
 * route with nothing in the UI to reveal or undo it. Empty therefore means "no
 * information": the declaration is dropped, the profile follows the model, and
 * any disable list this same misreading already produced is cleared.
 */
function migrateLegacyServerToolOverride(profile: ApiProfile): boolean {
	const providerKey = PROFILE_PROVIDER_KEYS[profile.provider]
	if (!providerKey) return false

	const config = profile[providerKey] as { capabilities?: ModelCapabilities; disabledServerTools?: ServerTool[] } | undefined
	const storedTools = config?.capabilities?.tools
	if (!config?.capabilities || storedTools === undefined) return false

	const { tools: _legacyDeclaration, ...capabilities } = config.capabilities
	if (storedTools.length === 0) {
		Object.assign(config, { capabilities, disabledServerTools: [] })
		return true
	}

	// The registry may not be loaded yet on some startup paths, so fall back to the
	// static catalog. Without a declaration to compare against, nothing can be
	// proven disabled and the profile keeps whatever the model offers.
	const declaration = resolveRegistryModelInfo(profile)?.capabilities ?? resolveSeedModelCapabilities(profile)
	const declared = declaredServerTools(declaration)
	const enabled = new Set(storedTools)
	const disabledServerTools = declared.filter((tool) => !enabled.has(tool))

	Object.assign(config, {
		capabilities,
		// An already-migrated profile keeps whatever the user chose more recently.
		disabledServerTools: config.disabledServerTools?.length ? config.disabledServerTools : disabledServerTools,
	})
	return true
}

function normalizeApiProfileWithMigration(profile: unknown): { profile: ApiProfile; migrated: boolean } {
	let profileInput = profile
	let migrated = false
	if (profile && typeof profile === "object") {
		const rawProfile = profile as Record<string, unknown>
		const rawImageSource = rawProfile.imageSource ?? rawProfile.image_source
		if (rawImageSource === "IMAGE_GENERATION_SOURCE_CURRENT") {
			profileInput = { ...rawProfile, imageSource: "IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION" }
			migrated = true
		}
	}
	const normalized = ApiProfile.fromJSON(profileInput ?? {})
	let hasExplicitImageSource = false
	if (profileInput && typeof profileInput === "object") {
		const rawProfile = profileInput as Record<string, unknown>
		hasExplicitImageSource = Object.hasOwn(rawProfile, "imageSource") || Object.hasOwn(rawProfile, "image_source")
		if (!Object.hasOwn(rawProfile, "enabled")) {
			normalized.enabled = true
			migrated = true
		}
		const rawModelInfo = rawProfile.modelInfo ?? rawProfile.model_info
		if (rawModelInfo && typeof rawModelInfo === "object") {
			normalized.modelInfo = rawModelInfo as ApiProfile["modelInfo"]
		}
	}

	if (normalized.provider === "anthropic" && normalized.modelId) {
		const originalModelId = normalized.modelId
		const hadLegacyLongContextSuffix = originalModelId.endsWith(":1m:fast") || originalModelId.endsWith(":1m")
		const migratedModelId =
			originalModelId === "claude-opus-4-6:fast" || originalModelId === "claude-opus-4-6:1m:fast"
				? "claude-opus-4-6"
				: originalModelId.endsWith(":1m:fast")
					? `${originalModelId.slice(0, -":1m:fast".length)}:fast`
					: originalModelId.endsWith(":1m")
						? originalModelId.slice(0, -":1m".length)
						: undefined

		if (migratedModelId && anthropicModels[migratedModelId]) {
			normalized.modelId = migratedModelId
			const targetSupportsLongContextTiers = Boolean(
				anthropicModels[migratedModelId]?.capabilities?.contextWindowTiers?.length,
			)
			normalized.anthropic = AnthropicProviderConfig.create({
				...normalized.anthropic,
				...(hadLegacyLongContextSuffix && targetSupportsLongContextTiers ? { enableLongContext: true } : {}),
			})
			migrated = true
		}

		const registryCapabilities = anthropicModels[normalized.modelId]?.capabilities
		const anthropic = normalized.anthropic ?? AnthropicProviderConfig.create()
		const providerCapabilities = anthropic.capabilities
		const contextWindowTiers = providerCapabilities?.contextWindowTiers?.length
			? providerCapabilities.contextWindowTiers
			: registryCapabilities?.contextWindowTiers
		const legacyContextWindow = providerCapabilities?.contextWindow
		if (
			registryCapabilities &&
			anthropic.customModelEnabled !== true &&
			!registryCapabilities.contextWindowTiers?.length &&
			providerCapabilities?.contextWindowTiers?.length
		) {
			const { contextWindowTiers: _staleTiers, ...remainingCapabilities } = providerCapabilities
			normalized.anthropic = AnthropicProviderConfig.create({
				...anthropic,
				capabilities: remainingCapabilities,
			})
			migrated = true
		} else if (contextWindowTiers?.length && legacyContextWindow !== undefined) {
			normalized.anthropic = AnthropicProviderConfig.create({
				...anthropic,
				capabilities: updateSelectedContextWindow(
					registryCapabilities,
					anthropic.capabilities,
					anthropic.enableLongContext !== false,
					legacyContextWindow,
				),
			})
			migrated = true
		}
	}

	const normalizedUses = normalizeApiProfileUses(normalized.usedFor)
	if (JSON.stringify(normalizedUses) !== JSON.stringify(normalized.usedFor)) {
		normalized.usedFor = normalizedUses
		migrated = true
	}
	if (!hasExplicitImageSource) {
		normalized.imageSource = normalized.imageModelId
			? ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION
			: ImageGenerationSource.IMAGE_GENERATION_SOURCE_UNSPECIFIED
		migrated = true
	}
	if (normalized.imageModelId === GPT_IMAGE_2_SUBSCRIPTION_MODEL_ID) {
		normalized.imageModelId = GPT_IMAGE_2_5_MODEL_ID
		migrated = true
	}
	if (clearImageBindings(normalized)) migrated = true
	if (migrateLegacyServerToolOverride(normalized)) migrated = true
	if (upgradeProfileSchema(normalized)) migrated = true
	const openai = normalized.openai
	if (openai && openai.apiFormat === undefined) {
		const legacyApiFormat = openAiEndpointToApiFormat(openai.apiEndpoint)
		if (legacyApiFormat !== undefined) {
			normalized.openai = OpenAiProviderConfig.create({
				...openai,
				apiEndpoint: undefined,
				apiFormat: legacyApiFormat,
			})
			migrated = true
		}
	}

	return { profile: normalized, migrated }
}

/** Normalize one request or in-memory Profile without scheduling a disk rewrite. */
export function normalizeApiProfile(profile: unknown): ApiProfile {
	return normalizeApiProfileWithMigration(profile).profile
}

/** Read a model's built-in capability declaration without depending on registry startup. */
function resolveSeedModelCapabilities(profile: ApiProfile): ModelCapabilities | undefined {
	if (!profile.provider || !profile.modelId) return undefined
	return allProviderModels[profile.provider]?.models?.[profile.modelId]?.capabilities
}

function resolveRegistryModelInfo(profile: ApiProfile) {
	if (!profile.provider || !profile.modelId) {
		return undefined
	}
	const providerModels = ModelRegistry.getInstance().getProviderModels(profile.provider)
	return providerModels?.models?.[profile.modelId]
}

function getProfileModelInfoOverride(profile: ApiProfile) {
	const baseModelInfo = resolveRegistryModelInfo(profile)
	if (!baseModelInfo) {
		return profile.modelInfo
	}
	if (!canStoreRegistryModelInfoOverrides(profile.provider)) {
		return undefined
	}
	return pickModelInfoOverride(profile.modelInfo, baseModelInfo, getModelInfoOverrideFields(profile.provider))
}

function applyRegistryModelInfo(profiles: ApiProfile[]): boolean {
	let changed = false
	for (const profile of profiles) {
		const baseModelInfo = resolveRegistryModelInfo(profile)
		if (!baseModelInfo) {
			// Custom models have no registry entry, so their top-level
			// modelInfo remains the authoritative editable metadata.
			continue
		}
		if (!canStoreRegistryModelInfoOverrides(profile.provider)) {
			// Registry-backed non-override providers expose derived metadata to
			// runtime consumers without persisting a stale Profile snapshot.
			if (profile.modelInfo) changed = true
			profile.modelInfo = ApiProfile.fromJSON({ modelInfo: baseModelInfo }).modelInfo
			continue
		}
		// Override-enabled providers (e.g. openai): merge registry modelInfo
		// with any stored user overrides so the profile always carries an
		// up-to-date snapshot.
		const modelInfoOverride = getProfileModelInfoOverride(profile)
		const mergedModelInfo = mergeModelInfo(baseModelInfo, modelInfoOverride)
		const storedModelInfo = modelInfoToStorageJson(profile.modelInfo)
		const normalizedOverride = modelInfoToStorageJson(modelInfoOverride)
		if (JSON.stringify(storedModelInfo) !== JSON.stringify(normalizedOverride)) {
			changed = true
		}
		profile.modelInfo = ApiProfile.fromJSON({ modelInfo: mergedModelInfo }).modelInfo
	}
	return changed
}

/** Fill omitted chat and image model IDs from independent provider registry defaults. */
export function applyRegistryModelDefaults(profiles: ApiProfile[]): boolean {
	const registry = ModelRegistry.getInstance()
	let changed = false
	const usedNames = new Set(profiles.map((profile) => profile.name).filter(Boolean))
	for (const profile of profiles) {
		if (clearImageBindings(profile)) changed = true
		if (!profile.provider) continue
		const providerModels = registry.getProviderModels(profile.provider)

		if (!profile.modelId && providerModels?.defaultModelId) {
			profile.modelId = providerModels.defaultModelId
			changed = true
			if (!profile.name || profile.name === "New Model") {
				const baseName = `${profile.provider}:${providerModels.defaultModelId}`
				let name = baseName
				let suffix = 2
				while (usedNames.has(name)) name = `${baseName} (${suffix++})`
				profile.name = name
				usedNames.add(name)
			}
		}

		if (
			(profile.imageSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION ||
				profile.imageSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_API) &&
			!profile.imageModelId &&
			providerModels?.defaultImageModelId
		) {
			profile.imageModelId = providerModels.defaultImageModelId
			changed = true
		}
	}
	return changed
}

async function hydrateModelInfoFromRegistry(profiles: ApiProfile[]): Promise<boolean> {
	const registry = ModelRegistry.getInstance()
	if (!registry.isInitialized) {
		await registry.reload()
	}
	const defaultsChanged = applyRegistryModelDefaults(profiles)
	return applyRegistryModelInfo(profiles) || defaultsChanged
}

export function serializeApiProfilesForStorage(profiles: ApiProfile[]): unknown[] {
	return profiles.map((profile) => {
		const modelInfo = getProfileModelInfoOverride(profile)
		const sanitized = stripEmbeddedProviderSecrets(profile)
		const serialized = ApiProfile.toJSON({ ...sanitized, apiKey: "", modelInfo: undefined }) as Record<string, unknown>
		serialized.enabled = sanitized.enabled
		delete serialized.apiKey
		delete serialized.api_key
		delete serialized.model_info
		const modelInfoJson = modelInfoToStorageJson(modelInfo)
		if (modelInfoJson) {
			serialized.modelInfo = modelInfoJson
		} else {
			delete serialized.modelInfo
		}
		return serialized
	})
}

function collectProviderSecrets(profile: ApiProfile): ProviderSecretEntry | undefined {
	const secrets: Record<string, string> = {}
	if (profile.bedrock) {
		for (const field of ["awsAccessKey", "awsSecretKey", "awsSessionToken", "awsBedrockApiKey"] as const) {
			const value = profile.bedrock[field]
			if (value) secrets[field] = value
		}
	}
	if (profile.sapaicore?.clientSecret) secrets.clientSecret = profile.sapaicore.clientSecret
	if (Object.keys(secrets).length === 0) return undefined
	return { name: profile.name, provider: profile.provider, secrets }
}

function stripEmbeddedProviderSecrets(profile: ApiProfile): ApiProfile {
	return {
		...profile,
		bedrock: profile.bedrock
			? {
					...profile.bedrock,
					awsAccessKey: "",
					awsSecretKey: "",
					awsSessionToken: "",
					awsBedrockApiKey: "",
				}
			: undefined,
		sapaicore: profile.sapaicore ? { ...profile.sapaicore, clientSecret: "" } : undefined,
	}
}

async function persistProviderSecrets(profiles: ApiProfile[]): Promise<void> {
	const changes: Record<string, ProviderSecretEntry | undefined> = {}
	const profileIds = new Set(profiles.map((profile) => profile.id))
	for (const id of Object.keys(getAllProviderSecrets())) {
		if (!profileIds.has(id)) changes[id] = undefined
	}
	for (const profile of profiles) changes[profile.id] = collectProviderSecrets(profile)
	await setProviderSecretsBatch(changes)
}

function hydrateProviderSecrets(profiles: ApiProfile[]): boolean {
	let migrated = false
	for (const profile of profiles) {
		const embedded = collectProviderSecrets(profile)
		const stored = getProviderSecret(profile.id)
		const secrets = { ...stored?.secrets, ...embedded?.secrets }
		if (Object.keys(secrets).length === 0) continue

		if (profile.provider === "bedrock" || profile.bedrock) {
			const bedrock = profile.bedrock ?? BedrockProviderConfig.create()
			profile.bedrock = {
				...bedrock,
				awsAccessKey: secrets.awsAccessKey ?? bedrock.awsAccessKey,
				awsSecretKey: secrets.awsSecretKey ?? bedrock.awsSecretKey,
				awsSessionToken: secrets.awsSessionToken ?? bedrock.awsSessionToken,
				awsBedrockApiKey: secrets.awsBedrockApiKey ?? bedrock.awsBedrockApiKey,
			}
		}
		if (profile.provider === "sapaicore" || profile.sapaicore) {
			const sapaicore = profile.sapaicore ?? SapAiCoreProviderConfig.create()
			profile.sapaicore = { ...sapaicore, clientSecret: secrets.clientSecret ?? sapaicore.clientSecret }
		}

		if (embedded) {
			void setProviderSecretsBatch({
				[profile.id]: { name: profile.name, provider: profile.provider, secrets },
			})
			migrated = true
		}
	}
	return migrated
}

function hydrateApiKeys(profiles: ApiProfile[]): boolean {
	let migrated = false
	for (const profile of profiles) {
		if (profile.apiKey) {
			const stored = getApiKey(profile.id)
			if (!stored || stored !== profile.apiKey) {
				setApiKey(profile.id, profile.apiKey, profile.name)
			}
			migrated = true
			continue
		}

		const storedKey = getApiKey(profile.id)
		if (storedKey) {
			profile.apiKey = storedKey
		}
	}
	return migrated
}

/**
 * Persist a migrated Catalog only while the disk document still matches the exact snapshot read.
 * This prevents a slower startup migration from overwriting a newer cross-window mutation.
 */
export async function cleanRewriteApiProfiles(rawAtRead: string, profiles: ApiProfile[]): Promise<boolean> {
	const settingsDir = path.join(getDlineDataDir(), "settings")
	const filePath = path.join(settingsDir, API_PROFILES_FILE)
	try {
		// Keep the same lock order as ProfileCatalogRepository.mutate:
		// file lock first, then the process-local writer queue. Reversing these
		// two boundaries can deadlock a startup rewrite against a live mutation.
		const rewritten = await cleanRewriteFileLock.withLock(filePath, () =>
			enqueueApiProfilesWrite(async () => {
				const currentRaw = await fs.readFile(filePath, "utf8")
				if (currentRaw !== rawAtRead) return false
				await persistApiProfilesFile(filePath, profiles)
				return true
			}),
		)
		if (rewritten) {
			Logger.log("[cleanRewriteApiProfiles] Stripped apiKey fields from api_profiles.json")
		} else if (Logger.isDebugEnabled()) {
			Logger.debug("[cleanRewriteApiProfiles] Skipped stale api_profiles.json snapshot")
		}
		return rewritten
	} catch (err) {
		Logger.error("[cleanRewriteApiProfiles] Failed:", err)
		return false
	}
}

/**
 * Get all saved ApiProfiles.
 * Auto-initializes from apiConfiguration if no saved data exists.
 */
export async function getApiProfiles(controller: Controller, _request: EmptyRequest): Promise<ApiProfilesResponse> {
	const startedAt = performance.now()
	const settingsDir = path.join(getDlineDataDir(), "settings")
	const filePath = path.join(settingsDir, API_PROFILES_FILE)

	try {
		let stageStartedAt = performance.now()
		const raw = await fs.readFile(filePath, "utf8")
		const readMs = Math.round(performance.now() - stageStartedAt)
		const parsed = parseApiProfilesJson(raw)
		const profiles = parsed.profiles
		const apiKeysMigrated = hydrateApiKeys(profiles)
		const providerSecretsMigrated = hydrateProviderSecrets(profiles)
		stageStartedAt = performance.now()
		const modelInfoChanged = await hydrateModelInfoFromRegistry(profiles)
		const hydrateMs = Math.round(performance.now() - stageStartedAt)
		if (parsed.recovered) {
			// Recovered JSON is genuinely damaged on disk and must be repaired now,
			// unless another writer has already replaced the damaged snapshot.
			if (await cleanRewriteApiProfiles(raw, profiles)) registryModelInfoRepairedPaths.add(filePath)
		} else if (parsed.migrated || apiKeysMigrated || providerSecretsMigrated) {
			// Persist migrations derived from this exact disk snapshot. Request
			// normalization must never schedule an unrelated Catalog rewrite.
			if (await cleanRewriteApiProfiles(raw, profiles)) registryModelInfoRepairedPaths.add(filePath)
		} else if (modelInfoChanged && !registryModelInfoRepairedPaths.has(filePath)) {
			// Registry drift only needs to reach disk once per process. Every later
			// read serves the hydrated in-memory Catalog without waking the watcher.
			if (await cleanRewriteApiProfiles(raw, profiles)) registryModelInfoRepairedPaths.add(filePath)
		}
		// Flush any pending globalState writes before ensureProfileDefaults
		// reads planModeProfile/actModeProfile, so it sees the latest values
		// and doesn't incorrectly reset to the provider default.
		stageStartedAt = performance.now()
		await controller.stateManager.flushPendingState()
		const firstFlushMs = Math.round(performance.now() - stageStartedAt)
		const defaultsChanged = ensureProfileDefaults(controller, profiles)
		// Only post state to webview if defaults actually changed (Bug fix:
		// posting on every read causes excessive webview re-renders and
		// contributes to updateApiProfiles call storms).
		let defaultsFlushMs = 0
		let publishMs = 0
		if (defaultsChanged) {
			stageStartedAt = performance.now()
			await controller.stateManager.flushPendingState()
			defaultsFlushMs = Math.round(performance.now() - stageStartedAt)
			stageStartedAt = performance.now()
			await controller.postStateToWebview()
			publishMs = Math.round(performance.now() - stageStartedAt)
		}
		recordProfileCatalogBaseline(controller, profiles)
		recordPerfPhase(
			PerfDomain.Profile,
			"get_profiles",
			performance.now() - startedAt,
			{
				outcome: "read",
				profiles: profiles.length,
				readMs,
				hydrateMs,
				firstFlushMs,
				defaultsChanged,
				defaultsFlushMs,
				publishMs,
			},
			{ taskId: controller.task?.taskId },
		)
		if (Logger.isDebugEnabled()) {
			Logger.debug(
				`[ProfilePerf] phase=get_profiles taskId=${controller.task?.taskId ?? "none"} outcome=read profiles=${profiles.length} readMs=${readMs} hydrateMs=${hydrateMs} firstFlushMs=${firstFlushMs} defaultsChanged=${defaultsChanged} defaultsFlushMs=${defaultsFlushMs} publishMs=${publishMs} totalMs=${Math.round(performance.now() - startedAt)}`,
			)
		}
		return ApiProfilesResponse.create({ profiles })
	} catch (err: any) {
		if (err.code === "ENOENT") {
			const initializeStartedAt = performance.now()
			// Try migration from providers first, then fall back to legacy config
			let profiles = await migrateFromProviders(controller)
			Logger.log(`[getApiProfiles] migrateFromProviders returned ${profiles.length} profiles`)
			if (profiles.length === 0) {
				profiles = initializeFromApiConfig(controller)
				Logger.log(`[getApiProfiles] initializeFromApiConfig returned ${profiles.length} profiles`)
			}
			await hydrateModelInfoFromRegistry(profiles)
			await saveProfilesToFile(filePath, profiles)
			// Flush any pending globalState writes before ensureProfileDefaults
			// reads planModeProfile/actModeProfile, so it sees the latest values
			// and doesn't incorrectly reset to the provider default.
			await controller.stateManager.flushPendingState()
			if (ensureProfileDefaults(controller, profiles)) {
				await controller.stateManager.flushPendingState()
			}
			// Always post on first initialization so webview picks up defaults
			await controller.postStateToWebview()
			recordProfileCatalogBaseline(controller, profiles)
			recordPerfPhase(
				PerfDomain.Profile,
				"get_profiles",
				performance.now() - startedAt,
				{
					outcome: "initialize",
					profiles: profiles.length,
					initializeMs: Math.round(performance.now() - initializeStartedAt),
				},
				{ taskId: controller.task?.taskId },
			)
			if (Logger.isDebugEnabled()) {
				Logger.debug(
					`[ProfilePerf] phase=get_profiles taskId=${controller.task?.taskId ?? "none"} outcome=initialize profiles=${profiles.length} initializeMs=${Math.round(performance.now() - initializeStartedAt)} totalMs=${Math.round(performance.now() - startedAt)}`,
				)
			}
			return ApiProfilesResponse.create({ profiles })
		}
		Logger.error("[getApiProfiles] Failed to read api_profiles.json:", err)
		throw err
	}
}

/**
 * Initialize absent global Profile bindings or migrate one unique legacy name.
 * Explicit missing IDs, missing names, and ambiguous legacy names remain unchanged
 * so Task admission can fail closed instead of silently selecting a fallback.
 */
function ensureProfileDefaults(controller: Controller, profiles: ApiProfile[]): boolean {
	const apiConfig = controller.stateManager.getApiConfiguration()

	let lastUsedProvider: string | undefined
	try {
		const providersPath = path.join(getDlineDataDir(), "settings", "providers.json")
		if (fsSync.existsSync(providersPath)) {
			const raw = fsSync.readFileSync(providersPath, "utf8")
			const data = JSON.parse(raw)
			lastUsedProvider = data?.lastUsedProvider as string | undefined
		}
	} catch {
		// providers.json may not exist or be malformed.
	}

	const reconcileMode = (mode: "plan" | "act"): boolean => {
		const idKey = mode === "plan" ? "planModeProfileId" : "actModeProfileId"
		const nameKey = mode === "plan" ? "planModeProfile" : "actModeProfile"
		const profileId = apiConfig[idKey]
		const profileName = apiConfig[nameKey]

		if (profileId) {
			const profile = profiles.find((candidate) => candidate.id === profileId)
			if (!profile || profile.name === profileName) return false
			controller.stateManager.setGlobalState(idKey, profile.id)
			controller.stateManager.setGlobalState(nameKey, profile.name)
			return true
		}

		if (profileName) {
			const matches = profiles.filter((candidate) => candidate.name === profileName)
			if (matches.length !== 1) return false
			controller.stateManager.setGlobalState(idKey, matches[0].id)
			controller.stateManager.setGlobalState(nameKey, matches[0].name)
			return true
		}

		const matchingProvider = lastUsedProvider
			? profiles.find(
					(candidate) =>
						candidate.enabled && candidate.provider === lastUsedProvider && candidate.usedFor.includes(mode),
				)
			: undefined
		const initial = matchingProvider ?? profiles.find((candidate) => candidate.enabled && candidate.usedFor.includes(mode))
		if (!initial) return false
		controller.stateManager.setGlobalState(idKey, initial.id)
		controller.stateManager.setGlobalState(nameKey, initial.name)
		return true
	}

	const planChanged = reconcileMode("plan")
	const actChanged = reconcileMode("act")
	return planChanged || actChanged
}

/**
 * Migrate provider model configs from ~/.dline/providers/*.json into ApiProfiles.
 * Also migrates legacy API keys from flat secrets to the new ApiKeyStore.
 * Only runs when api_profiles.json does not exist.
 */
async function migrateFromProviders(controller: Controller): Promise<ApiProfile[]> {
	const providersDir = path.join(getDlineHomePath(), "providers")
	if (!fsSync.existsSync(providersDir)) return []

	const files = fsSync.readdirSync(providersDir).filter((f) => f.endsWith(".json"))
	if (files.length === 0) return []

	const stateManager = controller.stateManager
	const profiles: ApiProfile[] = []

	for (const file of files) {
		const providerId = path.basename(file, ".json")
		let config: { provider: string; defaultModelId?: string; models: Record<string, unknown> }
		try {
			const raw = fsSync.readFileSync(path.join(providersDir, file), "utf8")
			config = JSON.parse(raw)
		} catch {
			Logger.warn(`[migrateFromProviders] Skipping invalid JSON: ${file}`)
			continue
		}

		if (!config.models || typeof config.models !== "object" || Object.keys(config.models).length === 0) continue

		const legacyProviderName = config.provider || providerId
		const providerName = legacyProviderName

		// Only migrate providers that have an API key in legacy flat secrets
		const secretFields = ProviderToApiKeyMap[legacyProviderName as keyof typeof ProviderToApiKeyMap]
		if (!secretFields) continue

		const fields = Array.isArray(secretFields) ? secretFields : [secretFields]
		const keyParts: string[] = []

		for (const field of fields) {
			try {
				const val = stateManager.getSecretKey(field as any)
				if (!val) continue
				// Structured JSON credentials remain serialized at this compatibility boundary.
				if (typeof val === "object") {
					keyParts.push(JSON.stringify(val))
				} else if (typeof val === "string" && val.length > 0) {
					keyParts.push(val)
				}
			} catch {
				// Secret key not found — skip this field
			}
		}

		const combinedKey = keyParts.join("|")
		if (!combinedKey) continue

		const modelId = config.defaultModelId || Object.keys(config.models)[0]
		const profileId = crypto.randomUUID()

		profiles.push(
			ApiProfile.create({
				id: profileId,
				name: `${providerName}:${modelId}`,
				provider: providerName,
				apiKey: combinedKey,
				modelId,
				usedFor: ["act", "plan", "subagents"],
				enabled: true,
			}),
		)

		// Migrate API key to new ApiKeyStore
		setApiKey(profileId, combinedKey, providerName)
		Logger.log(`[migrateFromProviders] Migrated API key for ${providerName}`)
	}

	return profiles
}

/**
 * @deprecated Use ensureProfileDefaults and profile-driven model selection instead.
 * Reads legacy apiConfiguration via StateManager to create initial ApiProfiles.
 */
function initializeFromApiConfig(controller: Controller): ApiProfile[] {
	const config = controller.stateManager.getApiConfiguration() as Record<string, unknown> | undefined
	if (!config) return []
	const profiles: ApiProfile[] = []
	const modes = [
		{ mode: "plan", prefix: "planMode" },
		{ mode: "act", prefix: "actMode" },
	]
	for (const { mode, prefix } of modes) {
		const provider = config[`${prefix}ApiProvider`]
		const modelId = config[`${prefix}ApiModelId`]
		if (provider && modelId) {
			profiles.push(
				ApiProfile.create({
					id: crypto.randomUUID(),
					name: `${provider}:${modelId}`,
					provider: String(provider),
					apiKey: "",
					modelId: String(modelId),
					usedFor: [mode],
					enabled: true,
				}),
			)
		}
	}
	return profiles
}

/** Read the latest persisted Catalog without consulting or updating the process cache. */
export async function readApiProfilesFresh(): Promise<ApiProfile[]> {
	const filePath = path.join(getDlineDataDir(), "settings", API_PROFILES_FILE)
	try {
		const raw = await fs.readFile(filePath, "utf8")
		const profiles = parseApiProfilesJson(raw).profiles
		reloadApiKeyStore()
		reloadProviderSecretStore()
		hydrateApiKeys(profiles)
		hydrateProviderSecrets(profiles)
		applyRegistryModelDefaults(profiles)
		applyRegistryModelInfo(profiles)
		return profiles
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		throw error
	}
}

/**
 * Synchronously read ApiProfiles from disk.
 * Backfills apiKey from ApiKeyStore for each profile.
 * Returns empty array on any error.
 */
export function readApiProfiles(): ApiProfile[] {
	const settingsDir = path.join(getDlineDataDir(), "settings")
	const filePath = path.join(settingsDir, API_PROFILES_FILE)
	try {
		const stat = fsSync.statSync(filePath)
		const registryVersion = ModelRegistry.getInstance().version
		if (
			apiProfilesReadCache?.filePath === filePath &&
			apiProfilesReadCache.mtimeMs === stat.mtimeMs &&
			apiProfilesReadCache.size === stat.size &&
			apiProfilesReadCache.registryVersion === registryVersion
		) {
			return apiProfilesReadCache.profiles
		}
		const raw = fsSync.readFileSync(filePath, "utf8")
		const parsed = parseApiProfilesJson(raw)
		const profiles = parsed.profiles
		const apiKeysMigrated = hydrateApiKeys(profiles)
		const providerSecretsMigrated = hydrateProviderSecrets(profiles)
		const defaultsChanged = applyRegistryModelDefaults(profiles)
		const modelInfoChanged = applyRegistryModelInfo(profiles) || defaultsChanged
		if (parsed.recovered || parsed.migrated || apiKeysMigrated || providerSecretsMigrated) {
			void cleanRewriteApiProfiles(raw, profiles).then((rewritten) => {
				if (rewritten) registryModelInfoRepairedPaths.add(filePath)
			})
		} else if (modelInfoChanged && !registryModelInfoRepairedPaths.has(filePath)) {
			// This synchronous reader runs on hot paths such as findEnabledProfiles and
			// profile-reference resolution. Rewriting on every call re-triggered the
			// Catalog watcher and starved newly opened panels of a settled Catalog.
			void cleanRewriteApiProfiles(raw, profiles).then((rewritten) => {
				if (rewritten) registryModelInfoRepairedPaths.add(filePath)
			})
		}
		apiProfilesReadCache = {
			filePath,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			registryVersion,
			profiles,
		}
		return profiles
	} catch {
		if (apiProfilesReadCache?.filePath === filePath) {
			apiProfilesReadCache = undefined
		}
		return []
	}
}

/**
 * Find enabled profiles for a given provider.
 * Used by refresh functions and initializeWebview to locate profiles
 * with valid apiKeys before making model-list API calls.
 */
export function findEnabledProfiles(provider: string): ApiProfile[] {
	return readApiProfiles().filter((p) => p.provider === provider && p.enabled !== false)
}

export function findEnabledProfileByName(profileName?: string): ApiProfile | undefined {
	if (!profileName) return undefined
	// enabled flag indicates "configured", not "selected".
	// Always find by name regardless of enabled status — the selection
	// is tracked via planModeProfile/actModeProfile in globalState.
	return readApiProfiles().find((p) => p.name === profileName)
}

/**
 * Write profiles array to api_profiles.json.
 */
async function saveProfilesToFile(filePath: string, profiles: ApiProfile[]): Promise<void> {
	try {
		await writeApiProfilesToFile(filePath, profiles)
		Logger.log(`[getApiProfiles] Initialized api_profiles.json with ${profiles.length} profile(s)`)
	} catch (err) {
		Logger.error("[getApiProfiles] Failed to write api_profiles.json:", err)
	}
}

/**
 * Map of provider name to its primary API key field name.
 * Used by updateApiConfiguration and StateManager to bridge apiKey fields
 * with the profile-based key storage.
 */
export const PROVIDER_API_KEY_MAP: Record<string, string> = (() => {
	const map: Record<string, string> = {}
	for (const [provider, field] of Object.entries(ProviderToApiKeyMap)) {
		map[provider] = Array.isArray(field) ? field[0] : field
	}
	return map
})()

export { saveProfilesToFile }

import fsSync from "node:fs"
import path from "node:path"
import { getDlineDataDir } from "@core/storage/disk"
import { type ApiKeyEntry, getAllApiKeys, getApiKey, setApiKeysBatch } from "@core/storage/secrets"
import { ImageGenerationProfile, type UpdateImageGenerationProfilesRequest } from "@shared/proto/dline/profile"
import { writeFileAtomic } from "@shared/storage/atomic-file"

const IMAGE_GENERATION_PROFILES_FILE = "image_generation_profiles.json"
const IMAGE_SECRET_PREFIX = "image:"

function filePath(): string {
	return path.join(getDlineDataDir(), "settings", IMAGE_GENERATION_PROFILES_FILE)
}

export function imageGenerationProfileSecretId(profileId: string): string {
	return `${IMAGE_SECRET_PREFIX}${profileId}`
}

export function normalizeImageGenerationProfile(value: unknown): ImageGenerationProfile {
	const profile = ImageGenerationProfile.fromJSON(value ?? {})
	const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
	if (raw && !Object.hasOwn(raw, "enabled")) profile.enabled = true
	return profile
}

export function serializeImageGenerationProfiles(profiles: readonly ImageGenerationProfile[]): unknown[] {
	return profiles.map((profile) => {
		const serialized = ImageGenerationProfile.toJSON({ ...profile, apiKey: "" }) as Record<string, unknown>
		delete serialized.apiKey
		delete serialized.api_key
		return serialized
	})
}

function hydrateApiKeys(profiles: ImageGenerationProfile[]): void {
	for (const profile of profiles) {
		profile.apiKey = getApiKey(imageGenerationProfileSecretId(profile.id)) ?? ""
	}
}

export function projectImageGenerationProfilesForUi(profiles: readonly ImageGenerationProfile[]): ImageGenerationProfile[] {
	return profiles.map((profile) => ImageGenerationProfile.create({ ...profile, apiKey: "" }))
}

export function readImageGenerationProfiles(): ImageGenerationProfile[] {
	try {
		const raw = fsSync.readFileSync(filePath(), "utf8")
		const parsed = JSON.parse(raw)
		const values = Array.isArray(parsed) ? parsed : []
		const profiles = values.map(normalizeImageGenerationProfile)
		hydrateApiKeys(profiles)
		return profiles
	} catch {
		return []
	}
}

async function writeProfiles(profiles: readonly ImageGenerationProfile[]): Promise<void> {
	// Tab indentation matches the neighbouring API profile catalog.
	await writeFileAtomic(filePath(), `${JSON.stringify(serializeImageGenerationProfiles(profiles), null, "\t")}\n`)
}

function buildApiKeyChanges(
	previous: readonly ImageGenerationProfile[],
	profiles: ImageGenerationProfile[],
	request: UpdateImageGenerationProfilesRequest,
): Record<string, ApiKeyEntry | undefined> {
	const stored = getAllApiKeys()
	const clearIds = new Set(request.clearApiKeyProfileIds)
	const nextSecretIds = new Set(profiles.map((profile) => imageGenerationProfileSecretId(profile.id)))
	const changes: Record<string, ApiKeyEntry | undefined> = {}

	for (const profile of previous) {
		const secretId = imageGenerationProfileSecretId(profile.id)
		if (!nextSecretIds.has(secretId)) changes[secretId] = undefined
	}
	for (const [secretId] of Object.entries(stored)) {
		if (secretId.startsWith(IMAGE_SECRET_PREFIX) && !nextSecretIds.has(secretId)) changes[secretId] = undefined
	}
	for (const profile of profiles) {
		const secretId = imageGenerationProfileSecretId(profile.id)
		const current = stored[secretId]
		if (clearIds.has(profile.id)) {
			profile.apiKey = ""
			if (current) changes[secretId] = undefined
		} else if (profile.apiKey) {
			if (!current || current.apiKey !== profile.apiKey || current.name !== profile.name) {
				changes[secretId] = { apiKey: profile.apiKey, name: profile.name }
			}
		} else if (current && current.name !== profile.name) {
			changes[secretId] = { apiKey: current.apiKey, name: profile.name }
		}
	}
	return changes
}

export async function updateImageGenerationProfileCatalog(request: UpdateImageGenerationProfilesRequest): Promise<void> {
	const previous = readImageGenerationProfiles()
	const profiles = request.profiles.map((profile) => normalizeImageGenerationProfile(profile))
	await setApiKeysBatch(buildApiKeyChanges(previous, profiles, request))
	await writeProfiles(profiles)
}

import { createHash } from "node:crypto"
import path from "node:path"

export const LEGACY_OPENAI_CODEX_AUTH_FILE_NAME = "openai_codex_oauth.json"
export const LEGACY_OPENAI_CODEX_AUTH_MIGRATION_FILE_NAME = "openai_codex_oauth.migration.json"
const PROFILE_AUTH_FILE_PATTERN = /^openai_codex_oauth_(?:[A-Za-z0-9._~-]|%[A-F0-9]{2})+\.json$/
const LEGACY_HASHED_PROFILE_AUTH_FILE_PATTERN = /^openai_codex_[a-f0-9]{32}\.json$/

function requireProfileId(profileId: string): string {
    if (typeof profileId !== "string" || profileId.length === 0) {
        throw new Error("OpenAI Codex OAuth credential requires a non-empty profile ID.")
    }
    return profileId
}

function encodeProfileId(profileId: string): string {
    return encodeURIComponent(requireProfileId(profileId)).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    )
}

export function getOpenAiCodexProfileAuthDigest(profileId: string): string {
    return createHash("sha256").update(requireProfileId(profileId)).digest("hex").slice(0, 32)
}

export function getLegacyHashedOpenAiCodexProfileAuthFileName(profileId: string): string {
    return `openai_codex_${getOpenAiCodexProfileAuthDigest(profileId)}.json`
}

export function getLegacyHashedOpenAiCodexProfileAuthPath(secretsDir: string, profileId: string): string {
    return path.join(path.resolve(secretsDir), getLegacyHashedOpenAiCodexProfileAuthFileName(profileId))
}

export function getOpenAiCodexProfileAuthFileName(profileId: string): string {
    return `openai_codex_oauth_${encodeProfileId(profileId)}.json`
}

export function getOpenAiCodexProfileAuthPath(secretsDir: string, profileId: string): string {
    return path.join(path.resolve(secretsDir), getOpenAiCodexProfileAuthFileName(profileId))
}

export function getLegacyOpenAiCodexAuthPath(secretsDir: string): string {
    return path.join(path.resolve(secretsDir), LEGACY_OPENAI_CODEX_AUTH_FILE_NAME)
}

export function getLegacyOpenAiCodexAuthMigrationPath(secretsDir: string): string {
    return path.join(path.resolve(secretsDir), LEGACY_OPENAI_CODEX_AUTH_MIGRATION_FILE_NAME)
}

export function isOpenAiCodexProfileAuthFileName(fileName: string): boolean {
    return PROFILE_AUTH_FILE_PATTERN.test(fileName) || LEGACY_HASHED_PROFILE_AUTH_FILE_PATTERN.test(fileName)
}

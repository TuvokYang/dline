/**
 * ApiKeyStore — persistent storage for provider API keys.
 *
 * Backed by data/secrets/api_keys.json (0o600 permissions).
 * Key format: profile id (uuid).
 * Value format: { apiKey: string, name: string } — name is the profile display name for human inspection.
 */
import path from "node:path"
import { ClineFileStorage } from "@shared/storage/ClineFileStorage"
import { getDlineDataDir } from "../disk"

const API_KEYS_FILE = "api_keys.json"

/** Entry stored per profile in api_keys.json. */
export interface ApiKeyEntry {
    apiKey: string
    name: string
}

let _store: ClineFileStorage<ApiKeyEntry> | null = null

function getStore(): ClineFileStorage<ApiKeyEntry> {
    if (!_store) {
        const dir = path.join(getDlineDataDir(), "secrets")
        _store = new ClineFileStorage<ApiKeyEntry>(path.join(dir, API_KEYS_FILE), "ApiKeyStore", {
            fileMode: 0o600,
        })
    }
    return _store
}

/** Get API key by profile ID (uuid). */
export function getApiKey(id: string): string | undefined {
    return getStore().get(id)?.apiKey
}

/** Store API key for a profile ID with display name for inspection. */
export function setApiKey(id: string, apiKey: string, name: string): void {
    getStore().set(id, { apiKey, name })
}

/** Update only the name field of an existing entry. Preserves apiKey unchanged. */
export function migrateApiKey(id: string, name: string): void {
    const store = getStore()
    const existing = store.get(id)
    if (existing) {
        store.set(id, { apiKey: existing.apiKey, name })
    }
}

/** Delete API key by profile ID. */
export function deleteApiKey(id: string): void {
    getStore().delete(id)
}

/** Apply multiple API key changes with a single atomic file write. */
export function setApiKeysBatch(entries: Record<string, ApiKeyEntry | undefined>): Thenable<void> {
    return getStore().setBatch(entries)
}

/** Get all stored API key entries. */
export function reloadApiKeyStore(): void {
    getStore().reload()
}

export function getAllApiKeys(): Record<string, ApiKeyEntry> {
    const store = getStore()
    const result: Record<string, ApiKeyEntry> = {}
    for (const k of store.keys()) {
        const v = store.get(k)
        if (v) result[k] = v
    }
    return result
}

/** Reset singleton (testing only). */
export function resetApiKeyStore(): void {
    _store = null
}

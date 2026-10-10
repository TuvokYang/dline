/**
 * ProviderSecretStore persists provider-specific credentials that cannot use
 * the single top-level ApiProfile.apiKey field.
 */
import path from "node:path"
import { ClineFileStorage } from "@shared/storage/ClineFileStorage"
import { getDlineDataDir } from "../disk"

const PROVIDER_SECRETS_FILE = "provider_secrets.json"

export interface ProviderSecretEntry {
    name: string
    provider: string
    secrets: Record<string, string>
}

let store: ClineFileStorage<ProviderSecretEntry> | null = null

function getStore(): ClineFileStorage<ProviderSecretEntry> {
    if (!store) {
        const dir = path.join(getDlineDataDir(), "secrets")
        store = new ClineFileStorage<ProviderSecretEntry>(path.join(dir, PROVIDER_SECRETS_FILE), "ProviderSecretStore", {
            fileMode: 0o600,
        })
    }
    return store
}

export function getProviderSecret(id: string): ProviderSecretEntry | undefined {
    return getStore().get(id)
}

export function setProviderSecretsBatch(entries: Record<string, ProviderSecretEntry | undefined>): Thenable<void> {
    return getStore().setBatch(entries)
}

export function reloadProviderSecretStore(): void {
    getStore().reload()
}

export function getAllProviderSecrets(): Record<string, ProviderSecretEntry> {
    const result: Record<string, ProviderSecretEntry> = {}
    const providerSecrets = getStore()
    for (const id of providerSecrets.keys()) {
        const entry = providerSecrets.get(id)
        if (entry) result[id] = entry
    }
    return result
}

export function resetProviderSecretStore(): void {
    store = null
}

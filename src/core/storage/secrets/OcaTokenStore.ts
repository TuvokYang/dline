/**
 * OcaTokenStore — persistent storage for OCA authentication tokens.
 *
 * Backed by data/secrets/oca_tokens.json (0o600 permissions).
 */
import path from "node:path"
import { ClineFileStorage } from "@shared/storage/ClineFileStorage"
import { getDlineDataDir } from "../disk"

const OCA_TOKENS_FILE = "oca_tokens.json"

export interface OcaTokenData {
    accessToken?: string
    refreshToken?: string
}

let _store: ClineFileStorage<string> | null = null

function getStore(): ClineFileStorage<string> {
    if (!_store) {
        const dir = path.join(getDlineDataDir(), "secrets")
        _store = new ClineFileStorage<string>(path.join(dir, OCA_TOKENS_FILE), "OcaTokenStore", {
            fileMode: 0o600,
        })
    }
    return _store
}

export function getOcaAccessToken(): string | undefined {
    return getStore().get("accessToken")
}

export function getOcaRefreshToken(): string | undefined {
    return getStore().get("refreshToken")
}

export function getOcaTokens(): OcaTokenData {
    const store = getStore()
    return {
        accessToken: store.get("accessToken") || undefined,
        refreshToken: store.get("refreshToken") || undefined,
    }
}

export function saveOcaTokens(accessToken: string, refreshToken: string): void {
    const store = getStore()
    store.set("accessToken", accessToken)
    store.set("refreshToken", refreshToken)
}

export function setOcaAccessToken(token: string): void {
    getStore().set("accessToken", token)
}

export function setOcaRefreshToken(token: string): void {
    getStore().set("refreshToken", token)
}

export function clearOcaTokens(): void {
    const store = getStore()
    store.delete("accessToken")
    store.delete("refreshToken")
}

export function resetOcaTokenStore(): void {
    _store = null
}

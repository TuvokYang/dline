/**
 * AccountStore — persistent storage for Cline account credentials.
 *
 * Backed by data/secrets/account.json (0o600 permissions).
 * Stores: apiKey (clineApiKey), accountId (clineAccountId), firebaseAccountId (cline:clineAccountId)
 */
import path from "node:path"
import { ClineFileStorage } from "@shared/storage/ClineFileStorage"
import { getDlineDataDir } from "../disk"

const ACCOUNT_FILE = "account.json"

let _store: ClineFileStorage<string> | null = null

function getStore(): ClineFileStorage<string> {
    if (!_store) {
        const dir = path.join(getDlineDataDir(), "secrets")
        _store = new ClineFileStorage<string>(path.join(dir, ACCOUNT_FILE), "AccountStore", {
            fileMode: 0o600,
        })
    }
    return _store
}

/** Get Cline API key (formerly clineApiKey in secrets.json). */
export function getAccountApiKey(): string | undefined {
    return getStore().get("apiKey")
}

/** Set Cline API key. */
export function setAccountApiKey(value: string): void {
    getStore().set("apiKey", value)
}

/** Get Cline account ID (formerly clineAccountId in secrets.json). */
export function getAccountId(): string | undefined {
    return getStore().get("accountId")
}

/** Set Cline account ID. */
export function setAccountId(value: string): void {
    getStore().set("accountId", value)
}

/** Get Firebase account ID (formerly cline:clineAccountId in secrets.json). */
export function getFirebaseAccountId(): string | undefined {
    return getStore().get("firebaseAccountId")
}

/** Set Firebase account ID. */
export function setFirebaseAccountId(value: string): void {
    getStore().set("firebaseAccountId", value)
}

/** Reset singleton (testing only). */
export function resetAccountStore(): void {
    _store = null
}

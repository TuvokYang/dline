/**
 * Persistent OpenAI Codex OAuth credentials.
 *
 * Stored as individual fields in data/secrets/openai_codex_oauth.json so the
 * active credential path no longer depends on the legacy secrets.json blob.
 */
import path from "node:path"
import { ClineFileStorage } from "@shared/storage/ClineFileStorage"
import { getDlineDataDir } from "../disk"

const OPENAI_CODEX_OAUTH_FILE = "openai_codex_oauth.json"

export interface OpenAiCodexAuthData {
    type: "openai-codex"
    access_token: string
    refresh_token: string
    expires: number
    email?: string
    accountId?: string
}

type OpenAiCodexAuthValue = string | number

let store: ClineFileStorage<OpenAiCodexAuthValue> | null = null

function getStore(): ClineFileStorage<OpenAiCodexAuthValue> {
    if (!store) {
        const dir = path.join(getDlineDataDir(), "secrets")
        store = new ClineFileStorage<OpenAiCodexAuthValue>(path.join(dir, OPENAI_CODEX_OAUTH_FILE), "OpenAiCodexAuthStore", {
            fileMode: 0o600,
        })
    }
    return store
}

export function getOpenAiCodexAuth(): OpenAiCodexAuthData | undefined {
    const authStore = getStore()
    const type = authStore.get("type")
    const accessToken = authStore.get("access_token")
    const refreshToken = authStore.get("refresh_token")
    const expires = authStore.get("expires")
    if (
        type !== "openai-codex" ||
        typeof accessToken !== "string" ||
        typeof refreshToken !== "string" ||
        typeof expires !== "number"
    ) {
        return undefined
    }

    const email = authStore.get("email")
    const accountId = authStore.get("accountId")
    return {
        type,
        access_token: accessToken,
        refresh_token: refreshToken,
        expires,
        ...(typeof email === "string" ? { email } : {}),
        ...(typeof accountId === "string" ? { accountId } : {}),
    }
}

export function saveOpenAiCodexAuth(credentials: OpenAiCodexAuthData): Thenable<void> {
    return getStore().setBatch({
        type: credentials.type,
        access_token: credentials.access_token,
        refresh_token: credentials.refresh_token,
        expires: credentials.expires,
        email: credentials.email,
        accountId: credentials.accountId,
    })
}

export function clearOpenAiCodexAuth(): Thenable<void> {
    return getStore().setBatch({
        type: undefined,
        access_token: undefined,
        refresh_token: undefined,
        expires: undefined,
        email: undefined,
        accountId: undefined,
    })
}

export function resetOpenAiCodexAuthStore(): void {
    store = null
}

/**
 * McpOAuthStore — persistent storage for MCP OAuth tokens.
 *
 * Backed by data/secrets/mcp_oauth.json (0o600 permissions).
 * Each entry is keyed by MCP server hash.
 */
import path from "node:path"
import { ClineFileStorage } from "@shared/storage/ClineFileStorage"
import { getDlineDataDir } from "../disk"

const MCP_OAUTH_FILE = "mcp_oauth.json"

export interface McpOAuthServerData {
    client_info?: Record<string, unknown>
    redirect_url_at_registration?: string
    tokens?: Record<string, unknown>
    tokens_saved_at?: number
    oauth_state?: string
    oauth_state_timestamp?: number
    pending_auth_url?: string
    code_verifier?: string
}

type McpOAuthData = Record<string, McpOAuthServerData>

let _store: ClineFileStorage<McpOAuthServerData> | null = null

function getStore(): ClineFileStorage<McpOAuthServerData> {
    if (!_store) {
        const dir = path.join(getDlineDataDir(), "secrets")
        _store = new ClineFileStorage<McpOAuthServerData>(path.join(dir, MCP_OAUTH_FILE), "McpOAuthStore", {
            fileMode: 0o600,
        })
    }
    return _store
}

export function getAllMcpOAuthSecrets(): McpOAuthData {
    const store = getStore()
    const result: McpOAuthData = {}
    for (const k of store.keys()) {
        const v = store.get(k)
        if (v) result[k] = v
    }
    return result
}

export function getMcpOAuthServer(serverHash: string): McpOAuthServerData | undefined {
    return getStore().get(serverHash)
}

export function saveMcpOAuthServer(serverHash: string, data: McpOAuthServerData): void {
    getStore().set(serverHash, data)
}

export function deleteMcpOAuthServer(serverHash: string): void {
    getStore().delete(serverHash)
}

export function setAllMcpOAuthSecrets(data: McpOAuthData): void {
    const store = getStore()
    for (const k of store.keys()) store.delete(k)
    for (const [k, v] of Object.entries(data)) store.set(k, v)
}

export function resetMcpOAuthStore(): void {
    _store = null
}

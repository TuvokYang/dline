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

/**
 * The latest persisted data for one server.
 *
 * Every Dline window shares this file, and another window may have registered a client or rotated
 * tokens since this process last wrote it, so the file is read again on every call.
 */
export function getMcpOAuthServer(serverHash: string): McpOAuthServerData | undefined {
    const store = getStore()
    store.reload()
    return store.get(serverHash)
}

/**
 * Applies a change to one server's data on top of its latest persisted copy, so fields another
 * window wrote meanwhile survive. Returning undefined removes the server's data.
 */
export function updateMcpOAuthServer(
    serverHash: string,
    change: (current: McpOAuthServerData) => McpOAuthServerData | undefined,
): void {
    const store = getStore()
    store.reload()
    const next = change({ ...(store.get(serverHash) ?? {}) })
    if (next === undefined) {
        store.delete(serverHash)
    } else {
        store.set(serverHash, next)
    }
}

export function deleteMcpOAuthServer(serverHash: string): void {
    getStore().delete(serverHash)
}

export function resetMcpOAuthStore(): void {
    _store = null
}

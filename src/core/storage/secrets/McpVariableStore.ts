/**
 * McpVariableStore — values the user entered for `${env:VAR}` references in MCP
 * server configurations (WS-107).
 *
 * Values are keyed by the server and kept in the scope the server comes from: a
 * server from the global settings file reads and writes the global entry, a
 * workspace descriptor server reads and writes the entry of its own workspace.
 * Workspace server names already carry the workspace root hash, so one file holds
 * both scopes without a value leaking to another server or workspace.
 */
import path from "node:path"
import type { McpServerSource } from "@shared/mcp"
import { ClineFileStorage } from "@shared/storage/ClineFileStorage"
import { getDlineDataDir } from "../disk"

const VARIABLES_FILE = "mcp_variables.json"

/** The server whose values are read or written, in the scope its configuration comes from. */
export interface McpVariableOwner {
    readonly source: McpServerSource
    /** The McpHub connection name; for workspace servers it includes the workspace root hash. */
    readonly serverName: string
}

export interface McpVariableStoreOptions {
    /** Overrides the Dline data directory. Tests use a temporary directory. */
    readonly dataDir?: string
}

export class McpVariableStore {
    private readonly storage: ClineFileStorage<Record<string, string>>

    constructor(options: McpVariableStoreOptions = {}) {
        const dataDir = options.dataDir ?? getDlineDataDir()
        this.storage = new ClineFileStorage<Record<string, string>>(
            path.join(dataDir, "secrets", VARIABLES_FILE),
            "McpVariableStore",
            { fileMode: 0o600 },
        )
    }

    /** Read one saved value from disk, so a value another window saved a moment ago is seen. */
    read(owner: McpVariableOwner, variable: string): string | undefined {
        this.storage.reload()
        return this.storage.get<Record<string, string>>(storageKey(owner))?.[variable]
    }

    async save(owner: McpVariableOwner, variable: string, value: string): Promise<void> {
        this.storage.reload()
        const key = storageKey(owner)
        const current = this.storage.get<Record<string, string>>(key) ?? {}
        await this.storage.setBatchAsync({ [key]: { ...current, [variable]: value } })
    }

    /** Forget every value saved for the server in its scope; other servers and scopes are untouched. */
    async clear(owner: McpVariableOwner): Promise<void> {
        await this.storage.setBatchAsync({ [storageKey(owner)]: undefined })
    }
}

function storageKey(owner: McpVariableOwner): string {
    return `${owner.source}:${owner.serverName}`
}

let sharedStore: McpVariableStore | undefined

/** The process-wide store used by McpHub. */
export function getMcpVariableStore(): McpVariableStore {
    sharedStore ??= new McpVariableStore()
    return sharedStore
}

/** For tests: drop the shared instance so the next call reads the current data directory. */
export function resetMcpVariableStore(): void {
    sharedStore = undefined
}

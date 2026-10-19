import crypto from "node:crypto"
import fsSync from "node:fs"
import path from "node:path"
import { getDlineDataDir, getDlineDocumentsPathSync, warmupDocumentsPathCache } from "@core/storage/disk"
import { ClineFileStorage } from "./ClineFileStorage"
import { ClineMemento } from "./ClineStorage"

/**
 * The storage backend context object used by StateManager and other components.
 * Global, workspace and secret key-value storage goes through this component.
 *
 * This replaces the previous pattern of passing VSCode's ExtensionContext around
 * for storage access. All platforms (VSCode, CLI, JetBrains) use the same
 * file-backed implementation.
 */
export interface StorageContext {
    /** Global state — settings, task history references, UI state, etc. */
    readonly globalState: ClineMemento

    // TODO: Privatize this field after StorageContext becomes class with a reset method.
    /**
     * The backing store for global state. Prefer `globalState` when possible.
     *
     * This split exists because CLI needs to intercept the ClineMemento interface to global state,
     * but state resets need to write through to the backing store.
     */
    readonly globalStateBackingStore: ClineFileStorage

    /** Settings — user preferences, mode, auto-approval, browser settings, etc. Stored in settings/settings.json */
    readonly settings: ClineFileStorage

    /** Backing store for settings. Prefer `settings` when possible. */
    readonly settingsBackingStore: ClineFileStorage

    /** Absolute path of the canonical settings document used by SettingsRepository. */
    readonly settingsFilePath: string

    /**
     * Absolute path of the workspace-scoped settings document.
     *
     * Workspace preferences use their own SettingsRepository document rather than
     * `workspaceState.json`, so a workspace-level write is committed with the same
     * strong consistency as global settings instead of the delayed batch used for
     * workspace state.
     */
    readonly workspaceSettingsFilePath: string

    /** Secrets — API keys and other sensitive values. File uses restricted permissions (0o600). */
    readonly secrets: ClineFileStorage<string>

    /** Workspace-scoped state — per-project toggles, rules, etc. */
    readonly workspaceState: ClineFileStorage

    /** The resolved path to the data directory (~/.dline/data) */
    readonly dataDir: string

    /** The resolved path to the workspace storage directory (contains workspaceState.json) */
    readonly workspaceStoragePath: string

    /** Stable, non-sensitive identity derived from the resolved workspace storage boundary. */
    readonly workspaceId: string

    /** The legacy task history JSONL path, kept only for the one-time import. */
    readonly taskHistoryPath: string

    /** The task history database owned by this storage boundary. */
    readonly taskHistoryDatabasePath: string
}

export interface StorageContextOptions {
    /**
     * Override the Dline home directory. Defaults to DLINE_DIR env var or ~/.dline.
     */
    clineDir?: string

    /**
     * The workspace/project directory path. Used to compute a hash-based
     * workspace storage subdirectory. Defaults to process.cwd().
     */
    workspacePath?: string

    /**
     * Explicit workspace storage directory override.
     * When set, this path is used directly instead of computing a hash.
     * Used by JetBrains (via WORKSPACE_STORAGE_DIR env var).
     *
     * TODO: Unify JetBrains workspace path scheme with the hash-based approach
     * once the JetBrains client side is cleaned up.
     */
    workspaceStorageDir?: string
}

const SETTINGS_SUBFOLDER = "data"
const LEGACY_TASK_HISTORY_FILENAME = "taskHistory.jsonl"
const TASK_HISTORY_DATABASE_FILENAME = "taskHistory.db"

/**
 * Create a short deterministic hash of a string for use in directory names.
 * Produces an up-to-8-character hex string.
 */
function hashString(str: string): string {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i)
        hash = (hash << 5) - hash + char
        hash = hash & hash // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16).substring(0, 8)
}

/** Derive a stable, non-sensitive identity from the resolved workspace storage boundary. */
export function createWorkspaceId(workspaceStoragePath: string): string {
    const isWindowsPath = /^[a-zA-Z]:[\\/]/.test(workspaceStoragePath) || workspaceStoragePath.includes("\\")
    const normalizedPath = isWindowsPath
        ? workspaceStoragePath.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
        : path.resolve(workspaceStoragePath).replace(/\/+$/, "")
    const identifier = crypto.createHash("sha256").update(normalizedPath, "utf8").digest("hex").slice(0, 32)
    return `dline_workspace_${identifier}`
}

/**
 * Create the StorageContext a host process starts with.
 *
 * The task history paths are fixed when the context is created, so the platform
 * Documents directory must be resolved first. Creating the context before that
 * silently resolves `~/Documents`, which differs from a relocated Documents
 * folder and splits the history index from the task directories. Host entry
 * points must use this factory instead of calling `createStorageContext()`
 * directly.
 *
 * @param opts Configuration options for path resolution
 * @returns A StorageContext whose paths use the resolved Documents root
 */
export async function createHostStorageContext(opts: StorageContextOptions = {}): Promise<StorageContext> {
    await warmupDocumentsPathCache()
    return createStorageContext(opts)
}

/**
 * Creates a StorageContext backed by JSON files on disk.
 *
 * All path computation is contained here — callers should not
 * construct paths to these storage files themselves.
 *
 * File layout:
 *   ~/.dline/data/globalState.json    — global state
 *   ~/.dline/data/secrets.json        — secrets (mode 0o600)
 *   ~/.dline/data/workspaces/<hash>/workspaceState.json — per-workspace state
 *
 * @param opts Configuration options for path resolution
 * @returns A StorageContext ready for use by StateManager
 */
export function createStorageContext(opts: StorageContextOptions = {}): StorageContext {
    // Use unified getDlineDataDir() which respects DLINE_DIR → ~/.dline
    const dataDir = opts.clineDir ? path.join(opts.clineDir, SETTINGS_SUBFOLDER) : getDlineDataDir()

    // Resolve workspace storage directory
    let workspaceDir: string
    if (opts.workspaceStorageDir) {
        // Explicit override (JetBrains via env var, or test overrides)
        workspaceDir = opts.workspaceStorageDir
    } else {
        // Hash-based workspace isolation (CLI, VSCode)
        const workspacePath = opts.workspacePath || process.cwd()
        const workspaceHash = hashString(workspacePath)
        workspaceDir = path.join(dataDir, "workspaces", workspaceHash)
    }

    // Ensure directories exist
    fsSync.mkdirSync(dataDir, { recursive: true })
    fsSync.mkdirSync(workspaceDir, { recursive: true })

    const settingsDir = path.join(dataDir, "settings")
    fsSync.mkdirSync(settingsDir, { recursive: true })
    const settingsFilePath = path.join(settingsDir, "settings.json")
    const settings = new ClineFileStorage(settingsFilePath, "Settings")
    const workspaceSettingsFilePath = path.join(workspaceDir, "settings.json")

    const globalState = new ClineFileStorage(path.join(dataDir, "globalState.json"), "GlobalState")
    const taskRoot = opts.clineDir ?? getDlineDocumentsPathSync()
    const taskHistoryPath = path.join(taskRoot, "tasks", LEGACY_TASK_HISTORY_FILENAME)
    const taskHistoryDatabasePath = path.join(taskRoot, "tasks", TASK_HISTORY_DATABASE_FILENAME)

    return {
        globalState,
        globalStateBackingStore: globalState,
        settings,
        settingsBackingStore: settings,
        settingsFilePath,
        workspaceSettingsFilePath,
        secrets: new ClineFileStorage<string>(path.join(dataDir, "secrets.json"), "Secrets", {
            fileMode: 0o600, // Owner read/write only — protects API keys
        }),
        workspaceState: new ClineFileStorage(path.join(workspaceDir, "workspaceState.json"), "WorkspaceState"),
        dataDir,
        workspaceStoragePath: workspaceDir,
        workspaceId: createWorkspaceId(workspaceDir),
        taskHistoryPath,
        taskHistoryDatabasePath,
    }
}

import { builtinIgnoreGlobPatterns } from "@core/ignore/IgnoreController"
import type { WorkspaceRoot } from "@shared/multi-root/types"
import * as childProcess from "child_process"
import * as fs from "fs"
import type { FzfResultItem } from "fzf"
import * as path from "path"
import * as readline from "readline"
import { WorkspaceRootManager } from "@/core/workspace"
import { HostProvider } from "@/hosts/host-provider"
import { AMBIENT_RIPGREP_SCOPE, ripgrepThreadArgs, withRipgrepSlot } from "@/services/ripgrep/cpu-budget"
import { createRipgrepIgnoreFile, type RipgrepScanRules } from "@/services/ripgrep/ignore-file"
import {
    ensureWorkspaceWatched,
    resetWorkspaceWatchersForTesting,
    stopWatchingWorkspace,
} from "@/services/search/workspace-enumeration-invalidator"
import { GetOpenTabsRequest } from "@/shared/proto/dline/host/window"
import { SearchWorkspaceItemsRequest, SearchWorkspaceItemsRequest_SearchItemType } from "@/shared/proto/dline/host/workspace"
import { Logger } from "@/shared/services/Logger"
import { getBinaryLocation } from "@/utils/fs"

/**
 * Indicates which backend served a workspace-files search.
 *
 * - `host_index`: served by the host's native file-name index (e.g. JetBrains FilenameIndex).
 * - `ripgrep`:    served by the bundled ripgrep walker (default everywhere).
 */
export type FileSearchSource = "host_index" | "ripgrep"

/** A workspace entry produced by ripgrep enumeration or a host file index. */
export type WorkspaceItem = { path: string; type: "file" | "folder"; label?: string }

// Wrapper function for childProcess.spawn
export type SpawnFunction = typeof childProcess.spawn
export const getSpawnFunction = (): SpawnFunction => childProcess.spawn

/** Thrown when ripgrep fails to spawn or exits non-zero. */
export class RipgrepError extends Error {
    public readonly stderr: string

    constructor(message: string, opts: { stderr?: string } = {}) {
        super(message)
        this.name = "RipgrepError"
        this.stderr = opts.stderr ?? ""
    }
}

export async function executeRipgrepForFiles(
    workspacePath: string,
    limit = 5000,
    /** Workspace scan rules; omitted callers fall back to the built-in floor. */
    scanRules?: RipgrepScanRules,
): Promise<WorkspaceItem[]> {
    const rgPath = await getBinaryLocation("rg")

    const ignoreFile = await createRipgrepIgnoreFile(scanRules)
    try {
        // The picker runs before any task exists, so its cost is charged to the
        // ambient scope. The slot is held until the walk settles, so the budget
        // accounts for the process for as long as it can actually burn cycles.
        return await withRipgrepSlot(AMBIENT_RIPGREP_SCOPE, () =>
            runRipgrepForFiles(rgPath, workspacePath, limit, ignoreFile.args),
        )
    } finally {
        await ignoreFile.dispose()
    }
}

/**
 * Exclusion globs used when no workspace scan rules are available.
 *
 * The rules from {@link createRipgrepIgnoreFile} already carry this floor, so
 * these only cover the case where the caller passed none — without them an
 * unconfigured workspace would walk `node_modules` on every keystroke.
 */
function fallbackExcludeArgs(): string[] {
    return builtinIgnoreGlobPatterns().flatMap((pattern) => ["-g", `!${pattern}`])
}

function runRipgrepForFiles(
    rgPath: string,
    workspacePath: string,
    limit: number,
    ignoreFileArgs: readonly string[],
): Promise<WorkspaceItem[]> {
    return new Promise((resolve, reject) => {
        const args = [
            "--files",
            // Without this ripgrep opens one worker per logical CPU and a single
            // keystroke-triggered walk saturates the machine.
            ...ripgrepThreadArgs(),
            // Hidden entries stay visible because dotfiles are ordinary mention
            // targets; the ignore rules still prune `.git` and friends. Symlinks
            // are deliberately not followed: `--follow` can walk out of the
            // workspace and turns junction-heavy trees into a traversal explosion.
            "--hidden",
            ...(ignoreFileArgs.length > 0 ? ignoreFileArgs : fallbackExcludeArgs()),
        ]

        // Spawn the ripgrep process with the specified arguments
        const rgProcess = getSpawnFunction()(rgPath, args, { cwd: workspacePath })
        const rl = readline.createInterface({ input: rgProcess.stdout })

        // Array to store file results and Set to track unique directories
        const fileResults: { path: string; type: "file" | "folder"; label?: string }[] = []
        const dirSet = new Set<string>()
        let count = 0
        let exitCode: number | null = null

        // Handle each line of output from ripgrep (each line is a file path)
        rl.on("line", (line) => {
            if (count >= limit) {
                rl.close()
                rgProcess.kill()
                return
            }

            // Ripgrep normally emits paths relative to cwd. Keep compatibility with
            // hosts that return an absolute path.
            const relativePath = path.isAbsolute(line) ? path.relative(workspacePath, line) : path.normalize(line)

            // Add file result to array
            fileResults.push({
                path: relativePath,
                type: "file",
                label: path.basename(relativePath),
            })

            // Extract and add parent directories to the set
            let dirPath = path.dirname(relativePath)
            while (dirPath && dirPath !== "." && dirPath !== "/") {
                dirSet.add(dirPath)
                dirPath = path.dirname(dirPath)
            }

            count++
        })

        // Capture any error output from ripgrep
        let errorOutput = ""
        rgProcess.stderr.on("data", (data) => {
            errorOutput += data.toString()
        })

        // On Windows the readline 'close' and the child-process 'exit' events
        // fire in non-deterministic order; await both so we can read exitCode
        // before deciding to resolve or reject.
        let resolveOutputClosed!: () => void
        const outputClosed = new Promise<void>((r) => {
            resolveOutputClosed = r
        })
        let resolveExited!: () => void
        const exited = new Promise<void>((r) => {
            resolveExited = r
        })

        rgProcess.on("exit", (code) => {
            exitCode = code
            resolveExited()
        })
        rl.on("close", () => resolveOutputClosed())

        Promise.all([outputClosed, exited]).then(() => {
            // A non-zero exit with results is normal — we proactively SIGTERM
            // after hitting the limit. Only reject when we have nothing to return.
            if (fileResults.length === 0 && (errorOutput || (exitCode !== null && exitCode !== 0))) {
                reject(
                    new RipgrepError(
                        errorOutput
                            ? `ripgrep exited with code ${exitCode}: ${errorOutput.trim()}`
                            : `ripgrep exited with code ${exitCode}`,
                        { stderr: errorOutput.trim() },
                    ),
                )
                return
            }

            const dirResults = Array.from(dirSet, (dirPath): { path: string; type: "folder"; label?: string } => ({
                path: dirPath,
                type: "folder",
                label: path.basename(dirPath),
            }))
            resolve([...fileResults, ...dirResults])
        })

        rgProcess.on("error", (error) => {
            reject(new RipgrepError(`ripgrep failed to spawn: ${error.message}`))
        })
    })
}

// Get currently active/open files from VSCode tabs using hostbridge
async function getActiveFiles(): Promise<Set<string>> {
    const request = GetOpenTabsRequest.create({})
    const response = await HostProvider.window.getOpenTabs(request)
    return new Set(response.paths)
}

type WorkspaceEnumerationEntry = {
    /** Resolves to the enumeration; shared by every caller that joins in flight. */
    readonly pending: Promise<readonly WorkspaceItem[]>
    /** Set once the enumeration settles successfully. Absent while in flight. */
    completedAt?: number
}

/**
 * How long a completed ripgrep enumeration stays reusable.
 *
 * The `@`-mention picker debounces at 200ms and re-queries on every keystroke,
 * so without reuse a short word costs one full-workspace walk per character.
 *
 * A minute is safe only because the TTL is not what keeps the cache correct:
 * {@link ensureWorkspaceWatched} drops the entry as soon as the workspace gains
 * or loses a path, which is the only kind of change that can invalidate a list
 * of file names. The TTL remains as the backstop for the cases a watcher cannot
 * cover — it failed to start, or the change happened on a network mount that
 * emits no events.
 */
export const WORKSPACE_ENUMERATION_CACHE_TTL_MS = 60_000

/**
 * Upper bound on cached workspaces. Multi-root setups stay small, so this only
 * guards against unbounded growth if roots churn (worktrees, remote reconnects).
 */
const WORKSPACE_ENUMERATION_CACHE_MAX_ENTRIES = 8

const workspaceEnumerationCache = new Map<string, WorkspaceEnumerationEntry>()

/** Test seam: drop all cached enumerations so a case starts from a cold cache. */
export function clearWorkspaceEnumerationCache(): void {
    workspaceEnumerationCache.clear()
    resetWorkspaceWatchersForTesting()
}

/**
 * Drop a root's cached walk after its file set changed.
 *
 * Only completed entries are dropped. An in-flight walk is left alone: it was
 * started before the event and its callers are already awaiting it, so killing
 * the entry would spawn a duplicate `rg` for a walk still running and would not
 * make the result any fresher.
 */
function invalidateEnumeration(workspacePath: string): void {
    const entry = workspaceEnumerationCache.get(workspacePath)
    if (entry?.completedAt !== undefined) {
        workspaceEnumerationCache.delete(workspacePath)
    }
}

function evictExpiredEnumerations(now: number): void {
    for (const [key, entry] of workspaceEnumerationCache) {
        const isInFlight = entry.completedAt === undefined
        if (isInFlight) {
            continue
        }
        if (now - entry.completedAt! > WORKSPACE_ENUMERATION_CACHE_TTL_MS) {
            workspaceEnumerationCache.delete(key)
        }
    }
}

function evictOldestWhenOverCapacity(): void {
    while (workspaceEnumerationCache.size > WORKSPACE_ENUMERATION_CACHE_MAX_ENTRIES) {
        // Map preserves insertion order, so the first completed key is the oldest
        // reusable entry. In-flight entries are never evicted: dropping one would
        // let the next caller spawn a second `rg` for a walk already running.
        const oldestCompletedKey = findOldestCompletedKey()
        if (oldestCompletedKey === undefined) {
            // Every entry is still running. Stay over capacity until they settle.
            return
        }
        workspaceEnumerationCache.delete(oldestCompletedKey)
        // The root is no longer cached, so its watcher has nothing left to
        // invalidate and would otherwise leak for the life of the host.
        void stopWatchingWorkspace(oldestCompletedKey)
    }
}

function findOldestCompletedKey(): string | undefined {
    for (const [key, entry] of workspaceEnumerationCache) {
        if (entry.completedAt !== undefined) {
            return key
        }
    }
    return undefined
}

/**
 * Enumerates the workspace through ripgrep, reusing a recent walk when possible.
 *
 * Concurrent callers for the same workspace join the in-flight promise instead
 * of spawning another `rg` process. Failures are never cached, so the next call
 * retries from scratch.
 */
async function enumerateWorkspaceFiles(workspacePath: string, scanRules?: RipgrepScanRules): Promise<readonly WorkspaceItem[]> {
    const now = Date.now()
    evictExpiredEnumerations(now)

    // Start watching before the first walk so a file created while it runs is
    // still observed. Repeat calls for an already-watched root are a no-op.
    ensureWorkspaceWatched(workspacePath, () => invalidateEnumeration(workspacePath))

    const cached = workspaceEnumerationCache.get(workspacePath)
    if (cached) {
        return cached.pending
    }

    const pending = executeRipgrepForFiles(workspacePath, 5000, scanRules)
    const entry: WorkspaceEnumerationEntry = { pending }
    workspaceEnumerationCache.set(workspacePath, entry)
    evictOldestWhenOverCapacity()

    try {
        const items = await pending
        entry.completedAt = Date.now()
        return items
    } catch (error) {
        // A failed walk must not become a sticky empty result.
        if (workspaceEnumerationCache.get(workspacePath) === entry) {
            workspaceEnumerationCache.delete(workspacePath)
        }
        throw error
    }
}

// Maximum number of candidates to ask the host for. The result is filtered &
// ranked by fzf in core, so we want a comfortably wider net than `limit`.
const HOST_INDEX_CANDIDATE_LIMIT = 5000

// gRPC status code 12 — the standalone host returns this when the RPC isn't
// registered (the in-process VS Code stub throws a plain Error, matched on
// message instead). Treat both as silent steady-state, not failure.
const GRPC_STATUS_UNIMPLEMENTED = 12

/**
 * Returns candidates from the host's native index, or `null` when the host
 * doesn't implement the RPC / the index is unavailable. Returning `[]` is
 * authoritative — caller does not fall back to ripgrep.
 */
async function executeHostIndexForFiles(
    query: string,
    workspacePath: string,
    selectedType?: "file" | "folder",
): Promise<{ path: string; type: "file" | "folder"; label?: string }[] | null> {
    try {
        const req = SearchWorkspaceItemsRequest.create({
            query,
            workspacePath,
            limit: HOST_INDEX_CANDIDATE_LIMIT,
            selectedType:
                selectedType === "file"
                    ? SearchWorkspaceItemsRequest_SearchItemType.FILE
                    : selectedType === "folder"
                      ? SearchWorkspaceItemsRequest_SearchItemType.FOLDER
                      : undefined,
        })
        const resp = await HostProvider.workspace.searchWorkspaceItems(req)

        // Pre-pass: collect host-provided folder paths so the parent-walk below
        // doesn't re-add them as inferred parents and double-list them.
        const folderPaths = new Set<string>()
        for (const item of resp.items) {
            if (item.type === SearchWorkspaceItemsRequest_SearchItemType.FOLDER) {
                folderPaths.add(item.path)
            }
        }

        const fileResults: { path: string; type: "file" | "folder"; label?: string }[] = []
        const dirSet = new Set<string>()
        for (const item of resp.items) {
            const isFolder = item.type === SearchWorkspaceItemsRequest_SearchItemType.FOLDER
            fileResults.push({
                path: item.path,
                type: isFolder ? "folder" : "file",
                label: item.label || path.basename(item.path),
            })
            if (!isFolder) {
                let dirPath = path.dirname(item.path)
                while (dirPath && dirPath !== "." && dirPath !== "/") {
                    if (!folderPaths.has(dirPath)) {
                        dirSet.add(dirPath)
                    }
                    dirPath = path.dirname(dirPath)
                }
            }
        }
        const dirResults = Array.from(dirSet, (dirPath): { path: string; type: "folder"; label?: string } => ({
            path: dirPath,
            type: "folder",
            label: path.basename(dirPath),
        }))
        return [...fileResults, ...dirResults]
    } catch (err) {
        // "Unimplemented" is the steady state on VS Code/CLI/ACP — every
        // keystroke trips it — so log at debug to keep the noise floor flat.
        // Anything else (UNAVAILABLE during indexing, INTERNAL, transport
        // errors) is a real degradation we want visible to operators, since
        // the caller is about to silently fall back to a much slower path.
        const code = (err as { code?: unknown } | null)?.code
        const msg = (err as { message?: string } | null)?.message ?? ""
        const isUnimplemented = code === GRPC_STATUS_UNIMPLEMENTED || /not implemented/i.test(msg)
        if (isUnimplemented) {
            Logger.debug("[file-search] host index unimplemented, using ripgrep")
        } else {
            Logger.warn(`[file-search] host index call failed (code=${String(code)}), falling back to ripgrep: ${msg}`)
        }
        return null
    }
}

export type SearchWorkspaceFilesResult = {
    items: { path: string; type: "file" | "folder"; label?: string; workspaceName?: string }[]
    source: FileSearchSource
}

/**
 * Resolves the workspace ignore rules for one root.
 *
 * Injected by the caller because the rules are owned by the controller, while
 * this module stays a stateless service. Returning undefined means the rules
 * are unavailable, not that everything is allowed.
 */
export type ScanRulesProvider = (workspacePath: string) => Promise<RipgrepScanRules | undefined>

/**
 * Resolve the rules for one root, treating a provider failure as "no rules".
 *
 * The picker must keep working when the rules cannot be loaded; ripgrep still
 * honours the repository's own ignore files on its own.
 */
async function resolveScanRules(
    workspacePath: string,
    provider: ScanRulesProvider | undefined,
): Promise<RipgrepScanRules | undefined> {
    if (!provider) {
        return undefined
    }
    try {
        return await provider(workspacePath)
    } catch (error) {
        Logger.warn(`[file-search] failed to resolve ignore rules for ${workspacePath}: ${error}`)
        return undefined
    }
}

export async function searchWorkspaceFiles(
    query: string,
    workspacePath: string,
    limit = 20,
    selectedType?: "file" | "folder",
    workspaceName?: string,
    scanRulesProvider?: ScanRulesProvider,
): Promise<SearchWorkspaceFilesResult> {
    try {
        // Get currently active files and convert to search format
        const activeFilePaths = await getActiveFiles()
        const activeFiles: { path: string; type: "file" | "folder"; label?: string }[] = []

        for (const filePath of activeFilePaths) {
            if (filePath.startsWith(workspacePath + path.sep) || filePath.startsWith(`${workspacePath}/`)) {
                const relativePath = path.relative(workspacePath, filePath)
                const normalizedPath = relativePath.replace(/\\/g, "/")
                activeFiles.push({
                    path: normalizedPath,
                    type: "file",
                    label: path.basename(normalizedPath),
                })
            }
        }

        const hostItems = await executeHostIndexForFiles(query, workspacePath, selectedType)

        // Only the ripgrep walk needs the rules; the host index applies its own.
        const scanRules = hostItems ? undefined : await resolveScanRules(workspacePath, scanRulesProvider)
        const allItems = hostItems ?? (await enumerateWorkspaceFiles(workspacePath, scanRules))
        const source: FileSearchSource = hostItems ? "host_index" : "ripgrep"

        // Combine active files with all items, removing duplicates (like the old WorkspaceTracker)
        const combinedItems = [...activeFiles]
        for (const item of allItems) {
            if (!activeFiles.some((activeFile) => activeFile.path === item.path)) {
                combinedItems.push(item)
            }
        }

        // If no query, return the combined items
        if (!query.trim()) {
            const addWorkspaceName = (items: typeof combinedItems) =>
                workspaceName ? items.map((item) => ({ ...item, workspaceName })) : items

            let items: SearchWorkspaceFilesResult["items"]
            if (selectedType === "file") {
                items = addWorkspaceName(combinedItems.filter((item) => item.type === "file").slice(0, limit))
            } else if (selectedType === "folder") {
                items = addWorkspaceName(combinedItems.filter((item) => item.type === "folder").slice(0, limit))
            } else {
                items = addWorkspaceName(combinedItems.slice(0, limit))
            }
            return { items, source }
        }

        // Match Scoring - Prioritize the label (filename) by including it twice in the search string
        // Use multiple tiebreakers in order of importance: Match score, then length of match (shorter=better)
        // Get more (2x) results than needed for filtering, we pick the top half after sorting
        const fzfModule = await import("fzf")
        const fzf = new fzfModule.Fzf(combinedItems, {
            selector: (item: { label?: string; path: string }) => `${item.label || ""} ${item.label || ""} ${item.path}`,
            tiebreakers: [OrderbyMatchScore, fzfModule.byLengthAsc],
            limit: limit * 2,
        })

        const filteredResults = fzf.find(query).slice(0, limit)

        // Verify if the path exists and is actually a directory
        const verifiedResultsPromises = filteredResults.map(
            async ({ item }: { item: { path: string; type: "file" | "folder"; label?: string } }) => {
                const fullPath = path.join(workspacePath, item.path)
                let type = item.type

                try {
                    const stats = await fs.promises.lstat(fullPath)
                    type = stats.isDirectory() ? "folder" : "file"
                } catch {
                    // Keep original type if path doesn't exist
                }

                return workspaceName ? { ...item, type, workspaceName } : { ...item, type }
            },
        )

        const items = await Promise.all(verifiedResultsPromises)
        return { items, source }
    } catch (error) {
        // Re-throw so the controller can attach a structured error_reason.
        Logger.error("Error in searchWorkspaceFiles:", error)
        throw error
    }
}

// Custom match scoring for results ordering
// Candidate score tiebreaker - fewer gaps between matched characters scores higher
export const OrderbyMatchScore = (a: FzfResultItem<any>, b: FzfResultItem<any>) => {
    const countGaps = (positions: Iterable<number>) => {
        let gaps = 0,
            prev = Number.NEGATIVE_INFINITY
        for (const pos of positions) {
            if (prev !== Number.NEGATIVE_INFINITY && pos - prev > 1) {
                gaps++
            }
            prev = pos
        }
        return gaps
    }

    return countGaps(a.positions) - countGaps(b.positions)
}

/**
 * Search for files across multiple workspace roots or a specific workspace
 * Similar to searchWorkspaceFiles but supports multiroot workspaces
 */
export async function searchWorkspaceFilesMultiroot(
    query: string,
    workspaceManager: WorkspaceRootManager,
    limit = 20,
    selectedType?: "file" | "folder",
    workspaceHint?: string,
    scanRulesProvider?: ScanRulesProvider,
): Promise<SearchWorkspaceFilesResult> {
    try {
        const workspaceRoots = workspaceManager?.getRoots?.() || []

        if (workspaceRoots.length === 0) {
            return { items: [], source: "ripgrep" }
        }

        let workspacesToSearch: WorkspaceRoot[] = []

        // Search only the user-specified workspace (Ex input: @frontend:/query)
        if (workspaceHint) {
            const targetWorkspace = workspaceRoots.find((root: WorkspaceRoot) => root.name === workspaceHint)
            if (targetWorkspace) {
                workspacesToSearch = [targetWorkspace]
            } else {
                return { items: [], source: "ripgrep" }
            }
        } else {
            // Search all workspaces if no hint provided
            workspacesToSearch = workspaceRoots
        }

        // In a true multi-root search, swallow per-root errors so a single broken
        // root doesn't kill the rest; we still re-throw below if *every* root
        // failed. In single-root mode the throw propagates up unchanged.
        let firstError: unknown
        const searchPromises = workspacesToSearch.map(async (workspace): Promise<SearchWorkspaceFilesResult> => {
            try {
                return await searchWorkspaceFiles(query, workspace.path, limit, selectedType, workspace.name, scanRulesProvider)
            } catch (error) {
                if (!firstError) {
                    firstError = error
                }
                Logger.error(`[searchWorkspaceFilesMultiroot] Error searching workspace ${workspace.name}:`, error)
                return { items: [], source: "ripgrep" }
            }
        })

        // Aggregate per-root results. The combined `source` is `host_index`
        // only if every contributing root reported `host_index`; if any root
        // fell back to ripgrep we report `ripgrep` so telemetry isn't misleading.
        const allResults = await Promise.all(searchPromises)
        let flatResults: SearchWorkspaceFilesResult["items"] = allResults.flatMap((r) => r.items)
        const aggregateSource: FileSearchSource =
            allResults.length > 0 && allResults.every((r) => r.source === "host_index") ? "host_index" : "ripgrep"
        if (workspacesToSearch.length > 1) {
            const pathCounts = new Map<string, number>()
            for (const result of flatResults) {
                pathCounts.set(result.path, (pathCounts.get(result.path) || 0) + 1)
            }

            flatResults = flatResults.map((result) => {
                if (pathCounts.get(result.path)! > 1 && result.workspaceName) {
                    return {
                        ...result,
                        label: `${result.workspaceName}:/${result.path}`,
                    }
                }
                return result
            })
        }

        // Apply fuzzy matching across all results if needed
        if (query.trim() && flatResults.length > limit) {
            const fzfModule = await import("fzf")
            const fzf = new fzfModule.Fzf(flatResults, {
                selector: (item: { label?: string; path: string }) => `${item.label || ""} ${item.label || ""} ${item.path}`,
                tiebreakers: [OrderbyMatchScore, fzfModule.byLengthAsc],
            })
            flatResults = fzf
                .find(query)
                .slice(0, limit)
                .map((result) => result.item)
        } else {
            flatResults = flatResults.slice(0, limit)
        }

        if (firstError && flatResults.length === 0) {
            throw firstError
        }

        return { items: flatResults, source: aggregateSource }
    } catch (error) {
        Logger.error("[searchWorkspaceFilesMultiroot] Error in multiroot search:", error)
        throw error
    }
}

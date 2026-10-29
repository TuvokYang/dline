import { statSync } from "node:fs"
import {
    builtinIgnoreGlobPatterns,
    type IgnoreController,
    readDirectoryAgentGlobPatterns,
    readDirectoryGlobPatterns,
} from "@core/ignore/IgnoreController"
import { workspaceResolver } from "@core/workspace"
import { isDirectory } from "@utils/fs"
import { arePathsEqual } from "@utils/path"
import * as fs from "fs/promises"
import { globby, globbyStream, globbySync, Options } from "globby"
import * as os from "os"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"

/**
 * File metadata returned by listFiles after enhancement.
 */
export interface FileInfo {
    /** Absolute path to the file or directory */
    path: string
    /** File size in bytes (0 for directories) */
    size: number
    /** Last modification time */
    mtime: Date
    /** Whether this entry is a directory */
    isDirectory: boolean
    /** Line count for text files (undefined for directories and binary files) */
    lineCount?: number
}

// Maximum file size in bytes to attempt line counting (1 MB)
const MAX_LINE_COUNT_FILE_SIZE = 1_000_000

/** Optional workspace rules; when absent only the built-in floor applies. */
export interface ListFilesOptions {
    readonly ignoreController?: IgnoreController
    /** Maximum recursive traversal time. The active filesystem walk is cancelled when this expires. */
    readonly timeoutMs?: number
}

// Helper functions
function isRestrictedPath(absolutePath: string): boolean {
    const root = process.platform === "win32" ? path.parse(absolutePath).root : "/"
    const isRoot = arePathsEqual(absolutePath, root)
    if (isRoot) {
        return true
    }

    const homeDir = os.homedir()
    const isHomeDir = arePathsEqual(absolutePath, homeDir)
    if (isHomeDir) {
        return true
    }

    return false
}

function isTargetingHiddenDirectory(absolutePath: string): boolean {
    const dirName = workspaceResolver.getBasename(absolutePath, "Services.glob.isTargetingHiddenDirectory")
    return dirName.startsWith(".")
}

/**
 * Build the exclusion patterns for a recursive listing.
 *
 * The workspace rules come from {@link IgnoreController}, which owns the parsed
 * `.gitignore` / `.agentignore` content. We never enable globby's `gitignore: true`:
 * it reads every nested `.gitignore` upfront, including those inside already ignored
 * directories, which made V8 run out of memory during regex compilation.
 */
async function buildIgnorePatterns(absolutePath: string, ignoreController: IgnoreController | undefined): Promise<string[]> {
    const patterns = new Set(ignoreController ? ignoreController.toGlobPatterns() : builtinIgnoreGlobPatterns())

    // Without a controller the workspace rules are still needed, so read the root
    // file directly; nested files are picked up during traversal either way.
    if (!ignoreController) {
        for (const pattern of await readDirectoryGlobPatterns(absolutePath)) {
            patterns.add(pattern)
        }
    }

    // Hidden directories stay excluded unless the caller explicitly targets one.
    if (!isTargetingHiddenDirectory(absolutePath)) {
        patterns.add("**/.*/**")
    }

    return [...patterns]
}

/**
 * Enrich raw file paths with stat metadata (size, mtime, isDirectory).
 * Uses Promise.allSettled for concurrent stat calls with graceful error handling.
 */
async function enrichWithStat(filePaths: string[]): Promise<FileInfo[]> {
    const results = await Promise.allSettled(
        filePaths.map(async (filePath) => {
            const isDir = filePath.endsWith("/")
            try {
                const stats = await fs.stat(filePath)
                return {
                    path: filePath,
                    size: stats.size,
                    mtime: stats.mtime,
                    isDirectory: isDir || stats.isDirectory(),
                    lineCount: undefined, // populated later if applicable
                } satisfies FileInfo
            } catch {
                // File may have been deleted or is inaccessible
                return {
                    path: filePath,
                    size: 0,
                    mtime: new Date(0),
                    isDirectory: isDir,
                    lineCount: undefined,
                } satisfies FileInfo
            }
        }),
    )

    return results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<FileInfo>).value)
}

/**
 * Count lines in a text file.
 * Skips files larger than MAX_LINE_COUNT_FILE_SIZE and likely binary files.
 */
async function countLines(filePath: string): Promise<number | undefined> {
    try {
        const stats = await fs.stat(filePath)
        // Skip large files and directories
        if (stats.isDirectory() || stats.size > MAX_LINE_COUNT_FILE_SIZE) {
            return undefined
        }
        // Skip files with no content
        if (stats.size === 0) {
            return 0
        }
        const content = await fs.readFile(filePath, "utf8")
        // Check for null bytes (binary indicator) — skip binary files
        if (content.includes("\0")) {
            return undefined
        }
        // Count newlines: files ending with \n have that many lines,
        // files without trailing \n have newline count + 1
        const newlineCount = (content.match(/\n/g) || []).length
        return content.endsWith("\n") || newlineCount === 0 ? newlineCount : newlineCount + 1
    } catch {
        return undefined
    }
}

/**
 * Enrich file entries with line counts for text files.
 * Only runs when showLineCount is true (typically for non-recursive listings).
 * Uses concurrent reads for performance but limits concurrency implicitly
 * via Promise.allSettled on the entire array.
 */
async function enrichWithLineCounts(infos: FileInfo[]): Promise<FileInfo[]> {
    const results = await Promise.allSettled(
        infos.map(async (info) => {
            if (info.isDirectory) {
                return info
            }
            const lineCount = await countLines(info.path)
            return { ...info, lineCount }
        }),
    )
    return results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<FileInfo>).value)
}

export async function listFiles(
    dirPath: string,
    recursive: boolean,
    limit: number,
    options: ListFilesOptions = {},
): Promise<[FileInfo[], boolean]> {
    const absolutePathResult = workspaceResolver.resolveWorkspacePath(dirPath, "", "Services.glob.listFiles")
    const absolutePath = typeof absolutePathResult === "string" ? absolutePathResult : absolutePathResult.absolutePath

    // Do not allow listing files in root or home directory
    if (isRestrictedPath(absolutePath)) {
        return [[], false]
    }

    // globby requires cwd to point to a directory
    if (!(await isDirectory(absolutePath))) {
        return [[], false]
    }

    const globbyOptions: Options = {
        cwd: absolutePath,
        dot: true, // do not ignore hidden files/directories
        absolute: true,
        markDirectories: true, // Append a / on any directories matched
        gitignore: false, // Workspace rules come from IgnoreController, not globby's upfront scan
        ignore: recursive ? await buildIgnorePatterns(absolutePath, options.ignoreController) : undefined,
        onlyFiles: false, // include directories in results
        suppressErrors: true,
    }

    const filePaths = recursive
        ? await globbyLevelByLevel(limit, globbyOptions, options.timeoutMs)
        : (await globby("*", globbyOptions)).slice(0, limit)

    // Enrich all file paths with stat metadata
    let fileInfos = await enrichWithStat(filePaths)

    // Count lines for non-recursive listings (performance: avoid I/O avalanche on deep trees)
    if (!recursive) {
        fileInfos = await enrichWithLineCounts(fileInfos)
    }

    return [fileInfos, filePaths.length >= limit]
}

/**
 * Synchronous, shallow workspace snapshot for provider-critical prompt assembly.
 * It intentionally avoids line counts and the async filesystem pool.
 */
export function listTopLevelFilesSync(dirPath: string, limit: number): [FileInfo[], boolean] {
    const resolved = workspaceResolver.resolveWorkspacePath(dirPath, "", "Services.glob.listTopLevelFilesSync")
    const absolutePath = typeof resolved === "string" ? resolved : resolved.absolutePath
    if (isRestrictedPath(absolutePath)) return [[], false]
    try {
        if (!statSync(absolutePath).isDirectory()) return [[], false]
    } catch {
        return [[], false]
    }
    const paths = globbySync("*", {
        cwd: absolutePath,
        dot: true,
        absolute: true,
        markDirectories: true,
        gitignore: false,
        onlyFiles: false,
        suppressErrors: true,
    }).slice(0, limit)
    const infos = paths.map((filePath): FileInfo => {
        const isDirectory = filePath.endsWith("/")
        try {
            const stats = statSync(filePath)
            return { path: filePath, size: stats.size, mtime: stats.mtime, isDirectory: isDirectory || stats.isDirectory() }
        } catch {
            return { path: filePath, size: 0, mtime: new Date(0), isDirectory }
        }
    })
    return [infos, paths.length >= limit]
}

/*
Breadth-first traversal of directory structure level by level up to a limit:
   - Queue-based approach ensures proper breadth-first traversal
   - Processes directory patterns level by level
   - Captures a representative sample of the directory structure up to the limit
   - Minimizes risk of missing deeply nested files
   - Reads .gitignore files incrementally from each non-ignored directory entered,
     avoiding the OOM crash caused by globby's gitignore:true reading ALL nested
     .gitignore files upfront (including those inside gitignored directories)

- Notes:
   - Relies on globby to mark directories with /
   - Potential for loops if symbolic links reference back to parent (we could use followSymlinks: false but that may not be ideal for some projects and it's pointless if they're not using symlinks wrong)
   - Timeout mechanism prevents infinite loops
*/
async function globbyLevelByLevel(limit: number, options?: Options, timeoutMs = 10_000) {
    const results: Set<string> = new Set()
    const queue: string[] = ["*"]
    const deadline = Date.now() + timeoutMs
    // Rules accumulated so far: the caller's workspace rules, plus the nested
    // `.gitignore` of every directory we actually enter.
    const currentIgnore: string[] = [...((options?.ignore as string[]) ?? [])]

    while (results.size < limit) {
        const pattern = queue.shift()
        if (pattern === undefined) break
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
            Logger.warn("Globbing timed out, returning partial results")
            break
        }
        const { files: filesAtLevel, timedOut } = await collectGlobWithin(
            pattern,
            {
                ...options,
                ignore: currentIgnore,
            },
            limit - results.size,
            remaining,
        )

        for (const file of filesAtLevel) {
            if (results.size >= limit) break
            results.add(file)
            if (file.endsWith("/")) {
                // This directory survived the current rules, so its own ignore files
                // are safe to read and must apply to everything below it. Agent rules
                // are read here too: a nested `.agentignore` is the only place a
                // subtree can state what the agent must not traverse, and the root
                // loader never sees it.
                currentIgnore.push(...(await readDirectoryGlobPatterns(file)))
                currentIgnore.push(...(await readDirectoryAgentGlobPatterns(file)))

                // Queue as a RELATIVE path to cwd so that ignore patterns (like **/tmp/**)
                // are checked against relative entry paths, not absolute ones. Using absolute
                // patterns causes false matches when the project sits under a directory whose
                // name collides with an ignored name (e.g., /tmp on Linux).
                const cwd = options?.cwd?.toString() ?? ""
                // Globs are always POSIX-separated. On Windows `path.relative` returns
                // backslashes, which glob reads as escapes, so a nested directory could
                // never be re-queried and the traversal silently stopped below depth 1.
                const relativeDir = path.relative(cwd, file).split(path.sep).join("/")
                // Parentheses must still be escaped: NextJS route groups such as
                // `(auth)` would otherwise be parsed as glob grouping syntax.
                const escapedDir = relativeDir.replace(/[()]/g, "\\$&")
                queue.push(`${escapedDir}/*`)
            }
        }
        if (timedOut) {
            Logger.warn("Globbing timed out, returning partial results")
            break
        }
    }
    return Array.from(results).slice(0, limit)
}

/** Collect one breadth-first level and destroy its active walk when the budget expires. */
async function collectGlobWithin(
    pattern: string,
    options: Options,
    limit: number,
    timeoutMs: number,
): Promise<{ readonly files: string[]; readonly timedOut: boolean }> {
    const stream = globbyStream(pattern, options) as NodeJS.ReadableStream & {
        destroy(error?: Error): void
        [Symbol.asyncIterator](): AsyncIterator<string>
    }
    const files: string[] = []
    let timedOut = false
    const timer = setTimeout(() => {
        timedOut = true
        stream.destroy(new Error("Globbing timeout"))
    }, timeoutMs)
    try {
        for await (const file of stream) {
            files.push(String(file))
            if (files.length >= limit) {
                stream.destroy()
                break
            }
        }
    } catch (error) {
        if (!timedOut) throw error
    } finally {
        clearTimeout(timer)
    }
    return { files, timedOut }
}

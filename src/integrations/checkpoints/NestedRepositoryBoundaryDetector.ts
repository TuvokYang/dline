import fs from "fs/promises"
import * as path from "path"

/**
 * Filesystem probe for nested repository markers.
 *
 * Extracted as an explicit contract so checkpoint tests can describe a
 * repository layout without creating real Git metadata on disk.
 */
export interface NestedRepositoryProbe {
    /** Whether the directory itself owns a `.git` marker (directory or worktree link file). */
    hasGitMarker(directoryPath: string): Promise<boolean>
}

const filesystemProbe: NestedRepositoryProbe = {
    async hasGitMarker(directoryPath: string): Promise<boolean> {
        try {
            // A linked worktree stores `.git` as a file, a plain clone as a directory.
            await fs.stat(path.join(directoryPath, ".git"))
            return true
        } catch {
            return false
        }
    },
}

interface BoundaryCacheEntry {
    nested: boolean
    expiresAt: number
}

/**
 * Negative results expire because a workspace directory can become a
 * repository root at any time during a task, for example when the agent runs
 * `git worktree add` or `git init` inside the workspace. Positive results do
 * not expire: an existing repository is not expected to stop being one while
 * the owning task is still running.
 */
const NEGATIVE_RESULT_TTL_MS = 30_000

/**
 * Decides whether a workspace file is owned by a nested Git repository.
 *
 * The shadow checkpoint repository must never stage paths that live inside a
 * submodule or a linked worktree: Git records those directories as gitlinks and
 * rejects the whole pathspec batch. Ownership is resolved lazily per file so a
 * repository created after the checkpoint tracker started is still recognised.
 */
export class NestedRepositoryBoundaryDetector {
    private readonly worktreeRoot: string
    private readonly probe: NestedRepositoryProbe
    private readonly cache = new Map<string, BoundaryCacheEntry>()
    private readonly now: () => number

    /**
     * @param worktreeRoot - Absolute path of the shadow repository worktree
     * @param seedBoundaries - Root-relative boundaries already known from the
     *   startup topology scan; used as pre-resolved positive cache entries
     * @param probe - Filesystem probe, injectable for tests
     * @param now - Clock, injectable for tests
     */
    constructor(
        worktreeRoot: string,
        seedBoundaries: string[] = [],
        probe: NestedRepositoryProbe = filesystemProbe,
        now: () => number = Date.now,
    ) {
        this.worktreeRoot = path.resolve(worktreeRoot)
        this.probe = probe
        this.now = now
        this.seed(seedBoundaries)
    }

    /** Register additional root-relative boundaries as known nested repositories. */
    public seed(relativeBoundaries: string[]): void {
        for (const boundary of relativeBoundaries) {
            const absolute = path.resolve(this.worktreeRoot, boundary)
            if (this.isWithinWorktree(absolute)) {
                this.cache.set(this.cacheKey(absolute), { nested: true, expiresAt: Number.POSITIVE_INFINITY })
            }
        }
    }

    /** Whether the file is owned by a nested repository rather than the root worktree. */
    public async isInsideNestedRepository(absoluteFilePath: string): Promise<boolean> {
        return this.resolveDirectory(path.dirname(path.resolve(absoluteFilePath)))
    }

    /**
     * Walk from the file's directory towards the worktree root, stopping at the
     * first cached answer or `.git` marker. The root's own `.git` belongs to the
     * workspace repository and is never treated as a boundary.
     */
    private async resolveDirectory(directory: string): Promise<boolean> {
        const visited: string[] = []
        let cursor = directory
        let nested = false

        while (this.isInsideWorktree(cursor)) {
            const cached = this.readCache(cursor)
            if (cached !== undefined) {
                nested = cached
                break
            }
            visited.push(cursor)
            if (await this.probe.hasGitMarker(cursor)) {
                nested = true
                break
            }
            const parent = path.dirname(cursor)
            if (parent === cursor) {
                break
            }
            cursor = parent
        }

        const expiresAt = nested ? Number.POSITIVE_INFINITY : this.now() + NEGATIVE_RESULT_TTL_MS
        for (const entry of visited) {
            this.cache.set(this.cacheKey(entry), { nested, expiresAt })
        }
        return nested
    }

    private readCache(directory: string): boolean | undefined {
        const entry = this.cache.get(this.cacheKey(directory))
        if (!entry) {
            return undefined
        }
        if (entry.expiresAt <= this.now()) {
            this.cache.delete(this.cacheKey(directory))
            return undefined
        }
        return entry.nested
    }

    /** True for directories strictly below the worktree root. */
    private isInsideWorktree(directory: string): boolean {
        const relative = path.relative(this.worktreeRoot, directory)
        return relative !== "" && !this.escapesWorktree(relative)
    }

    private isWithinWorktree(absolutePath: string): boolean {
        const relative = path.relative(this.worktreeRoot, absolutePath)
        return relative !== "" && !this.escapesWorktree(relative)
    }

    private escapesWorktree(relativePath: string): boolean {
        return relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)
    }

    private cacheKey(directory: string): string {
        return process.platform === "win32" ? directory.toLowerCase() : directory
    }
}

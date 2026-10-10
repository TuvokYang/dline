import fs from "node:fs/promises"
import path from "node:path"

export interface ResolvedCommandWorkdirectory {
    path: string
    isWithinWorkspace: boolean
}

export interface ResolveCommandWorkdirectoryOptions {
    cwd: string
    requestedPath?: string
    workspaceRoots?: readonly string[]
}

/** Resolve and validate the directory used to execute one command. */
export async function resolveCommandWorkdirectory(
    options: ResolveCommandWorkdirectoryOptions,
): Promise<ResolvedCommandWorkdirectory> {
    const requestedPath = options.requestedPath
    if (requestedPath !== undefined && requestedPath.trim().length === 0) {
        throw new Error("execute_command workdirectory cannot be empty")
    }

    const candidate = path.resolve(options.cwd, requestedPath?.trim() || ".")
    let stats: Awaited<ReturnType<typeof fs.stat>>
    try {
        stats = await fs.stat(candidate)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error(`execute_command workdirectory does not exist: ${candidate}`)
        }
        throw new Error(`Unable to access execute_command workdirectory '${candidate}': ${String(error)}`)
    }

    if (!stats.isDirectory()) {
        throw new Error(`execute_command workdirectory is not a directory: ${candidate}`)
    }

    const canonicalPath = await fs.realpath(candidate)
    const roots = options.workspaceRoots?.length ? options.workspaceRoots : [options.cwd]
    const canonicalRoots = await Promise.all(roots.map(canonicalizeRoot))
    return {
        path: canonicalPath,
        isWithinWorkspace: canonicalRoots.some((root) => isPathWithin(root, canonicalPath)),
    }
}

async function canonicalizeRoot(root: string): Promise<string> {
    try {
        return await fs.realpath(path.resolve(root))
    } catch {
        return path.resolve(root)
    }
}

function isPathWithin(root: string, candidate: string): boolean {
    const relativePath = path.relative(root, candidate)
    return (
        relativePath === "" ||
        (!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath))
    )
}

import { constants as fsConstants } from "node:fs"
import { access, readdir } from "node:fs/promises"
import * as path from "node:path"

/** Common CLI tools that developers frequently use. */
const CLI_TOOLS = [
    "gh",
    "git",
    "docker",
    "podman",
    "kubectl",
    "aws",
    "gcloud",
    "az",
    "terraform",
    "pulumi",
    "npm",
    "yarn",
    "pnpm",
    "pip",
    "cargo",
    "go",
    "curl",
    "jq",
    "make",
    "cmake",
    "python",
    "node",
    "psql",
    "mysql",
    "redis-cli",
    "sqlite3",
    "mongosh",
    "code",
    "grep",
    "sed",
    "awk",
    "brew",
    "apt",
    "yum",
    "gradle",
    "mvn",
    "bundle",
    "dotnet",
    "helm",
    "ansible",
    "wget",
] as const

interface DirectorySnapshot {
    readonly directory: string
    readonly entries: ReadonlySet<string>
}

interface DetectionCache {
    readonly signature: string
    readonly result: Promise<readonly string[]>
}

let detectionCache: DetectionCache | undefined

function readEnvironmentValue(name: string): string {
    const directValue = process.env[name]
    if (directValue !== undefined) return directValue

    const match = Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase())
    return match?.[1] ?? ""
}

function normalizePathEntries(pathValue: string): string[] {
    const seen = new Set<string>()
    const directories: string[] = []
    for (const rawEntry of pathValue.split(path.delimiter)) {
        const directory = rawEntry.trim().replace(/^"|"$/g, "")
        if (!directory) continue
        const cacheKey = process.platform === "win32" ? directory.toLowerCase() : directory
        if (seen.has(cacheKey)) continue
        seen.add(cacheKey)
        directories.push(directory)
    }
    return directories
}

async function readDirectorySnapshot(directory: string): Promise<DirectorySnapshot> {
    try {
        const names = await readdir(directory)
        return {
            directory,
            entries: new Set(names.map((name) => (process.platform === "win32" ? name.toLowerCase() : name))),
        }
    } catch {
        return { directory, entries: new Set() }
    }
}

function windowsExecutableNames(command: string, pathExtValue: string): string[] {
    const extensions = (pathExtValue || ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((extension) => extension.trim().toLowerCase())
        .filter(Boolean)
    return [command, ...extensions.map((extension) => `${command}${extension}`)]
}

async function isUnixExecutable(filePath: string): Promise<boolean> {
    try {
        await access(filePath, fsConstants.X_OK)
        return true
    } catch {
        return false
    }
}

async function detectFromPath(pathValue: string, pathExtValue: string): Promise<readonly string[]> {
    const snapshots = await Promise.all(normalizePathEntries(pathValue).map(readDirectorySnapshot))
    if (process.platform === "win32") {
        return CLI_TOOLS.filter((command) => {
            const candidateNames = windowsExecutableNames(command, pathExtValue)
            return snapshots.some((snapshot) => candidateNames.some((candidate) => snapshot.entries.has(candidate)))
        })
    }

    const availability = await Promise.all(
        CLI_TOOLS.map(async (command) => {
            const candidates = snapshots
                .filter((snapshot) => snapshot.entries.has(command))
                .map((snapshot) => path.join(snapshot.directory, command))
            const executable = await Promise.all(candidates.map(isUnixExecutable))
            return executable.some(Boolean)
        }),
    )
    return CLI_TOOLS.filter((_command, index) => availability[index])
}

/**
 * Detect CLI tools from PATH without spawning synchronous lookup processes.
 * Results are cached until PATH or PATHEXT changes.
 */
export async function detectAvailableCliTools(): Promise<string[]> {
    const pathValue = readEnvironmentValue("PATH")
    const pathExtValue = readEnvironmentValue("PATHEXT")
    const signature = `${process.platform}\u0000${pathValue}\u0000${pathExtValue}`
    if (!detectionCache || detectionCache.signature !== signature) {
        detectionCache = {
            signature,
            result: detectFromPath(pathValue, pathExtValue),
        }
    }
    return [...(await detectionCache.result)]
}

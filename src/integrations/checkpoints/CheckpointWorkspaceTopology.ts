import fs from "fs/promises"
import { globby } from "globby"
import * as path from "path"
import { simpleGit } from "simple-git"
import { getExcludedDirectoryGlobs } from "./CheckpointExclusions"

export type WorkspaceRepositoryRelation = "none" | "workspace" | "ancestor"
export type RepositoryHeadState = "absent" | "unborn" | "committed"

export interface WorkspaceRepositoryState {
    relation: WorkspaceRepositoryRelation
    head: RepositoryHeadState
}

export interface CheckpointRepositoryBoundary {
    relativePath: string
    kind: "submodule" | "nested_repo"
    initialized: boolean
    head: RepositoryHeadState
}

export interface CheckpointWorkspaceTopology {
    fileCheckpointsAvailable: true
    repository: WorkspaceRepositoryState
    boundaries: CheckpointRepositoryBoundary[]
    exclusionPatterns: string[]
}

export interface CheckpointTopologyProbe {
    inspectRepository(workspacePath: string): Promise<WorkspaceRepositoryState>
    findGitMarkers(workspacePath: string): Promise<string[]>
    readGitmodules(workspacePath: string): Promise<string | undefined>
    inspectBoundaryHead(workspacePath: string, relativePath: string): Promise<RepositoryHeadState>
}

function normalizeRelativePath(relativePath: string): string {
    return relativePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "")
}

function parseSubmodulePaths(content: string | undefined): string[] {
    if (!content) {
        return []
    }
    const paths: string[] = []
    for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^\s*path\s*=\s*(.+?)\s*$/)
        if (match?.[1]) {
            paths.push(normalizeRelativePath(match[1]))
        }
    }
    return paths
}

function markerParent(markerPath: string): string {
    return normalizeRelativePath(path.posix.dirname(normalizeRelativePath(markerPath)))
}

function toExclusionPattern(relativePath: string): string {
    return `/${normalizeRelativePath(relativePath)}/`
}

export async function detectCheckpointWorkspaceTopology(
    workspacePath: string,
    probe: CheckpointTopologyProbe = createCheckpointTopologyProbe(),
): Promise<CheckpointWorkspaceTopology> {
    const repository = await probe.inspectRepository(workspacePath)
    const markerPaths = new Set((await probe.findGitMarkers(workspacePath)).map(markerParent))
    const submodulePaths = parseSubmodulePaths(await probe.readGitmodules(workspacePath))
    const submodulePathSet = new Set(submodulePaths)
    const boundaryPaths = [...new Set([...submodulePaths, ...markerPaths])].sort((left, right) => left.localeCompare(right))
    const boundaries: CheckpointRepositoryBoundary[] = []

    for (const relativePath of boundaryPaths) {
        const initialized = markerPaths.has(relativePath)
        boundaries.push({
            relativePath,
            kind: submodulePathSet.has(relativePath) ? "submodule" : "nested_repo",
            initialized,
            head: initialized ? await probe.inspectBoundaryHead(workspacePath, relativePath) : "absent",
        })
    }

    return {
        fileCheckpointsAvailable: true,
        repository,
        boundaries,
        exclusionPatterns: boundaries.map((boundary) => toExclusionPattern(boundary.relativePath)),
    }
}

export function createCheckpointTopologyProbe(): CheckpointTopologyProbe {
    return {
        async inspectRepository(workspacePath): Promise<WorkspaceRepositoryState> {
            const git = simpleGit(workspacePath)
            let repositoryRoot: string
            try {
                repositoryRoot = (await git.revparse(["--show-toplevel"])).trim()
            } catch {
                return { relation: "none", head: "absent" }
            }
            const relation = path.resolve(repositoryRoot) === path.resolve(workspacePath) ? "workspace" : "ancestor"
            try {
                await git.revparse(["--verify", "HEAD"])
                return { relation, head: "committed" }
            } catch {
                return { relation, head: "unborn" }
            }
        },
        async findGitMarkers(workspacePath): Promise<string[]> {
            return await globby("**/.git", {
                cwd: workspacePath,
                onlyFiles: false,
                ignore: [".git", ...getExcludedDirectoryGlobs()],
                dot: true,
                markDirectories: false,
                suppressErrors: true,
            })
        },
        async readGitmodules(workspacePath): Promise<string | undefined> {
            try {
                return await fs.readFile(path.join(workspacePath, ".gitmodules"), "utf8")
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                    return undefined
                }
                throw error
            }
        },
        async inspectBoundaryHead(workspacePath, relativePath): Promise<RepositoryHeadState> {
            try {
                await simpleGit(path.join(workspacePath, relativePath)).revparse(["--verify", "HEAD"])
                return "committed"
            } catch {
                return "unborn"
            }
        },
    }
}

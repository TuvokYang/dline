import { getDlineDocumentsPathSync } from "@core/storage/disk"
import path from "path"
import { ArtifactResolver, type ArtifactResolverOptions } from "./ArtifactResolver"
import { SecureArtifactUrlDownloader } from "./SecureArtifactUrlDownloader"
import { ArtifactStoreError, TaskArtifactStore } from "./TaskArtifactStore"
import { TaskImagePreviewStore } from "./TaskImagePreviewStore"

const TASK_READ_SCOPE_DIRECTORIES = ["artifacts", "tmp"] as const

function isPathWithin(rootPath: string, candidatePath: string): boolean {
    const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath))
    return (
        relativePath === "" ||
        (!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath))
    )
}

export function getTaskArtifactDirectory(taskId: string): string {
    return path.join(getDlineDocumentsPathSync(), "tasks", taskId)
}

/** Return whether an absolute path belongs to the current task's readable artifact or temporary storage. */
export function isTaskReadScopePath(taskId: string, absolutePath: string): boolean {
    if (!path.isAbsolute(absolutePath)) return false
    const taskDirectory = getTaskArtifactDirectory(taskId)
    return TASK_READ_SCOPE_DIRECTORIES.some((directory) => isPathWithin(path.join(taskDirectory, directory), absolutePath))
}

/** Resolve a manifest-relative artifact path without allowing it to escape the current task's artifact root. */
export function resolveTaskArtifactPath(taskId: string, artifactRelativePath: string): string {
    const artifactRoot = path.join(getTaskArtifactDirectory(taskId), "artifacts")
    const absolutePath = path.resolve(artifactRoot, ...artifactRelativePath.split("/"))
    if (!isPathWithin(artifactRoot, absolutePath)) {
        throw new ArtifactStoreError("artifact_integrity_failed", "Image artifact path escapes the task artifact root.")
    }
    return absolutePath
}

export function createTaskArtifactStore(taskId: string): TaskArtifactStore {
    return new TaskArtifactStore({ taskDirectory: getTaskArtifactDirectory(taskId), taskId })
}

export function createTaskImagePreviewStore(taskId: string): TaskImagePreviewStore {
    return new TaskImagePreviewStore(getTaskArtifactDirectory(taskId))
}

export function createTaskArtifactResolver(taskId: string, options: ArtifactResolverOptions = {}): ArtifactResolver {
    return new ArtifactResolver(createTaskArtifactStore(taskId), {
        ...options,
        urlDownloader: options.urlDownloader ?? new SecureArtifactUrlDownloader(),
    })
}

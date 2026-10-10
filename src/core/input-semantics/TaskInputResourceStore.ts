import { createHash, randomUUID } from "node:crypto"
import * as fsPromises from "node:fs/promises"
import * as path from "node:path"
import { getTaskTempSectionDirectory, resolveTaskTempFilePath, TaskTempSection } from "@core/storage/task-temp"
import { countTextLines, countUtf8Bytes } from "@shared/input-semantics/resource-policy"

/** Where one input resource came from, so the UI can label it truthfully. */
export type InputResourceOrigin = "pasted_text" | "pasted_file" | "uploaded_file"

/**
 * One task-owned input resource.
 *
 * The record is the authority for ownership and content identity. A semantic
 * input document only carries `resourceId` plus the frozen `contentHash`, so a
 * later edit of the same file cannot silently change an already confirmed input.
 */
export interface TaskInputResourceRecord {
    readonly resourceId: string
    readonly ownerTaskId: string
    readonly absolutePath: string
    readonly displayName: string
    readonly origin: InputResourceOrigin
    readonly lineCount: number
    readonly byteSize: number
    readonly contentHash: string
}

/** Content identity of a stored resource, enough to prove it is unchanged. */
export type InputResourceBinding = Pick<TaskInputResourceRecord, "absolutePath" | "contentHash">

const FILE_NAME_TIMESTAMP_PATTERN = /[-:.TZ]/g
const RESOURCE_SUFFIX_LENGTH = 8

/**
 * Owns the authoritative copy of the resources one task's input carried.
 *
 * The copy lives in the task's own temp storage, which ties its lifetime to the
 * task and already lies inside the task read scope, so the agent may open it
 * without a new permission. A pasted block becomes a file here instead of being
 * repeated in every later provider request.
 */
export class TaskInputResourceStore {
    constructor(private readonly taskId: string) {}

    /** Store one pasted block as a task-owned file. */
    async storeText(text: string, extension = "txt"): Promise<TaskInputResourceRecord> {
        const resourceId = randomUUID()
        const fileStem = buildFileStem(resourceId)
        const absolutePath = resolveTaskTempFilePath(this.taskId, TaskTempSection.InputResources, fileStem, extension)
        await fsPromises.writeFile(absolutePath, text, "utf8")

        return {
            resourceId,
            ownerTaskId: this.taskId,
            absolutePath,
            displayName: `${fileStem}.${extension}`,
            origin: "pasted_text",
            lineCount: countTextLines(text),
            byteSize: countUtf8Bytes(text),
            contentHash: hashText(text),
        }
    }

    /** Read a stored resource back, or report undefined when it no longer matches its binding. */
    async readText(binding: InputResourceBinding): Promise<string | undefined> {
        if (!this.owns(binding.absolutePath)) return undefined
        const text = await fsPromises.readFile(binding.absolutePath, "utf8").catch(() => undefined)
        if (text === undefined) return undefined
        return hashText(text) === binding.contentHash ? text : undefined
    }

    /** Return whether the path is one of this task's input resources. */
    owns(absolutePath: string): boolean {
        if (!path.isAbsolute(absolutePath)) return false
        const sectionDirectory = getTaskTempSectionDirectory(this.taskId, TaskTempSection.InputResources)
        return path.dirname(path.resolve(absolutePath)) === path.resolve(sectionDirectory)
    }

    /**
     * Copy one resource from another task into this task.
     *
     * `/newtask` hands work to a task that outlives the original, so the new task
     * needs its own copy rather than a reference into a directory that may be
     * deleted. The copy gets a new identity, and a failed verification removes the
     * partial file so the new task never consumes half a resource.
     */
    async adopt(source: TaskInputResourceRecord): Promise<TaskInputResourceRecord> {
        const resourceId = randomUUID()
        const extension = extensionOf(source.displayName)
        const fileStem = buildFileStem(resourceId)
        const absolutePath = resolveTaskTempFilePath(this.taskId, TaskTempSection.InputResources, fileStem, extension)

        try {
            await fsPromises.copyFile(source.absolutePath, absolutePath)
            const copied = await fsPromises.readFile(absolutePath)
            assertCopyMatches(source, copied)

            return {
                ...source,
                resourceId,
                ownerTaskId: this.taskId,
                absolutePath,
                displayName: `${fileStem}.${extension}`,
            }
        } catch (error) {
            await fsPromises.unlink(absolutePath).catch(() => undefined)
            throw new Error(`Failed to adopt input resource ${source.resourceId}`, { cause: error })
        }
    }
}

function assertCopyMatches(source: TaskInputResourceRecord, copied: Buffer): void {
    if (copied.byteLength !== source.byteSize) {
        throw new Error(`Adopted resource size differs: expected ${source.byteSize}, got ${copied.byteLength}`)
    }
    const copiedHash = createHash("sha256").update(copied).digest("hex")
    if (copiedHash !== source.contentHash) {
        throw new Error(`Adopted resource content differs from ${source.resourceId}`)
    }
}

/**
 * Build a readable, collision-free file stem.
 *
 * The timestamp makes the file recognizable in an editor tab, and the resource
 * suffix keeps two pastes within the same millisecond apart.
 */
function buildFileStem(resourceId: string): string {
    const timestamp = new Date().toISOString().replace(FILE_NAME_TIMESTAMP_PATTERN, "").slice(0, 14)
    return `input_${timestamp}_${resourceId.replace(/-/g, "").slice(0, RESOURCE_SUFFIX_LENGTH)}`
}

function extensionOf(displayName: string): string {
    const extension = path.extname(displayName).replace(".", "")
    return extension.length > 0 ? extension : "txt"
}

function hashText(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex")
}

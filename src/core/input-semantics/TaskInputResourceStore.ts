import { createHash, randomUUID } from "node:crypto"
import * as fsPromises from "node:fs/promises"
import { resolveTaskTempFilePath, TaskTempSection } from "@core/storage/task-temp"
import { countTextLines } from "@shared/input-semantics/resource-policy"

export interface StoredInputResource {
	/** Stable identity the input document references. */
	readonly resourceId: string
	readonly absolutePath: string
	readonly displayName: string
	readonly lineCount: number
	/** Hash of the stored bytes, so a later read can prove it is the same content. */
	readonly contentHash: string
}

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
	async storeText(text: string, extension = "txt"): Promise<StoredInputResource> {
		const resourceId = randomUUID()
		const absolutePath = resolveTaskTempFilePath(this.taskId, TaskTempSection.InputResources, resourceId, extension)
		await fsPromises.writeFile(absolutePath, text, "utf8")
		return {
			resourceId,
			absolutePath,
			displayName: `${resourceId}.${extension}`,
			lineCount: countTextLines(text),
			contentHash: createHash("sha256").update(text, "utf8").digest("hex"),
		}
	}

	/** Read a stored resource back and report whether it still matches its binding. */
	async readText(resource: Pick<StoredInputResource, "absolutePath" | "contentHash">): Promise<string | undefined> {
		const text = await fsPromises.readFile(resource.absolutePath, "utf8").catch(() => undefined)
		if (text === undefined) return undefined
		return createHash("sha256").update(text, "utf8").digest("hex") === resource.contentHash ? text : undefined
	}
}

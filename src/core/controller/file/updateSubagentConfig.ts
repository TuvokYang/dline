/** Handler for incremental subagent YAML configuration updates. */
import { FileLock } from "@core/storage/backend/jsonl/FileLock"
import { Empty } from "@shared/proto/dline/common"
import { UpdateSubagentConfigRequest } from "@shared/proto/dline/file"
import { Logger } from "@shared/services/Logger"
import { writeFileAtomic } from "@shared/storage/atomic-file"
import fs from "fs/promises"
import path from "path"
import type { Controller } from ".."
import { patchSubagentConfigDocument, type SubagentConfigPatch } from "./subagent-config-document"

const fileLock = new FileLock()
const pendingWrites = new Map<string, Promise<void>>()

/**
 * Queue by file, not by Controller: sibling RPCs and task panels share the same
 * YAML authority. Failed operations release their turn without poisoning the queue.
 */
async function enqueueWrite(filePath: string, operation: () => Promise<void>): Promise<void> {
    const key = process.platform === "win32" ? filePath.toLowerCase() : filePath
    const previous = pendingWrites.get(key) ?? Promise.resolve()
    let release!: () => void
    const turn = new Promise<void>((resolve) => {
        release = resolve
    })
    pendingWrites.set(key, turn)
    await previous
    try {
        await operation()
    } finally {
        release()
        if (pendingWrites.get(key) === turn) pendingWrites.delete(key)
    }
}

/** Repeated proto defaults carry no intent unless their replace flag is set. */
export async function updateSubagentConfig(controller: Controller, request: UpdateSubagentConfigRequest): Promise<Empty> {
    if (!request.subagentPath) throw new Error("subagentPath is required")
    const subagentPath = path.resolve(request.subagentPath)
    const patch: SubagentConfigPatch = {
        profile: request.profile,
        description: request.description,
        ...(request.replaceTools ? { tools: request.tools } : {}),
        ...(request.replaceSkills ? { skills: request.skills } : {}),
        ...(request.replaceRules ? { rules: request.rules } : {}),
        ...(request.replaceWorkflows ? { workflows: request.workflows } : {}),
        ...(request.replaceMcp ? { mcp: request.mcp } : {}),
    }

    // This RPC is the failure boundary. The pure patcher and storage helpers
    // propagate errors; do not log/rethrow the same failure at each layer.
    try {
        await enqueueWrite(subagentPath, () =>
            fileLock.withLock(subagentPath, async () => {
                const content = await fs.readFile(subagentPath, "utf8")
                const updated = patchSubagentConfigDocument(content, patch)
                await writeFileAtomic(subagentPath, updated)
            }),
        )
    } catch (error) {
        throw new Error(`Failed to update subagent config: ${subagentPath}`, { cause: error })
    }

    Logger.log(`[updateSubagentConfig] Updated subagent config: ${subagentPath}`)
    if (controller.task) {
        await controller.task.owners.prompt.flush("capability_mutation")
    } else {
        await controller.postStateToWebview()
    }
    return Empty.create({})
}

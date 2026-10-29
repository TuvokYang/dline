import type { UiMessage } from "@shared/ExtensionMessage"

/**
 * The restore point a round writes before its request. Legacy rows carry no
 * source. Pre-edit and pre-compaction restore points belong to the change they
 * precede, so they are never folded with a round.
 */
export function isRoundStartCheckpoint(message: UiMessage): boolean {
    if (message.say !== "checkpoint_created") return false
    return message.checkpointSource === undefined || message.checkpointSource.kind === "round_start"
}

/** Whether two restore points bring back the same workspace files. */
export function restoresSameFiles(left: UiMessage, right: UiMessage): boolean {
    const leftHashes = left.lastCheckpointHash ?? []
    const rightHashes = right.lastCheckpointHash ?? []
    return leftHashes.length === rightHashes.length && leftHashes.every((hash, index) => hash === rightHashes[index])
}

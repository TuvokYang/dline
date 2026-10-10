import * as path from "path"
import { releaseFolderLock, tryAcquireFolderLockWithRetry } from "@/core/locks/FolderLockUtils"
import type { FolderLockOptions, FolderLockWithRetryResult } from "@/core/locks/types"
import { getDlineCheckpointsDir } from "@/core/storage/disk"

/**
 * Resolve the absolute checkpoint directory for the given workspace hash.
 *
 * Uses the shared Dline storage utility so the lock target always matches
 * the actual shadow git directory used by CheckpointTracker.
 *
 * @param cwdHash - The hash of the working directory
 * @returns Absolute path to the checkpoint directory for this workspace
 */
async function resolveCheckpointDir(cwdHash: string): Promise<string> {
    const baseDir = await getDlineCheckpointsDir()
    return path.join(baseDir, cwdHash)
}

/**
 * Attempt to acquire checkpoint folder lock with retry logic.
 * This is a convenience wrapper around the generic folder lock utility
 * that automatically derives the correct folder path from the cwdHash.
 *
 * @param cwdHash - The hash of the working directory
 * @param taskId - The task ID (swapped to instance address in SqliteLockManager)
 * @returns Promise<FolderLockWithRetryResult> with acquisition status and any conflicting lock info
 */
export async function tryAcquireCheckpointLockWithRetry(cwdHash: string, taskId: string): Promise<FolderLockWithRetryResult> {
    const lockTarget = await resolveCheckpointDir(cwdHash)
    const options: FolderLockOptions = {
        lockTarget,
        heldBy: taskId,
    }

    const result = await tryAcquireFolderLockWithRetry(options)
    return { acquired: result.acquired, skipped: result.skipped, conflictingLock: result.conflictingLock }
}

/**
 * Release checkpoint folder lock safely.
 * This is a convenience wrapper around the generic folder lock utility
 * that automatically derives the correct folder path from the cwdHash.
 *
 * @param cwdHash - The hash of the working directory
 */
export async function releaseCheckpointLock(cwdHash: string, taskId: string): Promise<void> {
    const lockTarget = await resolveCheckpointDir(cwdHash)
    await releaseFolderLock(taskId, lockTarget)
}

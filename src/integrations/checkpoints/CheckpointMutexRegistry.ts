import Mutex from "p-mutex"
import { Logger } from "@/shared/services/Logger"

/**
 * CheckpointMutexRegistry — Process-Level Mutex Manager
 *
 * Manages a pool of Mutex instances keyed by cwdHash. All checkpoint
 * operations that access the same shadow git repository (identified by
 * cwdHash) are serialized through the same Mutex, preventing race
 * conditions when multiple Tasks (e.g. parent + spawned children) or
 * multiple VS Code windows operate on the same workspace concurrently.
 *
 * Lifecycle:
 * - Mutexes are created lazily on first access for a given cwdHash.
 * - They live for the lifetime of the process (no explicit cleanup).
 *
 * Thread-safety:
 * - p-mutex is Promise-based and serializes async operations within
 *   the Node.js event loop; no additional synchronization is needed.
 */
export class CheckpointMutexRegistry {
    private static instance: CheckpointMutexRegistry

    /** Map from cwdHash to its dedicated Mutex */
    private mutexes = new Map<string, Mutex>()

    private constructor() {
        Logger.info("[CheckpointMutexRegistry] Initialized")
    }

    /**
     * Get the global singleton instance.
     */
    static getInstance(): CheckpointMutexRegistry {
        if (!CheckpointMutexRegistry.instance) {
            CheckpointMutexRegistry.instance = new CheckpointMutexRegistry()
        }
        return CheckpointMutexRegistry.instance
    }

    /**
     * Execute a function under the mutex for the given cwdHash.
     *
     * If no mutex exists for this cwdHash, one is created lazily.
     * All callers sharing the same cwdHash are serialized.
     *
     * @param cwdHash - Hash identifying the workspace (shadow git key)
     * @param fn      - Async function to run under mutual exclusion
     * @param opts    - Optional: label for diagnostics, timeout for warning threshold (ms)
     * @returns The result of fn
     */
    async runExclusive<T>(cwdHash: string, fn: () => Promise<T>, opts?: { label?: string; warnAfterMs?: number }): Promise<T> {
        let mutex = this.mutexes.get(cwdHash)
        if (!mutex) {
            mutex = new Mutex()
            this.mutexes.set(cwdHash, mutex)
        }

        const waitStart = performance.now()
        const label = opts?.label ?? "checkpoint op"
        const warnThreshold = opts?.warnAfterMs ?? 500

        const result = await mutex.withLock(async () => {
            const waitDuration = performance.now() - waitStart
            if (waitDuration > warnThreshold) {
                Logger.warn(
                    `[CheckpointMutex] ${label} waited ${Math.round(waitDuration)}ms for lock ` +
                        `(cwdHash=${cwdHash}) — multi-window contention likely`,
                )
            }
            return fn()
        })

        return result
    }
}

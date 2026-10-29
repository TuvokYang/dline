/**
 * ICheckpointLockManager — Unified Checkpoint Lock Interface
 *
 * Abstracts checkpoint operation serialization across different host
 * environments:
 *   - Standalone/CLI: SqliteLockManager (cross-process via SQLite)
 *   - VS Code:         InProcessLockManager (process-level via p-mutex)
 *
 * All CheckpointTracker methods that touch the shared shadow git
 * repository must go through `runExclusive()` to prevent race
 * conditions between concurrent tasks or VS Code windows.
 */
export interface ICheckpointLockManager {
    /**
     * Execute fn under mutual exclusion for the given cwdHash.
     *
     * All callers sharing the same cwdHash are serialized — only one
     * will execute at a time. The lock is automatically released when
     * fn completes (success or failure).
     *
     * @param cwdHash - Hash identifying the workspace (shadow git key)
     * @param fn      - Async function to run under mutual exclusion
     * @returns The result of fn
     */
    runExclusive<T>(cwdHash: string, fn: () => Promise<T>): Promise<T>
}

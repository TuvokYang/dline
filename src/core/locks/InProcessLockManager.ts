import { CheckpointMutexRegistry } from "@/integrations/checkpoints/CheckpointMutexRegistry"
import type { ICheckpointLockManager } from "./ICheckpointLockManager"

/**
 * InProcessLockManager — Process-Level Checkpoint Lock (VS Code)
 *
 * Implements ICheckpointLockManager for VS Code environments where
 * cross-process locking (SqliteLockManager) is unavailable. Delegates
 * to CheckpointMutexRegistry, which maintains a per-cwdHash Mutex pool
 * backed by p-mutex.
 *
 * This ensures that within a single VS Code process, all checkpoint
 * operations targeting the same shadow git repository are serialized,
 * preventing race conditions between concurrent Tasks (parent + spawned
 * children).
 *
 * Limitation:
 * - Does NOT protect against concurrent VS Code windows (separate
 *   Node.js processes). For cross-process serialization, the
 *   SqliteLockManager (standalone/CLI) path is required.
 */
export class InProcessLockManager implements ICheckpointLockManager {
    private registry: CheckpointMutexRegistry

    constructor() {
        this.registry = CheckpointMutexRegistry.getInstance()
    }

    /**
     * Execute fn under process-level mutual exclusion for the given cwdHash.
     *
     * @inheritdoc
     */
    async runExclusive<T>(cwdHash: string, fn: () => Promise<T>): Promise<T> {
        return this.registry.runExclusive(cwdHash, fn)
    }
}

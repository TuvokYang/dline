import { readJsonWithBackup, writeJsonAtomic } from "@shared/storage/atomic-file"
import type { DurableTaskSnapshot, StateVault } from "./contracts"

interface PersistedTaskStateV1 {
    readonly version: 1
    readonly snapshot: DurableTaskSnapshot
}

function decode(value: unknown): DurableTaskSnapshot {
    const parsed = value as Partial<PersistedTaskStateV1> | null
    if (parsed?.version !== 1 || !parsed.snapshot?.state || !Array.isArray(parsed.snapshot.outbox)) {
        throw new Error("InvalidTaskStateVault")
    }
    return parsed.snapshot
}

function decodeFor(taskId: string): (value: unknown) => DurableTaskSnapshot {
    return (value) => {
        const snapshot = decode(value)
        if (snapshot.state.taskId !== taskId) throw new Error("TaskStateVaultIdentityMismatch")
        return snapshot
    }
}

export class FileTaskStateVault implements StateVault {
    private writeTail: Promise<void> = Promise.resolve()

    /** @param filePath the instance state file; see `InstanceLayout.stateFile`. */
    constructor(private readonly filePath: string) {}

    /** Returns the newest decodable snapshot, falling back to `state.json.bak` when the primary is unusable. */
    async load(taskId: string): Promise<DurableTaskSnapshot | undefined> {
        await this.writeTail
        const result = await readJsonWithBackup(this.filePath, decodeFor(taskId))
        switch (result.status) {
            case "primary":
            case "backup":
                return result.value
            case "missing":
                return undefined
            case "invalid":
                throw result.error
        }
    }

    save(snapshot: DurableTaskSnapshot): Promise<void> {
        const document: PersistedTaskStateV1 = { version: 1, snapshot }
        const write = this.writeTail.then(() => writeJsonAtomic(this.filePath, document, { backup: true }))
        this.writeTail = write.catch(() => undefined)
        return write
    }
}

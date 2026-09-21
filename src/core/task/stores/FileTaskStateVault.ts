import { readFile } from "node:fs/promises"
import path from "node:path"
import { atomicWriteTaskFile } from "./AtomicTaskFile"
import type { DurableTaskSnapshot, StateVault } from "./contracts"

interface PersistedTaskStateV1 {
	readonly version: 1
	readonly snapshot: DurableTaskSnapshot
}

function decode(content: string): DurableTaskSnapshot {
	const parsed = JSON.parse(content) as Partial<PersistedTaskStateV1>
	if (parsed.version !== 1 || !parsed.snapshot?.state || !Array.isArray(parsed.snapshot.outbox)) {
		throw new Error("InvalidTaskStateVault")
	}
	return parsed.snapshot
}

export class FileTaskStateVault implements StateVault {
	private readonly filePath: string
	private writeTail: Promise<void> = Promise.resolve()

	constructor(directory: string) {
		this.filePath = path.join(directory, "state.json")
	}

	async load(taskId: string): Promise<DurableTaskSnapshot | undefined> {
		await this.writeTail
		try {
			const snapshot = decode(await readFile(this.filePath, "utf8"))
			if (snapshot.state.taskId !== taskId) throw new Error("TaskStateVaultIdentityMismatch")
			return snapshot
		} catch (error) {
			if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined
			throw error
		}
	}

	save(snapshot: DurableTaskSnapshot): Promise<void> {
		const payload = `${JSON.stringify({ version: 1, snapshot } satisfies PersistedTaskStateV1, null, 2)}\n`
		const write = this.writeTail.then(() => atomicWriteTaskFile(this.filePath, payload))
		this.writeTail = write.catch(() => undefined)
		return write
	}
}

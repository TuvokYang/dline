import { ensureInstanceLayout, InstanceDatabase, openInstanceStorage } from "../../storage/instance"
import { FileTaskStateVault, openTaskJournalStores, type TaskPayloadStore } from "../stores"
import type { TaskPersistencePorts } from "./TaskExecutorAssembly"

/** The one module that writes `journal.db`: every kernel commit goes through it. */
export const KERNEL_COMMIT_WRITER = "kernel-commit"

export interface TaskPersistenceAssembly {
	readonly ports: Omit<TaskPersistencePorts, "taskView">
	readonly payloads: TaskPayloadStore
	/** Closes `journal.db`; idempotent. Absent for in-memory assemblies that own no files. */
	readonly close?: () => Promise<void>
}

/**
 * Opens the durable stores of one task: `state.json` and `journal.db`.
 *
 * The caller owns the result and must call `close` when the task incarnation ends,
 * so the database and its `-wal`/`-shm` files are released.
 */
export async function openTaskPersistence(taskId: string): Promise<TaskPersistenceAssembly> {
	const layout = await ensureInstanceLayout({ taskId })
	const storage = openInstanceStorage(layout.root)
	try {
		const stores = await openTaskJournalStores(await storage.openDatabase(InstanceDatabase.Journal, KERNEL_COMMIT_WRITER))
		return {
			ports: {
				vault: new FileTaskStateVault(layout.stateFile),
				publications: stores.publications,
				journal: stores.journal,
			},
			payloads: stores.payloads,
			close: () => storage.close(),
		}
	} catch (error) {
		await storage.close()
		throw error
	}
}

import path from "node:path"
import { ensureTaskDirectoryExists } from "../../storage/disk"
import {
	FileCommandPublicationStore,
	FileTaskPayloadStore,
	FileTaskStateVault,
	SegmentedConversationJournal,
	type TaskPayloadStore,
} from "../stores"
import type { TaskPersistencePorts } from "./TaskExecutorAssembly"

export interface TaskPersistenceAssembly {
	readonly ports: Omit<TaskPersistencePorts, "taskView">
	readonly payloads: TaskPayloadStore
}

export async function openTaskPersistence(taskId: string): Promise<TaskPersistenceAssembly> {
	const taskDirectory = await ensureTaskDirectoryExists(taskId)
	const runtimeDirectory = path.join(taskDirectory, "runtime-v2")
	const journal = await SegmentedConversationJournal.open({ directory: path.join(runtimeDirectory, "journal"), taskId })
	const publications = await FileCommandPublicationStore.open(runtimeDirectory)
	return {
		ports: {
			vault: new FileTaskStateVault(runtimeDirectory),
			publications,
			journal,
		},
		payloads: new FileTaskPayloadStore(path.join(runtimeDirectory, "payloads")),
	}
}

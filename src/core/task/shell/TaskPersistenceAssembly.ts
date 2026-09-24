import path from "node:path"
import { ensureInstanceLayout } from "../../storage/instance"
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
	const layout = await ensureInstanceLayout({ taskId })
	const runtimeDirectory = layout.runtimeDirectory
	const journal = await SegmentedConversationJournal.open({ directory: path.join(runtimeDirectory, "journal"), taskId })
	const publications = await FileCommandPublicationStore.open(runtimeDirectory)
	return {
		ports: {
			vault: new FileTaskStateVault(layout.stateFile),
			publications,
			journal,
		},
		payloads: new FileTaskPayloadStore(path.join(runtimeDirectory, "payloads")),
	}
}

import { resolveTaskTempFilePath, TaskTempSection } from "@core/storage/task-temp"
import { readTaskConversation } from "@core/task/conversation/TaskConversationReader"
import { openFile as openFileIntegration } from "@integrations/misc/open-file"
import { Empty, StringRequest } from "@shared/proto/dline/common"
import { writeFileAtomic } from "@/shared/storage/atomic-file"
import { Controller } from ".."

/** Stable name of the export, so opening it again replaces the previous one. */
const EXPORT_STEM = "api_conversation_history"

/**
 * Opens the provider conversation of the given task in the editor.
 *
 * The conversation lives in the task's journal, which is a database, so it is
 * exported to one JSON line per message under the task's temporary root and
 * that file is opened. The export is a snapshot for reading; editing it changes
 * nothing the task uses.
 *
 * @param request Carries the task ID in `value`.
 */
export async function openDiskConversationHistory(_controller: Controller, request: StringRequest): Promise<Empty> {
	if (!request.value) return Empty.create()
	const messages = await readTaskConversation(request.value)
	const exportPath = resolveTaskTempFilePath(request.value, TaskTempSection.ConversationExport, EXPORT_STEM, "jsonl")
	await writeFileAtomic(exportPath, messages.map((message) => `${JSON.stringify(message)}\n`).join(""))
	openFileIntegration(exportPath)
	return Empty.create()
}

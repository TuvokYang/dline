import { getPrompt } from "@core/prompts/i18n"
import type { ClineStorageMessage } from "@shared/messages/content"

/** Tag that delimits an accepted compaction summary wherever it is carried back into a conversation. */
export const PREVIOUS_COMPACTION_SUMMARY_TAG = "previous_task_compaction_summary"

/**
 * Wrap an accepted compaction summary so a later model turn or compaction pass can tell it apart
 * from user-authored text.
 *
 * The wrapper is applied only at projection time; the persisted summary stays unchanged, so tasks
 * compacted by an earlier version gain the same delimiter when they are resumed.
 */
export function formatPreviousCompactionSummary(summary: string): string {
	const notice = getPrompt("contextManagement", "previousCompactionSummaryNotice")
	return `<${PREVIOUS_COMPACTION_SUMMARY_TAG}>\n${notice}\n\n${summary}\n</${PREVIOUS_COMPACTION_SUMMARY_TAG}>`
}

/** Project an accepted compaction summary as the user-role message that replaces the conversation it covers. */
export function compactionSummaryMessage(summary: string): ClineStorageMessage {
	return { role: "user", content: [{ type: "text", text: formatPreviousCompactionSummary(summary) }] }
}

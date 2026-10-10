import type { UiMessage } from "@shared/ExtensionMessage"
import type { ClineStorageMessage } from "@shared/messages/content"
import { Logger } from "@shared/services/Logger"
import { apiHistoryImportPending, importApiHistory } from "../conversation/ApiHistoryImport"
import { importSnapshotQueue, SnapshotQueueCleanupPendingError, snapshotQueueSource } from "../input-queue/SnapshotQueueImport"
import type { TaskPersistenceAssembly } from "../shell/TaskPersistenceAssembly"
import { legacyConversationRepairPending, repairLegacyConversation } from "./LegacyConversationRepair"

/**
 * A task written by an earlier version could not carry its conversation into
 * the journal, so it must not open.
 *
 * Opening anyway would be permanent: the runtime's first journal write closes
 * the import off, and the request after it would go out without the history.
 * Refusing loses nothing, because `api_conversation_history.jsonl` is never
 * modified and the import resumes on the next open.
 */
export class ApiHistoryImportError extends Error {
    constructor(
        readonly taskId: string,
        cause: unknown,
    ) {
        super(`Task ${taskId} could not import the conversation saved by an earlier version`, { cause })
        this.name = "ApiHistoryImportError"
    }
}

export interface TaskUpgradeImportInput {
    readonly taskId: string
    readonly persistence: TaskPersistenceAssembly
    /** The task's `api_conversation_history.jsonl`, as the message store read it. */
    readonly apiHistory: readonly ClineStorageMessage[]
    /** Chat rows may carry compaction ranges written before the journal became canonical. */
    readonly uiMessages?: readonly UiMessage[]
    /** Legacy index range hidden by ContextManager truncation. */
    readonly conversationHistoryDeletedRange?: readonly [number, number]
}

/**
 * Carry everything an earlier version kept outside the runtime stores into them.
 *
 * Runs before the kernel reads either durable source, so the task hydrates with
 * the conversation and retained input it already had. The conversation goes
 * first: the queue import positions a new `state.json` at the journal tail the
 * conversation import leaves. Only the window owning the task lock may call
 * this, since it writes `journal.db` and `state.json`.
 */
export async function importTaskUpgrade(input: TaskUpgradeImportInput): Promise<void> {
    await importConversation(input)
    await importLegacyCompactionState(input)
    await importInputQueue(input)
}

/**
 * Whether {@link importTaskUpgrade} still has work, read without writing.
 *
 * A window that opens the task without its lock cannot import, so its session
 * remembers this and is reopened once the window owns the task. A source that
 * cannot be read counts as pending: the owning open then reports the failure.
 */
export async function taskUpgradeImportPending(input: TaskUpgradeImportInput): Promise<boolean> {
    try {
        if (await apiHistoryImportPending({ journal: input.persistence.ports.journal, history: input.apiHistory })) {
            return true
        }
        if (await legacyCompactionImportPending(input)) return true
        return (await (await snapshotQueueSource(input.taskId)).read()) !== undefined
    } catch (error) {
        Logger.warn(
            `[Task ${input.taskId}] Could not check for data to import from an earlier version; importing once the task is owned`,
            error,
        )
        return true
    }
}

async function legacyCompactionImportPending(input: TaskUpgradeImportInput): Promise<boolean> {
    return legacyConversationRepairPending(input.persistence.ports.journal)
}

async function importLegacyCompactionState(input: TaskUpgradeImportInput): Promise<void> {
    await repairLegacyConversation({
        journal: input.persistence.ports.journal,
        payloads: input.persistence.payloads,
        canonicalLength: input.apiHistory.length,
        uiMessages: input.uiMessages,
        deletedRange: input.conversationHistoryDeletedRange,
    })
}

async function importConversation(input: TaskUpgradeImportInput): Promise<void> {
    try {
        const imported = await importApiHistory({
            journal: input.persistence.ports.journal,
            payloads: input.persistence.payloads,
            history: input.apiHistory,
        })
        if (imported > 0) Logger.info(`[Task ${input.taskId}] Imported ${imported} messages from api_conversation_history.jsonl`)
    } catch (error) {
        throw new ApiHistoryImportError(input.taskId, error)
    }
}

async function importInputQueue(input: TaskUpgradeImportInput): Promise<void> {
    try {
        const result = await importSnapshotQueue({
            taskId: input.taskId,
            source: await snapshotQueueSource(input.taskId),
            vault: input.persistence.ports.vault,
            payloads: input.persistence.payloads,
            journalTail: input.persistence.ports.journal.watermark(),
        })
        if (result.kind === "imported") {
            Logger.info(
                `[Task ${input.taskId}] Imported ${result.importedEntries} queued inputs from snapshot.json; skipped ${result.skippedDeliveringEntries} possibly delivered and ${result.skippedInvalidEntries} invalid entries`,
            )
        }
    } catch (error) {
        if (!(error instanceof SnapshotQueueCleanupPendingError)) throw error
        Logger.warn(
            `[Task ${input.taskId}] Removing the imported queue from snapshot.json failed; state.json is safe and the removal resumes on the next open`,
            error.cause,
        )
    }
}

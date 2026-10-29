import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readCompletedCompactionCards } from "@core/context/context-management/compaction-context-projection"
import type { UiMessage } from "@shared/ExtensionMessage"
import { afterEach, describe, expect, it } from "vitest"
import { UIMessage } from "../../storage/UIMessage"
import { MessageStateHandler } from "../message-state"

const originalDocumentsDirectory = process.env.DLINE_DOCUMENTS_DIRECTORY

afterEach(() => {
    if (originalDocumentsDirectory === undefined) delete process.env.DLINE_DOCUMENTS_DIRECTORY
    else process.env.DLINE_DOCUMENTS_DIRECTORY = originalDocumentsDirectory
})

describe("MessageState compaction transient overlay", () => {
    it("keeps partial compaction rows out of JSONL and finalizes exactly one durable ranged row", async () => {
        const documentsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-transient-compaction-"))
        process.env.DLINE_DOCUMENTS_DIRECTORY = documentsDirectory
        const taskId = "task-transient-compaction"
        const uiMessage = await UIMessage.open(taskId)
        const state = new MessageStateHandler({
            taskId,
            ulid: "ulid-transient-compaction",
            updateTaskHistory: async () => [],
            uiMessage,
        })
        const partial: UiMessage = {
            ts: 100,
            type: "say",
            say: "tool",
            partial: true,
            text: JSON.stringify({ tool: "summarizeTask", content: "partial", compactionStatus: "running" }),
        }

        state.upsertTransientClineMessage(partial)
        await state.flushUiMessages()
        await uiMessage.close()

        const afterPartial = await UIMessage.open(taskId)
        expect(afterPartial.getAll()).toEqual([])
        await afterPartial.close()

        const reopened = await UIMessage.open(taskId)
        const finalState = new MessageStateHandler({
            taskId,
            ulid: "ulid-transient-compaction",
            updateTaskHistory: async () => [],
            uiMessage: reopened,
        })
        finalState.upsertTransientClineMessage(partial)
        await finalState.commitTransientClineMessage({
            ...partial,
            partial: false,
            text: JSON.stringify({ tool: "summarizeTask", content: "completed", compactionStatus: "completed" }),
            compactionConversationRange: {
                logicalTurnRange: [0, 0],
                apiConversationRange: [0, 1],
                preCompactionApiEndIndex: 1,
            },
        })
        await reopened.close()

        const durable = await UIMessage.open(taskId)
        expect(durable.getAll()).toEqual([
            expect.objectContaining({
                ts: 100,
                partial: false,
                say: "tool",
                compactionConversationRange: {
                    logicalTurnRange: [0, 0],
                    apiConversationRange: [0, 1],
                    preCompactionApiEndIndex: 1,
                },
            }),
        ])
        await durable.close()
        await fs.rm(documentsDirectory, { recursive: true, force: true })
    })

    it("reopens independent Pass, refit, final, and failed cards while projecting only the final ranged summary", async () => {
        const documentsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-durable-compaction-cards-"))
        process.env.DLINE_DOCUMENTS_DIRECTORY = documentsDirectory
        const taskId = "task-durable-compaction-cards"
        const uiMessage = await UIMessage.open(taskId)
        const state = new MessageStateHandler({
            taskId,
            ulid: "ulid-durable-compaction-cards",
            updateTaskHistory: async () => [],
            uiMessage,
        })
        const cards: UiMessage[] = [
            compactionCard(101, "pass", 0, "completed", "first accepted summary"),
            compactionCard(102, "summary_refit", 0, "completed", "smaller cumulative summary"),
            {
                ...compactionCard(103, "pass", 1, "completed", "final cumulative summary"),
                compactionConversationRange: {
                    logicalTurnRange: [0, 3],
                    apiConversationRange: [0, 7],
                    preCompactionApiEndIndex: 7,
                },
            },
            compactionCard(104, "failure", 0, "failed", "", "The rebuilt target remained above the exit target."),
        ]

        for (const card of cards) {
            state.upsertTransientClineMessage({ ...card, partial: true })
            await state.commitTransientClineMessage(card)
        }
        await uiMessage.close()

        const reopened = await UIMessage.open(taskId)
        const durableCards = reopened.getAll()
        expect(durableCards).toHaveLength(4)
        expect(durableCards.map((message) => message.ts)).toEqual([101, 102, 103, 104])
        expect(durableCards.filter((message) => message.compactionConversationRange)).toHaveLength(1)
        expect(JSON.parse(durableCards[3].text ?? "{}")).toMatchObject({
            compactionStatus: "failed",
            compactionUnitKind: "failure",
            error: "The rebuilt target remained above the exit target.",
        })
        expect(readCompletedCompactionCards(durableCards)).toEqual([
            {
                summary: "final cumulative summary",
                range: {
                    logicalTurnRange: [0, 3],
                    apiConversationRange: [0, 7],
                    preCompactionApiEndIndex: 7,
                },
            },
        ])
        await reopened.close()
        await fs.rm(documentsDirectory, { recursive: true, force: true })
    })
})

function compactionCard(
    ts: number,
    unitKind: "pass" | "summary_refit" | "failure",
    unitIndex: number,
    status: "completed" | "failed",
    content: string,
    error?: string,
): UiMessage {
    return {
        ts,
        type: "say",
        say: "tool",
        partial: false,
        text: JSON.stringify({
            tool: "summarizeTask",
            content,
            compactionStatus: status,
            compactionOperationId: "operation-durable-cards",
            compactionUnitKind: unitKind,
            compactionUnitIndex: unitIndex,
            ...(error ? { error } : {}),
        }),
    }
}

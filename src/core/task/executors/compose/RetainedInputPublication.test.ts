import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { resolveChatRestoreBoundary } from "@/integrations/checkpoints/chat-restore-boundary"
import { resolveInstanceLayout } from "../../../storage/instance"
import { openUiMessageRows, UI_MESSAGE_READER } from "../../../storage/messages/openUiMessageRows"
import { UIMessage } from "../../../storage/UIMessage"
import { createInitialTaskState } from "../../kernel"
import { MessageStateHandler } from "../../message-state"
import { RetainedInputPresenter } from "../../session/RetainedInputPresenter"
import { InMemoryConversationJournal, InMemoryTaskPayloadStore } from "../../stores/InMemoryRuntimeStores"
import { encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import { ProductionComposeAdapter } from "./ProductionComposeAdapter"

const docs = process.env.DLINE_DOCS_DIR
const documents = process.env.DLINE_DOCUMENTS_DIRECTORY
afterEach(() => {
    if (docs === undefined) delete process.env.DLINE_DOCS_DIR
    else process.env.DLINE_DOCS_DIR = docs
    if (documents === undefined) delete process.env.DLINE_DOCUMENTS_DIRECTORY
    else process.env.DLINE_DOCUMENTS_DIRECTORY = documents
})

describe("retained input publication boundaries", () => {
    it("orders the input after pre-round compaction but before compaction that includes it", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "dline-retained-boundary-"))
        process.env.DLINE_DOCS_DIR = root
        process.env.DLINE_DOCUMENTS_DIRECTORY = root
        const taskId = "retained-boundary"
        const ui = await UIMessage.open(taskId)
        try {
            const messages = new MessageStateHandler({ taskId, ulid: taskId, uiMessage: ui, updateTaskHistory: async () => [] })
            const payloads = new InMemoryTaskPayloadStore()
            const journal = new InMemoryConversationJournal()
            const original = await payloads.put(encodeTaskPayload({ kind: "user_input", text: "original" }))
            await journal.append({ operationId: "original", payloadRef: original, source: "intake" })
            const retainedRef = await payloads.put(encodeTaskPayload({ kind: "user_input", text: "steer" }))
            const delivery = { deliveryId: "delivery-1", point: "tool_round" as const, ownerId: "compose-1", generation: 0 }
            const base = createInitialTaskState(taskId)
            const state = {
                ...base,
                intake: {
                    ...base.intake,
                    queued: [
                        {
                            entryId: "retained",
                            payloadRef: retainedRef,
                            source: "user" as const,
                            mode: "steering" as const,
                            sequence: 0,
                            state: "reserved" as const,
                            queue: { editing: false, delivery },
                        },
                    ],
                },
            }
            let id = 100
            const nextId = () => ++id
            await messages.addToClineMessages({ ts: nextId(), type: "say", say: "task", text: "original" })
            const writeCompactionCard = async (content: string) => {
                const ts = nextId()
                await messages.addToClineMessages({
                    ts,
                    type: "say",
                    say: "tool",
                    text: JSON.stringify({
                        tool: "summarizeTask",
                        content,
                        compactionStatus: "completed",
                        compactionJournalBoundary: journal.watermark(),
                    }),
                })
                return ts
            }
            let beforeTs = 0
            let afterTs = 0
            const adapter = new ProductionComposeAdapter({
                payloads,
                journal,
                readState: () => state,
                retainedInputPresentation: new RetainedInputPresenter(payloads, messages, nextId),
                compactionBarrier: {
                    settleBeforeRound: async () => {
                        beforeTs = await writeCompactionCard("before retained input")
                        return { kind: "ready" }
                    },
                },
                contextWindowGuard: {
                    admit: async () => {
                        afterTs = await writeCompactionCard("includes retained input")
                        return { kind: "ready" }
                    },
                },
            })
            const result = await adapter.compose({
                admittedEntryIds: ["retained"],
                queueDelivery: delivery,
                signal: new AbortController().signal,
            })
            if (!("draftRef" in result)) throw new Error("Expected a composed draft")
            // Publication belongs to accepted, durable compose feedback, not the
            // adapter's journal staging. Nothing is visible before that boundary.
            expect(messages.clineMessages.some((row) => row.interactionId === delivery.deliveryId)).toBe(false)
            await result.presentation?.commit()
            const rows = messages.durableClineMessages
            const inputIndex = rows.findIndex((row) => row.interactionId === delivery.deliveryId)
            const beforeIndex = rows.findIndex((row) => row.ts === beforeTs)
            const afterIndex = rows.findIndex((row) => row.ts === afterTs)
            expect(inputIndex).toBeGreaterThan(beforeIndex)
            expect(inputIndex).toBeLessThan(afterIndex)
            for (const [index, includesInput] of [
                [beforeIndex, false],
                [afterIndex, true],
            ] as const) {
                const boundary = resolveChatRestoreBoundary({
                    messages: rows,
                    messageIndex: index,
                    apiCount: 0,
                    uiCount: rows.length,
                })
                const retainedByUi = rows.slice(0, boundary.uiKeepCount).some((row) => row.interactionId === delivery.deliveryId)
                const retainedByJournal = result.queueJournalReceipt!.journalWatermark.seq <= boundary.journalTarget!.seq
                expect(retainedByUi).toBe(includesInput)
                expect(retainedByJournal).toBe(includesInput)
            }
            await result.presentation?.commit()
            expect(messages.clineMessages.filter((row) => row.interactionId === delivery.deliveryId)).toHaveLength(1)
            await ui.close()
            const reopened = await UIMessage.open(taskId)
            try {
                expect(reopened.getAll().map((row) => row.ts)).toEqual(rows.map((row) => row.ts))
                expect(reopened.getAll().filter((row) => row.interactionId === delivery.deliveryId)).toHaveLength(1)
            } finally {
                await reopened.close()
            }
            const committed = await openUiMessageRows((await resolveInstanceLayout({ taskId })).root, UI_MESSAGE_READER)
            try {
                expect((await committed.commitLog.head()).violationTs).toBeNull()
            } finally {
                await committed.close()
            }
        } finally {
            await ui.close()
            await rm(root, { recursive: true, force: true })
        }
    })
})

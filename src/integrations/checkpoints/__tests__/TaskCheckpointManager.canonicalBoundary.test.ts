import { describe, expect, it, vi } from "vitest"
import type { UiMessage } from "@/shared/ExtensionMessage"

vi.unmock("@integrations/checkpoints")

import { CanonicalCheckpointRepository, canonicalCheckpointRef } from "@/core/task/checkpoints/CanonicalCheckpointRepository"
import { createInitialTaskState, type TaskState } from "@/core/task/kernel"
import { restoreCheckpoint } from "@/core/task/shell/checkpoint-restore"
import {
    InMemoryConversationJournal,
    InMemoryStateVault,
    InMemoryTaskPayloadStore,
} from "@/core/task/stores/InMemoryRuntimeStores"
import { JournalConversationRewind } from "@/core/task/stores/JournalConversationRewind"
import { decodeTaskPayload, encodeTaskPayload } from "@/core/task/stores/payload/TaskPayloadCodec"
import { createTaskCheckpointManager } from "../index"
import type { CanonicalCheckpointPort } from "../types"

/**
 * A canonical restore must resolve one effective journal boundary and use it for
 * the hydrate, the rewind and the saved snapshot.
 *
 * A checkpoint records where its row was written. That is not where the row's
 * chat returns to: the row's own input and the tool results answering calls made
 * before it were journaled after that position. Rewinding only to the stored
 * position left the input an edit replaces in the provider conversation beside
 * the edited text submitted again, and saved a snapshot pointing behind the
 * conversation the restore actually left.
 *
 * These use the real repository, the real rewind and the real restore shell over
 * an in-memory journal; only the legacy presentation collaborators are doubles.
 */
function createHarness(
    messages: UiMessage[],
    conversationRewind: never,
    canonicalCheckpoint: CanonicalCheckpointPort,
    currentConversationSize?: () => Promise<number>,
) {
    const restoreChatRuntime = vi.fn().mockResolvedValue(undefined)
    const truncateUiHistory = vi.fn().mockResolvedValue(undefined)
    const truncateApiHistory = vi.fn().mockResolvedValue(undefined)
    const truncateContextHistory = vi.fn().mockResolvedValue(undefined)
    const messageStateHandler = {
        clineMessages: messages,
        durableClineMessages: messages,
        clearTransientClineMessages: vi.fn().mockReturnValue([]),
        ...(currentConversationSize ? { currentConversationSize } : {}),
        apiConversation: { count: 6, truncateByLineNum: truncateApiHistory, getAt: vi.fn() },
        uiMessage: { count: messages.length, truncateByLineNum: truncateUiHistory },
        updateTaskHistory: vi.fn().mockResolvedValue(undefined),
        setCheckpointTracker: vi.fn(),
    }
    const manager = createTaskCheckpointManager(
        { taskId: "task-1", controller: { task: { resumeTask: vi.fn() } } } as never,
        { enableCheckpoints: true },
        {
            fileContextTracker: { detectFilesEditedAfterMessage: vi.fn().mockResolvedValue([]) },
            contextManager: { truncateContextHistory },
            diffViewProvider: {},
            messageStateHandler,
            taskState: Object.assign(
                { resetMistakeLimitState: vi.fn(), conversationHistoryDeletedRange: undefined },
                { userMessageContent: [], assistantMessageContent: [], userMessageContentReady: false },
            ),
            conversationRewind,
            canonicalCheckpoint,
        } as never,
        {
            updateTaskHistory: vi.fn().mockResolvedValue([]),
            cancelTask: vi.fn().mockResolvedValue(undefined),
            restoreChatRuntime,
            say: vi.fn().mockResolvedValue(100),
            postStateToWebview: vi.fn().mockResolvedValue(undefined),
            publishMessage: vi.fn().mockResolvedValue(undefined),
        } as never,
        { checkpointTracker: { getDiffSet: vi.fn(), resetHead: vi.fn(), restoreFiles: vi.fn() } as never },
    )
    return { manager, restoreChatRuntime, truncateUiHistory }
}

/**
 * The canonical transaction over the task's real stores.
 *
 * `boundary` is where the checkpoint captured its bundle; `messageTs` names the
 * restored row so the repository can find it.
 */
function canonicalTransaction(input: { readonly boundary: { readonly seq: number }; readonly messageTs: number }) {
    const taskId = "task-1"
    const journal = new InMemoryConversationJournal()
    const payloads = new InMemoryTaskPayloadStore()
    const vault = new InMemoryStateVault()
    const rewind = new JournalConversationRewind(journal)
    const repository = new CanonicalCheckpointRepository({ taskId, vault, journal, payloads })
    /** One conversation entry; its reference names it, so a restore's effect is readable. */
    const say = async (ref: string, source: "intake" | "provider" | "tool" | "system") => {
        await journal.append({ operationId: ref, payloadRef: await payloads.put(encodeTaskPayload({ ref })), source })
    }
    const visible = async () =>
        Promise.all(
            (await journal.project()).visibleMessages.map(async (entry) => {
                if (entry.payloadRef === undefined) throw new Error("Fixture message has no payload")
                return decodeTaskPayload<{ ref: string }>(await payloads.read(entry.payloadRef)).ref
            }),
        )
    const checkpointRef = canonicalCheckpointRef(taskId, input.messageTs)
    const restore = vi.fn<CanonicalCheckpointPort["restore"]>(async (request) => {
        const result = await restoreCheckpoint(
            {
                taskId,
                checkpointRef,
                mode: request.mode,
                ...(request.journalTarget === undefined ? {} : { journalTarget: request.journalTarget }),
                ...(request.row === undefined ? {} : { row: request.row }),
                ...(request.pendingInput === undefined ? {} : { pendingInput: request.pendingInput }),
            },
            {
                stopAndFence: async () => undefined,
                resolve: async () =>
                    request.journalTarget ? repository.resolveAt(request.journalTarget) : repository.resolve(checkpointRef),
                restoreWorkspace: request.restoreWorkspace,
                // The row's own recorded position is the base; the checkpoint's
                // stored one is only the fallback for rows that recorded none.
                resolveRowBoundary: (boundary, row) => rewind.resolveRowBoundary(row, boundary),
                applyConversationBoundary: async (boundary) => {
                    await rewind.restoreTo({
                        operationId: `checkpoint.restore:${checkpointRef}:${boundary.seq}`,
                        target: boundary,
                    })
                    return boundary
                },
                save: (snapshot) => vault.save(snapshot),
            },
        )
        return result
    })
    /** Write the bundle the checkpoint row stands for, at the position that row recorded. */
    const capture = (roundMaterial?: TaskState["roundMaterial"]) =>
        repository.capture({
            checkpointRef,
            boundary: input.boundary,
            snapshot: { state: { ...createInitialTaskState(taskId), revision: 2, roundMaterial }, outbox: [] },
        })
    return {
        port: { capture: vi.fn(), restore } satisfies CanonicalCheckpointPort,
        /**
         * The manager's own rewind path.
         *
         * The canonical transaction is the restore's commit point, so the manager
         * must not run a second, independent rewind afterwards; these fail loudly
         * if it does, which is what kept the snapshot and the journal apart.
         */
        rewindPort: {
            rewindTo: vi.fn(async () => {
                throw new Error("the canonical transaction already rewound the journal")
            }),
            holdsConversation: () => true,
            rewindToRow: vi.fn(async () => {
                throw new Error("the canonical transaction already rewound the journal")
            }),
        },
        say,
        visible,
        capture,
        compact: async () =>
            journal.supersedeRange({
                operationId: "summary:rewrite",
                from: { seq: 1 },
                to: { seq: 4 },
                replacementRef: await payloads.put(encodeTaskPayload({ ref: "summary" })),
            }),
        conversationSize: async () => (await journal.project()).visibleMessages.length,
        savedWatermark: async () => (await vault.load(taskId))?.state.journalWatermark,
        savedMaterial: async () => (await vault.load(taskId))?.state.roundMaterial,
        putInput: (text: string) => payloads.put(encodeTaskPayload({ text })),
        rewindRecords: async () => (await journal.read()).filter((entry) => entry.kind === "rewind"),
    }
}

describe("TaskCheckpointManager canonical row-aware boundary", () => {
    /**
     * An old direct input and everything the conversation recorded after it.
     *
     * The row records the position before its input. The canonical bundle was
     * captured afterwards, so restoring the bundle alone retains the input
     * that an edit must replace.
     */
    async function subject() {
        const transaction = canonicalTransaction({ boundary: { seq: 3 }, messageTs: 10 })
        await transaction.say("task:initial", "intake")
        await transaction.say("answer-1", "provider")
        await transaction.say("old-input", "intake")
        await transaction.say("call-1", "provider")
        await transaction.say("result-1", "tool")
        await transaction.say("later-input", "intake")
        await transaction.capture()
        const messages: UiMessage[] = [
            { ts: 10, type: "say", say: "task", text: "old input", conversationHistoryIndex: 1, conversationJournalSeq: 2 },
            { ts: 20, type: "say", say: "text", text: "answer" },
        ]
        return {
            transaction,
            ...createHarness(messages, transaction.rewindPort as never, transaction.port),
        }
    }

    it("restores a pre-compaction checkpoint whose recorded index exceeds the compacted conversation length", async () => {
        const transaction = canonicalTransaction({ boundary: { seq: 6 }, messageTs: 30 })
        const history = ["task:initial", "answer-1", "middle-input", "answer-2", "trigger-input", "answer-3"]
        for (const [index, ref] of history.entries()) await transaction.say(ref, index % 2 === 0 ? "intake" : "provider")
        await transaction.capture()
        await transaction.compact()
        expect(await transaction.visible()).toEqual(["summary", "trigger-input", "answer-3"])
        const { manager, truncateUiHistory, restoreChatRuntime } = createHarness(
            [
                { ts: 10, type: "say", say: "task", text: "initial", conversationHistoryIndex: -1, conversationJournalSeq: 0 },
                { ts: 30, type: "say", say: "checkpoint_created", conversationHistoryIndex: 5, conversationJournalSeq: 6 },
                { ts: 40, type: "say", say: "tool", text: "completed summary" },
            ],
            transaction.rewindPort as never,
            transaction.port,
            transaction.conversationSize,
        )

        const result = await manager.restoreCheckpoint(30, "task")

        expect(result.checkpointManagerErrorMessage).toBeUndefined()
        expect(await transaction.visible()).toEqual(history)
        expect(await transaction.savedWatermark()).toEqual({ seq: 6 })
        expect(transaction.port.restore).toHaveBeenCalledOnce()
        expect(truncateUiHistory).toHaveBeenCalledWith(2)
        expect(restoreChatRuntime).toHaveBeenCalledWith({ apiIndex: 5 })
    })

    it.each([undefined, "edited reply"])("keeps a checkpoint's pending reply except during an edit: %s", async (editedText) => {
        const transaction = canonicalTransaction({ boundary: { seq: 2 }, messageTs: 30 })
        await transaction.say("initial task", "intake")
        await transaction.say("question before compaction", "provider")
        const feedback = [{ source: "dialog" as const, revision: 1, payloadRef: await transaction.putInput("accepted trigger") }]
        await transaction.capture({ feedback, notices: [] })
        const { manager } = createHarness(
            [{ ts: 30, type: "say", say: "checkpoint_created", conversationHistoryIndex: 1, conversationJournalSeq: 2 }],
            transaction.rewindPort as never,
            transaction.port,
        )

        const result = await manager.restoreCheckpoint(30, "task", undefined, editedText)

        expect(result.checkpointManagerErrorMessage).toBeUndefined()
        expect(await transaction.savedMaterial()).toEqual({ feedback: editedText === undefined ? feedback : [], notices: [] })
        expect(await transaction.visible()).toEqual(["initial task", "question before compaction"])
    })

    it("drops the input an edited row replaces instead of leaving both copies", async () => {
        const { manager, transaction } = await subject()

        // The user restored their own input's row with new text, which is submitted
        // again afterwards, so the input it replaces must not stay in the request.
        const result = await manager.restoreCheckpoint(10, "task", undefined, "edited input")

        expect(result.checkpointManagerErrorMessage).toBeUndefined()
        expect(await transaction.visible()).toEqual(["task:initial", "answer-1"])
    })

    it("uses the preceding row for the UI edit offset and saves the same effective boundary", async () => {
        const transaction = canonicalTransaction({ boundary: { seq: 3 }, messageTs: 20 })
        await transaction.say("task:initial", "intake")
        await transaction.say("answer-1", "provider")
        await transaction.say("old-input", "intake")
        await transaction.say("call-1", "provider")
        await transaction.say("result-1", "tool")
        await transaction.say("later-input", "intake")
        await transaction.capture()
        const { manager } = createHarness(
            [
                { ts: 10, type: "say", say: "task", text: "initial", conversationHistoryIndex: -1, conversationJournalSeq: 0 },
                { ts: 20, type: "say", say: "text", text: "answer", conversationHistoryIndex: 1, conversationJournalSeq: 2 },
                {
                    ts: 30,
                    type: "say",
                    say: "user_feedback",
                    text: "old input",
                    conversationHistoryIndex: 2,
                    conversationJournalSeq: 3,
                },
                {
                    ts: 40,
                    type: "say",
                    say: "text",
                    text: "later answer",
                    conversationHistoryIndex: 3,
                    conversationJournalSeq: 4,
                },
            ],
            transaction.rewindPort as never,
            transaction.port,
        )

        // UserMessage sends the edited row's timestamp with offset=1. The
        // preceding answer, not the input being replaced, owns the restore.
        const result = await manager.restoreCheckpoint(30, "task", 1, "edited input")

        expect(result.checkpointManagerErrorMessage).toBeUndefined()
        expect(transaction.port.restore).toHaveBeenCalledOnce()
        expect(transaction.port.restore).toHaveBeenCalledWith(
            expect.objectContaining({ messageTs: 20, row: { keep: 2, seq: 2, keepInput: false } }),
        )
        expect(await transaction.visible()).toEqual(["task:initial", "answer-1"])
        expect(await transaction.savedWatermark()).toEqual({ seq: 2 })
    })

    it("keeps that same input when the row is restored without an edit", async () => {
        const { manager, transaction } = await subject()

        const result = await manager.restoreCheckpoint(10, "task")

        expect(result.checkpointManagerErrorMessage).toBeUndefined()
        expect(await transaction.visible()).toEqual(["task:initial", "answer-1", "old-input"])
    })

    it("keeps a tool result that answers a call made before the restored row", async () => {
        const transaction = canonicalTransaction({ boundary: { seq: 1 }, messageTs: 10 })
        await transaction.say("task:initial", "intake")
        await transaction.say("call-1", "provider")
        await transaction.say("result-1", "tool")
        await transaction.say("later-input", "intake")
        await transaction.capture()
        const { manager } = createHarness(
            [{ ts: 10, type: "say", say: "text", text: "tool call", conversationHistoryIndex: 1, conversationJournalSeq: 2 }],
            transaction.rewindPort as never,
            transaction.port,
        )

        const result = await manager.restoreCheckpoint(10, "task")

        expect(result.checkpointManagerErrorMessage).toBeUndefined()
        expect(await transaction.visible()).toEqual(["task:initial", "call-1", "result-1"])
    })

    it("saves the boundary it rewound to and replays a retried restore", async () => {
        const { manager, transaction } = await subject()

        const result = await manager.restoreCheckpoint(10, "task", undefined, "edited input")
        expect(result.checkpointManagerErrorMessage).toBeUndefined()
        const rewinds = await transaction.rewindRecords()
        const visible = await transaction.visible()

        // The saved snapshot describes the conversation the restore left behind.
        expect(await transaction.savedWatermark()).toEqual({ seq: 2 })
        // A crash retry replays the same record instead of rewinding again.
        await manager.restoreCheckpoint(10, "task", undefined, "edited input")
        expect(await transaction.rewindRecords()).toHaveLength(rewinds.length)
        expect(await transaction.visible()).toEqual(visible)
    })

    it("rewinds new work on a fresh restore to the same target while an immediate retry stays idempotent", async () => {
        const { manager, transaction } = await subject()
        const first = await manager.restoreCheckpoint(10, "task", undefined, "edited input")
        expect(first.checkpointManagerErrorMessage).toBeUndefined()
        await transaction.say("after-first-restore", "intake")

        const second = await manager.restoreCheckpoint(10, "task", undefined, "edited again")

        expect(second.checkpointManagerErrorMessage).toBeUndefined()
        expect(await transaction.visible()).toEqual(["task:initial", "answer-1"])
        expect(await transaction.rewindRecords()).toHaveLength(2)
        const retried = await manager.restoreCheckpoint(10, "task", undefined, "edited again")
        expect(retried.checkpointManagerErrorMessage).toBeUndefined()
        expect(await transaction.rewindRecords()).toHaveLength(2)
        expect(await transaction.visible()).toEqual(["task:initial", "answer-1"])
    })

    it("leaves the conversation, the chat and the snapshot alone when the boundary cannot be rewound to", async () => {
        const transaction = canonicalTransaction({ boundary: { seq: 1 }, messageTs: 10 })
        await transaction.say("task:initial", "intake")
        await transaction.capture()
        // A row naming a position the journal never reached.
        const { manager, restoreChatRuntime, truncateUiHistory } = createHarness(
            [{ ts: 10, type: "say", say: "task", conversationHistoryIndex: 0, conversationJournalSeq: 9 }],
            transaction.rewindPort as never,
            transaction.port,
        )

        const update = await manager.restoreCheckpoint(10, "task")

        expect(update.checkpointManagerErrorMessage).toBeDefined()
        expect(await transaction.visible()).toEqual(["task:initial"])
        expect(await transaction.rewindRecords()).toEqual([])
        expect(restoreChatRuntime).not.toHaveBeenCalled()
        expect(truncateUiHistory).not.toHaveBeenCalled()
    })
})

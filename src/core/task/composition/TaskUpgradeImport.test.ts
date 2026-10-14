import type { UiMessage } from "@shared/ExtensionMessage"
import type { ClineStorageMessage } from "@shared/messages/content"
import { afterEach, describe, expect, it, vi } from "vitest"
import { importApiHistory } from "../conversation/ApiHistoryImport"
import { JournalConversationView } from "../executors/provider/service/JournalConversationView"
import { ProviderJournalMessageMaterializer } from "../executors/provider/service/ProviderJournalMessageMaterializer"
import { hydrate } from "../kernel"
import type { TaskPersistenceAssembly } from "../shell/TaskPersistenceAssembly"
import { InMemoryConversationJournal, InMemoryStateVault, InMemoryTaskPayloadStore } from "../stores"
import { encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import { ApiHistoryImportError, importTaskUpgrade, taskUpgradeImportPending } from "./TaskUpgradeImport"

const snapshotQueue = vi.hoisted(() => ({
    read: vi.fn(async (): Promise<{ fingerprint: string; entries: readonly unknown[] } | undefined> => undefined),
    removeInputQueue: vi.fn(async (_expectedFingerprint: string) => undefined),
}))

vi.mock("../input-queue/SnapshotQueueImport", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../input-queue/SnapshotQueueImport")>()),
    snapshotQueueSource: async () => snapshotQueue,
}))

const apiHistory: ClineStorageMessage[] = [
    { role: "user", content: [{ type: "text", text: "<task>fix it</task>" }], ts: 1 },
    { role: "assistant", content: [{ type: "text", text: "done" }], ts: 2 },
]

function persistence(journal = new InMemoryConversationJournal()) {
    const vault = new InMemoryStateVault()
    const payloads = new InMemoryTaskPayloadStore()
    return {
        journal,
        vault,
        payloads,
        assembly: { ports: { journal, vault }, payloads } as unknown as TaskPersistenceAssembly,
    }
}

describe("TaskUpgradeImport", () => {
    afterEach(() => {
        snapshotQueue.read.mockReset()
        snapshotQueue.read.mockResolvedValue(undefined)
        snapshotQueue.removeInputQueue.mockClear()
    })

    it("positions the state it creates for the snapshot queue after the imported conversation", async () => {
        const stores = persistence()
        snapshotQueue.read.mockResolvedValue({
            fingerprint: "sha256:queue",
            entries: [{ id: "queued-1", text: "after the import", images: [], files: [], mode: "queued", sequence: 0 }],
        })

        await importTaskUpgrade({ taskId: "task-1", persistence: stores.assembly, apiHistory })

        expect(stores.journal.watermark()).toEqual({ seq: 3 })
        const saved = await stores.vault.load("task-1")
        if (!saved) throw new Error("expected state.json")
        expect(saved.state.journalWatermark).toEqual({ seq: 3 })
        const restored = hydrate({ taskId: "task-1", snapshot: saved.state, journalTail: { seq: 3 }, openReason: "resume" })
        expect(restored.state.journalWatermark).toEqual({ seq: 3 })
        expect(restored.state.intake.queued.map((entry) => entry.entryId)).toEqual(["queued-1"])
        expect(snapshotQueue.removeInputQueue).toHaveBeenCalledWith("sha256:queue")
    })

    // Opening anyway would let the runtime's first journal write close the import
    // off for good, so the next request would go out without the conversation.
    it("refuses the open when the conversation cannot be imported, before touching the queue", async () => {
        const journal = new InMemoryConversationJournal()
        vi.spyOn(journal, "append").mockRejectedValue(new Error("journal.db is read-only"))
        const stores = persistence(journal)

        const failure = importTaskUpgrade({ taskId: "task-1", persistence: stores.assembly, apiHistory })

        await expect(failure).rejects.toBeInstanceOf(ApiHistoryImportError)
        await expect(failure).rejects.toMatchObject({ taskId: "task-1", cause: new Error("journal.db is read-only") })
        expect(snapshotQueue.read).not.toHaveBeenCalled()
        expect(await stores.vault.load("task-1")).toBeUndefined()
    })

    it("reports pending work without writing either store", async () => {
        const stores = persistence()
        const append = vi.spyOn(stores.journal, "append")
        const save = vi.spyOn(stores.vault, "save")

        await expect(taskUpgradeImportPending({ taskId: "task-1", persistence: stores.assembly, apiHistory })).resolves.toBe(true)
        await expect(taskUpgradeImportPending({ taskId: "task-1", persistence: stores.assembly, apiHistory: [] })).resolves.toBe(
            false,
        )
        snapshotQueue.read.mockResolvedValue({ fingerprint: "sha256:queue", entries: [] })
        await expect(taskUpgradeImportPending({ taskId: "task-1", persistence: stores.assembly, apiHistory: [] })).resolves.toBe(
            true,
        )
        snapshotQueue.read.mockRejectedValue(new Error("snapshot.json is unreadable"))
        await expect(taskUpgradeImportPending({ taskId: "task-1", persistence: stores.assembly, apiHistory: [] })).resolves.toBe(
            true,
        )

        expect(append).not.toHaveBeenCalled()
        expect(save).not.toHaveBeenCalled()
    })

    it("reports nothing pending once the conversation is fully imported", async () => {
        const stores = persistence()
        await importTaskUpgrade({ taskId: "task-1", persistence: stores.assembly, apiHistory })

        await expect(taskUpgradeImportPending({ taskId: "task-1", persistence: stores.assembly, apiHistory })).resolves.toBe(
            false,
        )
    })

    it("ignores a completed compaction card whose canonical range is invalid", async () => {
        const stores = persistence()
        const uiMessages: UiMessage[] = [
            {
                ts: 10,
                type: "say",
                say: "tool",
                text: JSON.stringify({ tool: "summarizeTask", content: "invalid summary", compactionStatus: "completed" }),
                compactionConversationRange: {
                    logicalTurnRange: [0, 0],
                    apiConversationRange: [0, apiHistory.length],
                    preCompactionApiEndIndex: apiHistory.length,
                },
            },
        ]

        await importTaskUpgrade({ taskId: "task-1", persistence: stores.assembly, apiHistory, uiMessages })

        const view = new JournalConversationView(stores.journal, new ProviderJournalMessageMaterializer(stores.payloads))
        expect(await view.messages()).toEqual(apiHistory)
        await expect(
            taskUpgradeImportPending({ taskId: "task-1", persistence: stores.assembly, apiHistory, uiMessages }),
        ).resolves.toBe(false)
    })

    it("normalizes a legacy deleted range with the same bounds as the canonical projection", async () => {
        const stores = persistence()

        await importTaskUpgrade({
            taskId: "task-1",
            persistence: stores.assembly,
            apiHistory,
            conversationHistoryDeletedRange: [1, apiHistory.length],
        })

        const view = new JournalConversationView(stores.journal, new ProviderJournalMessageMaterializer(stores.payloads))
        expect(await view.messages()).toEqual([apiHistory[0]])
        await expect(
            taskUpgradeImportPending({
                taskId: "task-1",
                persistence: stores.assembly,
                apiHistory,
                conversationHistoryDeletedRange: [1, apiHistory.length],
            }),
        ).resolves.toBe(false)
    })

    it("treats an empty legacy deleted range as no-op instead of blocking the task", async () => {
        const stores = persistence()

        await importTaskUpgrade({
            taskId: "task-1",
            persistence: stores.assembly,
            apiHistory,
            conversationHistoryDeletedRange: [1, 0],
        })

        const view = new JournalConversationView(stores.journal, new ProviderJournalMessageMaterializer(stores.payloads))
        expect(await view.messages()).toEqual(apiHistory)
    })

    it("migrates a completed legacy compaction card into one canonical journal replacement", async () => {
        const stores = persistence()
        const summary = "legacy summary"
        const uiMessages: UiMessage[] = [
            {
                ts: 10,
                type: "say",
                say: "tool",
                text: JSON.stringify({ tool: "summarizeTask", content: summary, compactionStatus: "completed" }),
                compactionConversationRange: {
                    logicalTurnRange: [0, 0],
                    apiConversationRange: [0, 1],
                    preCompactionApiEndIndex: 1,
                },
            },
        ]

        await importTaskUpgrade({ taskId: "task-1", persistence: stores.assembly, apiHistory, uiMessages })
        const view = new JournalConversationView(stores.journal, new ProviderJournalMessageMaterializer(stores.payloads))
        const migrated = JSON.stringify(await view.messages())
        expect(migrated).toContain(summary)
        expect(migrated).toContain("<previous_task_compaction_summary>")
        expect(migrated).not.toContain("<task>fix it</task>")
        expect(migrated).not.toContain("done")
        expect(stores.journal.watermark()).toEqual({ seq: 4 })

        await importTaskUpgrade({ taskId: "task-1", persistence: stores.assembly, apiHistory, uiMessages })
        expect(stores.journal.watermark()).toEqual({ seq: 4 })
    })

    it("reapplies surviving legacy range facts after a later conversation rewind", async () => {
        const stores = persistence()
        const history: ClineStorageMessage[] = [
            ...apiHistory,
            { role: "user", content: [{ type: "text", text: "kept follow-up" }], ts: 3 },
            { role: "assistant", content: [{ type: "text", text: "kept answer" }], ts: 4 },
        ]
        const uiMessages: UiMessage[] = [
            {
                ts: 10,
                type: "say",
                say: "tool",
                text: JSON.stringify({ tool: "summarizeTask", content: "legacy summary", compactionStatus: "completed" }),
                compactionConversationRange: {
                    logicalTurnRange: [0, 0],
                    apiConversationRange: [0, 1],
                    preCompactionApiEndIndex: 3,
                },
            },
        ]
        const view = new JournalConversationView(stores.journal, new ProviderJournalMessageMaterializer(stores.payloads))

        await importTaskUpgrade({ taskId: "task-1", persistence: stores.assembly, apiHistory: history, uiMessages })
        await stores.journal.rewind({ operationId: "checkpoint.restore:after-summary", target: { seq: 4 } })
        expect(JSON.stringify(await view.messages())).toContain("<task>fix it</task>")

        await importTaskUpgrade({ taskId: "task-1", persistence: stores.assembly, apiHistory: history, uiMessages })

        const restored = JSON.stringify(await view.messages())
        expect(restored).toContain("legacy summary")
        expect(restored).toContain("kept follow-up")
        expect(restored).not.toContain("<task>fix it</task>")
    })

    it("does not replay a card whose endpoint was removed by the rewind", async () => {
        const stores = persistence()
        const history: ClineStorageMessage[] = [
            ...apiHistory,
            { role: "user", content: [{ type: "text", text: "later input" }], ts: 3 },
            { role: "assistant", content: [{ type: "text", text: "later answer" }], ts: 4 },
        ]
        const uiMessages: UiMessage[] = [
            {
                ts: 10,
                type: "say",
                say: "tool",
                text: JSON.stringify({ tool: "summarizeTask", content: "removed summary", compactionStatus: "completed" }),
                compactionConversationRange: {
                    logicalTurnRange: [0, 0],
                    apiConversationRange: [0, 1],
                    preCompactionApiEndIndex: 3,
                },
            },
        ]
        await importTaskUpgrade({ taskId: "task-1", persistence: stores.assembly, apiHistory: history, uiMessages })
        await stores.journal.rewind({ operationId: "checkpoint.restore:inside-card", target: { seq: 1 } })
        const beforeReopen = stores.journal.watermark()

        await importTaskUpgrade({ taskId: "task-1", persistence: stores.assembly, apiHistory: history, uiMessages })

        expect(stores.journal.watermark()).toEqual(beforeReopen)
        await expect(stores.journal.project()).resolves.toMatchObject({
            visibleMessages: [expect.objectContaining({ operationId: "api-history:0" })],
        })
        await expect(
            taskUpgradeImportPending({ taskId: "task-1", persistence: stores.assembly, apiHistory: history, uiMessages }),
        ).resolves.toBe(false)
    })

    it("does not replay legacy facts when the rewind target already retains a repair generation", async () => {
        const stores = persistence()
        const history: ClineStorageMessage[] = [
            ...apiHistory,
            { role: "user", content: [{ type: "text", text: "kept input" }], ts: 3 },
            { role: "assistant", content: [{ type: "text", text: "kept answer" }], ts: 4 },
        ]
        const uiMessages: UiMessage[] = [
            {
                ts: 10,
                type: "say",
                say: "tool",
                text: JSON.stringify({ tool: "summarizeTask", content: "retained summary", compactionStatus: "completed" }),
                compactionConversationRange: {
                    logicalTurnRange: [0, 0],
                    apiConversationRange: [0, 1],
                    preCompactionApiEndIndex: 3,
                },
            },
        ]
        await importTaskUpgrade({ taskId: "task-1", persistence: stores.assembly, apiHistory: history, uiMessages })
        const repairTail = stores.journal.watermark()
        const [first] = await stores.journal.read()
        if (!first?.payloadRef) throw new Error("expected imported payload")
        await stores.journal.append({ operationId: "runtime:after-repair", payloadRef: first.payloadRef, source: "intake" })
        await stores.journal.rewind({ operationId: "checkpoint.restore:after-repair", target: repairTail })
        const beforeReopen = stores.journal.watermark()

        await importTaskUpgrade({ taskId: "task-1", persistence: stores.assembly, apiHistory: history, uiMessages })

        expect(stores.journal.watermark()).toEqual(beforeReopen)
        const visible = JSON.stringify(
            await new JournalConversationView(stores.journal, new ProviderJournalMessageMaterializer(stores.payloads)).messages(),
        )
        expect(visible).toContain("retained summary")
        expect(visible).not.toContain("<task>fix it</task>")
    })

    it("retains a runtime summary when the rewind target includes a completed repair generation", async () => {
        const stores = persistence()
        const history: ClineStorageMessage[] = [
            ...apiHistory,
            { role: "user", content: [{ type: "text", text: "kept input" }], ts: 3 },
            { role: "assistant", content: [{ type: "text", text: "kept answer" }], ts: 4 },
        ]
        const uiMessages: UiMessage[] = [
            {
                ts: 10,
                type: "say",
                say: "tool",
                text: JSON.stringify({ tool: "summarizeTask", content: "legacy summary", compactionStatus: "completed" }),
                compactionConversationRange: {
                    logicalTurnRange: [0, 0],
                    apiConversationRange: [0, 1],
                    preCompactionApiEndIndex: 3,
                },
            },
        ]
        const view = new JournalConversationView(stores.journal, new ProviderJournalMessageMaterializer(stores.payloads))
        await importTaskUpgrade({ taskId: "task-1", persistence: stores.assembly, apiHistory: history, uiMessages })
        const runtimeSummaryRef = await stores.payloads.put(
            encodeTaskPayload({ kind: "compaction_summary", compactionId: "runtime-summary", text: "runtime summary" }),
        )
        await stores.journal.supersedeRange({
            operationId: "runtime.compaction.supersede",
            from: { seq: 1 },
            to: { seq: 4 },
            replacementRef: runtimeSummaryRef,
        })
        const runtimeSummaryTail = stores.journal.watermark()
        const [first] = await stores.journal.read()
        if (!first?.payloadRef) throw new Error("expected imported payload")
        await stores.journal.append({ operationId: "runtime:after-summary", payloadRef: first.payloadRef, source: "intake" })
        await stores.journal.rewind({ operationId: "checkpoint.restore:runtime-row", target: runtimeSummaryTail })
        const beforeReopen = stores.journal.watermark()

        await importTaskUpgrade({ taskId: "task-1", persistence: stores.assembly, apiHistory: history, uiMessages })

        expect(stores.journal.watermark()).toEqual(beforeReopen)
        const visible = JSON.stringify(await view.messages())
        expect(visible).toContain("runtime summary")
        expect(visible).not.toContain("legacy summary")
    })

    it("ignores empty summaries and invalid pre-compaction boundaries instead of hiding history", async () => {
        const stores = persistence()
        const uiMessages: UiMessage[] = [
            {
                ts: 10,
                type: "say",
                say: "tool",
                text: JSON.stringify({ tool: "summarizeTask", content: "   ", compactionStatus: "completed" }),
                compactionConversationRange: {
                    logicalTurnRange: [0, 0],
                    apiConversationRange: [0, 1],
                    preCompactionApiEndIndex: 1,
                },
            },
            {
                ts: 11,
                type: "say",
                say: "tool",
                text: JSON.stringify({ tool: "summarizeTask", content: "invalid boundary", compactionStatus: "completed" }),
                compactionConversationRange: {
                    logicalTurnRange: [0, 0],
                    apiConversationRange: [0, 1],
                    preCompactionApiEndIndex: 0,
                },
            },
        ]

        await importTaskUpgrade({ taskId: "task-1", persistence: stores.assembly, apiHistory, uiMessages })

        const view = new JournalConversationView(stores.journal, new ProviderJournalMessageMaterializer(stores.payloads))
        expect(await view.messages()).toEqual(apiHistory)
    })

    it("keeps a compaction replacement while subtracting its overlap from the deleted range", async () => {
        const stores = persistence()
        const history: ClineStorageMessage[] = [
            { role: "user", content: [{ type: "text", text: "delete-left" }], ts: 1 },
            { role: "assistant", content: [{ type: "text", text: "covered-one" }], ts: 2 },
            { role: "user", content: [{ type: "text", text: "covered-two" }], ts: 3 },
            { role: "assistant", content: [{ type: "text", text: "delete-right-one" }], ts: 4 },
            { role: "user", content: [{ type: "text", text: "delete-right-two" }], ts: 5 },
            { role: "assistant", content: [{ type: "text", text: "survives" }], ts: 6 },
        ]
        const uiMessages: UiMessage[] = [
            {
                ts: 10,
                type: "say",
                say: "tool",
                text: JSON.stringify({ tool: "summarizeTask", content: "overlap summary", compactionStatus: "completed" }),
                compactionConversationRange: {
                    logicalTurnRange: [0, 0],
                    apiConversationRange: [1, 2],
                    preCompactionApiEndIndex: 5,
                },
            },
        ]

        await importTaskUpgrade({
            taskId: "task-1",
            persistence: stores.assembly,
            apiHistory: history,
            uiMessages,
            conversationHistoryDeletedRange: [0, 4],
        })

        const view = new JournalConversationView(stores.journal, new ProviderJournalMessageMaterializer(stores.payloads))
        const migrated = JSON.stringify(await view.messages())
        expect(migrated).toContain("overlap summary")
        expect(migrated).toContain("survives")
        for (const hidden of ["delete-left", "covered-one", "covered-two", "delete-right-one", "delete-right-two"]) {
            expect(migrated).not.toContain(hidden)
        }
    })

    it("resumes a partial multi-card repair without duplicating completed operations", async () => {
        const stores = persistence()
        const history: ClineStorageMessage[] = [
            ...apiHistory,
            { role: "user", content: [{ type: "text", text: "third" }], ts: 3 },
            { role: "assistant", content: [{ type: "text", text: "fourth" }], ts: 4 },
        ]
        const uiMessages: UiMessage[] = [
            {
                ts: 10,
                type: "say",
                say: "tool",
                text: JSON.stringify({ tool: "summarizeTask", content: "first summary", compactionStatus: "completed" }),
                compactionConversationRange: {
                    logicalTurnRange: [0, 0],
                    apiConversationRange: [0, 0],
                    preCompactionApiEndIndex: 3,
                },
            },
            {
                ts: 11,
                type: "say",
                say: "tool",
                text: JSON.stringify({ tool: "summarizeTask", content: "second summary", compactionStatus: "completed" }),
                compactionConversationRange: {
                    logicalTurnRange: [1, 1],
                    apiConversationRange: [2, 2],
                    preCompactionApiEndIndex: 3,
                },
            },
        ]
        const originalSupersede = stores.journal.supersedeRange.bind(stores.journal)
        let failed = false
        vi.spyOn(stores.journal, "supersedeRange").mockImplementation(async (input) => {
            if (!failed && input.operationId.startsWith("legacy.compaction.supersede:2:2")) {
                failed = true
                throw new Error("simulated repair crash")
            }
            return originalSupersede(input)
        })

        await expect(
            importTaskUpgrade({ taskId: "task-1", persistence: stores.assembly, apiHistory: history, uiMessages }),
        ).rejects.toThrow("simulated repair crash")
        await importTaskUpgrade({ taskId: "task-1", persistence: stores.assembly, apiHistory: history, uiMessages })

        const operations = (await stores.journal.read()).map((entry) => entry.operationId)
        expect(operations.filter((operation) => operation === "legacy.compaction.supersede:0:0")).toHaveLength(1)
        expect(operations.filter((operation) => operation === "legacy.compaction.supersede:2:2")).toHaveLength(1)
        expect(operations.filter((operation) => operation === "legacy.compaction.migration:v1")).toHaveLength(1)
    })

    it("does not apply a legacy repair after runtime entries have advanced and rewound the journal", async () => {
        const stores = persistence()
        await importApiHistory({ journal: stores.journal, payloads: stores.payloads, history: apiHistory })
        const [first] = await stores.journal.read()
        if (!first?.payloadRef) throw new Error("expected imported payload")
        await stores.journal.append({ operationId: "runtime:input", payloadRef: first.payloadRef, source: "intake" })
        await stores.journal.rewind({ operationId: "runtime:rewind", target: { seq: 0 } })
        const beforeRepair = stores.journal.watermark()
        const uiMessages: UiMessage[] = [
            {
                ts: 10,
                type: "say",
                say: "tool",
                text: JSON.stringify({ tool: "summarizeTask", content: "late legacy summary", compactionStatus: "completed" }),
                compactionConversationRange: {
                    logicalTurnRange: [0, 0],
                    apiConversationRange: [0, 1],
                    preCompactionApiEndIndex: 1,
                },
            },
        ]

        await importTaskUpgrade({ taskId: "task-1", persistence: stores.assembly, apiHistory, uiMessages })

        expect(stores.journal.watermark()).toEqual(beforeRepair)
        await expect(stores.journal.project()).resolves.toMatchObject({ visibleMessages: [] })
        await expect(
            taskUpgradeImportPending({ taskId: "task-1", persistence: stores.assembly, apiHistory, uiMessages }),
        ).resolves.toBe(false)
    })
})

import type { UiMessage } from "@shared/ExtensionMessage"
import type { ClineStorageMessage } from "@shared/messages/content"
import { afterEach, describe, expect, it, vi } from "vitest"
import { JournalConversationView } from "../executors/provider/service/JournalConversationView"
import { ProviderJournalMessageMaterializer } from "../executors/provider/service/ProviderJournalMessageMaterializer"
import { hydrate } from "../kernel"
import type { TaskPersistenceAssembly } from "../shell/TaskPersistenceAssembly"
import { InMemoryConversationJournal, InMemoryStateVault, InMemoryTaskPayloadStore } from "../stores"
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

    it("refuses an out-of-bounds completed compaction range without marking the repair complete", async () => {
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

        await expect(
            importTaskUpgrade({ taskId: "task-1", persistence: stores.assembly, apiHistory, uiMessages }),
        ).rejects.toThrow(`LegacyCompactionRangeInvalid:0:${apiHistory.length}`)
        await expect(
            taskUpgradeImportPending({ taskId: "task-1", persistence: stores.assembly, apiHistory, uiMessages }),
        ).resolves.toBe(true)
    })

    it("refuses an invalid deleted range without marking the repair complete", async () => {
        const stores = persistence()

        await expect(
            importTaskUpgrade({
                taskId: "task-1",
                persistence: stores.assembly,
                apiHistory,
                conversationHistoryDeletedRange: [1, apiHistory.length],
            }),
        ).rejects.toThrow(`LegacyTruncationRangeInvalid:1:${apiHistory.length}`)
        await expect(
            taskUpgradeImportPending({
                taskId: "task-1",
                persistence: stores.assembly,
                apiHistory,
                conversationHistoryDeletedRange: [1, apiHistory.length],
            }),
        ).resolves.toBe(true)
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
        expect(migrated).not.toContain("<task>fix it</task>")
        expect(migrated).not.toContain("done")
        expect(stores.journal.watermark()).toEqual({ seq: 4 })

        await importTaskUpgrade({ taskId: "task-1", persistence: stores.assembly, apiHistory, uiMessages })
        expect(stores.journal.watermark()).toEqual({ seq: 4 })
    })
})

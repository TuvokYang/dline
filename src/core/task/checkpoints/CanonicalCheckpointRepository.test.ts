import { describe, expect, it, vi } from "vitest"
import { createInitialTaskState } from "../kernel"
import { InMemoryConversationJournal, InMemoryStateVault, InMemoryTaskPayloadStore, type TaskPayloadStore } from "../stores"
import { encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import { CanonicalCheckpointRepository, canonicalCheckpointRef } from "./CanonicalCheckpointRepository"

async function fixture() {
    const taskId = "task-1"
    const vault = new InMemoryStateVault()
    const journal = new InMemoryConversationJournal()
    const payloads = new InMemoryTaskPayloadStore()
    await journal.append({ operationId: "message:1", payloadRef: "message:1", source: "system" })
    await journal.append({ operationId: "message:2", payloadRef: "message:2", source: "system" })
    const snapshot = {
        state: {
            ...createInitialTaskState(taskId),
            revision: 4,
            journalWatermark: { seq: 2 },
        },
        outbox: [],
    }
    await vault.save(snapshot)
    return {
        taskId,
        vault,
        journal,
        payloads,
        snapshot,
        repository: new CanonicalCheckpointRepository({ taskId, vault, journal, payloads }),
    }
}

describe("CanonicalCheckpointRepository", () => {
    it("commits a complete state/outbox bundle behind a journal marker", async () => {
        const subject = await fixture()
        const checkpointRef = canonicalCheckpointRef(subject.taskId, 42)

        await expect(subject.repository.capture({ checkpointRef, workspaceRef: "workspace:hash-1" })).resolves.toEqual({
            snapshot: subject.snapshot,
            boundary: { seq: 2 },
            workspaceRef: "workspace:hash-1",
        })

        const marker = await subject.journal.findByOperation(`checkpoint.capture:${checkpointRef}`)
        expect(marker).toMatchObject({ kind: "checkpoint_marker", watermark: { seq: 3 } })
        expect(marker?.payloadRef).toMatch(/^sha256:[a-f0-9]{64}$/)
        await expect(subject.repository.resolve(checkpointRef)).resolves.toEqual({
            snapshot: subject.snapshot,
            boundary: { seq: 2 },
            workspaceRef: "workspace:hash-1",
        })
    })

    it("resolves the current task at an earlier journal position without a captured bundle", async () => {
        const subject = await fixture()

        await expect(subject.repository.resolveAt({ seq: 1 })).resolves.toEqual({
            snapshot: subject.snapshot,
            boundary: { seq: 1 },
        })
    })

    it("refuses a position the journal has not reached", async () => {
        const subject = await fixture()

        await expect(subject.repository.resolveAt({ seq: 3 })).rejects.toThrow("CanonicalCheckpointBoundaryAhead")
        await expect(subject.repository.resolveAt({ seq: -1 })).rejects.toThrow("InvalidCanonicalCheckpointBoundary")
    })

    it("does not expose a marker when payload persistence fails", async () => {
        const subject = await fixture()
        const failure = new Error("payload write failed")
        const payloads: TaskPayloadStore = {
            put: vi.fn(async () => {
                throw failure
            }),
            read: (payloadRef) => subject.payloads.read(payloadRef),
        }
        const repository = new CanonicalCheckpointRepository({
            taskId: subject.taskId,
            vault: subject.vault,
            journal: subject.journal,
            payloads,
        })
        const checkpointRef = canonicalCheckpointRef(subject.taskId, 42)

        await expect(repository.capture({ checkpointRef })).rejects.toBe(failure)
        await expect(subject.journal.findByOperation(`checkpoint.capture:${checkpointRef}`)).resolves.toBeUndefined()
    })

    it("treats the first committed checkpoint identity as immutable", async () => {
        const subject = await fixture()
        const checkpointRef = canonicalCheckpointRef(subject.taskId, 42)
        await subject.repository.capture({ checkpointRef, workspaceRef: "workspace:hash-1" })
        await subject.vault.save({
            state: { ...subject.snapshot.state, revision: 9 },
            outbox: [],
        })

        await expect(subject.repository.capture({ checkpointRef, workspaceRef: "workspace:hash-1" })).resolves.toEqual({
            snapshot: subject.snapshot,
            boundary: { seq: 2 },
            workspaceRef: "workspace:hash-1",
        })
        await expect(subject.repository.capture({ checkpointRef, workspaceRef: "workspace:other" })).rejects.toThrow(
            "CanonicalCheckpointWorkspaceConflict",
        )
        expect((await subject.journal.read()).filter((entry) => entry.kind === "checkpoint_marker")).toHaveLength(1)
    })

    it("rejects an invalid bundle without mutating the journal", async () => {
        const subject = await fixture()
        const checkpointRef = canonicalCheckpointRef(subject.taskId, 42)
        const invalidRef = await subject.payloads.put(encodeTaskPayload({ version: 2, taskId: subject.taskId }))
        await subject.journal.checkpointMarker({
            operationId: `checkpoint.capture:${checkpointRef}`,
            checkpointRef: invalidRef,
        })
        const tail = subject.journal.watermark()

        await expect(subject.repository.resolve(checkpointRef)).rejects.toThrow("InvalidCanonicalCheckpointBundle")
        expect(subject.journal.watermark()).toEqual(tail)
    })

    it("does not commit a checkpoint whose state references a missing payload", async () => {
        const subject = await fixture()
        const checkpointRef = canonicalCheckpointRef(subject.taskId, 42)
        const missingRef = `sha256:${"a".repeat(64)}`
        await subject.vault.save({
            state: {
                ...subject.snapshot.state,
                intake: {
                    ...subject.snapshot.state.intake,
                    queued: [
                        {
                            entryId: "queued-1",
                            payloadRef: missingRef,
                            source: "user",
                            mode: "queued",
                            sequence: 0,
                            state: "accepted",
                        },
                    ],
                },
            },
            outbox: [],
        })

        await expect(subject.repository.capture({ checkpointRef })).rejects.toThrow(
            `CanonicalCheckpointPayloadMissing:${missingRef}`,
        )
        await expect(subject.journal.findByOperation(`checkpoint.capture:${checkpointRef}`)).resolves.toBeUndefined()
    })

    it("refuses a snapshot whose boundary is ahead of the durable journal", async () => {
        const subject = await fixture()
        await subject.vault.save({
            state: { ...subject.snapshot.state, journalWatermark: { seq: 9 } },
            outbox: [],
        })

        await expect(subject.repository.capture({ checkpointRef: canonicalCheckpointRef(subject.taskId, 42) })).rejects.toThrow(
            "CanonicalCheckpointBoundaryAhead",
        )
    })
})

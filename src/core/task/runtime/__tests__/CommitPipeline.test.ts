import { describe, expect, it, vi } from "vitest"
import { createInitialTaskState, type TaskState } from "../../kernel"
import type { DurableTaskSnapshot, StateVault, TaskViewPort } from "../../stores/contracts"
import { CommitPipeline } from "../CommitPipeline"
import type { RuntimeDiagnostic } from "../contracts"
import { deferred } from "../deferred"

function state(revision: number): TaskState {
    return { ...createInitialTaskState("task-1"), revision }
}

class ControlledVault implements StateVault {
    readonly saved: number[] = []
    readonly gates: ReturnType<typeof deferred<void>>[] = []
    failNext: Error | undefined

    async load(): Promise<DurableTaskSnapshot | undefined> {
        return undefined
    }

    async save(snapshot: DurableTaskSnapshot): Promise<void> {
        const gate = deferred<void>()
        this.gates.push(gate)
        await gate.promise
        if (this.failNext) throw this.failNext
        this.saved.push(snapshot.state.revision)
    }

    release(): void {
        this.gates.shift()?.resolve()
    }
}

function view(notify: (state: TaskState) => Promise<void> = async () => undefined): TaskViewPort & { seen: number[] } {
    const seen: number[] = []
    return {
        seen,
        notifyCommitted: async (committed) => {
            seen.push(committed.revision)
            await notify(committed)
        },
        notifyTransient: () => undefined,
    }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

describe("CommitPipeline", () => {
    it("writes only the newest snapshot of commits made while a write is in flight", async () => {
        const vault = new ControlledVault()
        const pipeline = new CommitPipeline(vault, view())
        const first = pipeline.commit(state(1), [])
        await settle()
        const second = pipeline.commit(state(2), [])
        const third = pipeline.commit(state(3), [])

        vault.release()
        await first.durable
        await settle()
        vault.release()
        await Promise.all([second.durable, third.durable])

        expect(vault.saved).toEqual([1, 3])
        expect(vault.gates).toHaveLength(0)
    })

    it("reports durability without waiting for the view", async () => {
        const vault = new ControlledVault()
        const blocked = deferred<void>()
        const taskView = view(() => blocked.promise)
        const pipeline = new CommitPipeline(vault, taskView)
        const receipt = pipeline.commit(state(1), [])
        await settle()
        vault.release()

        await receipt.durable
        await pipeline.flushThrough(1)
        expect(taskView.seen).toEqual([1])

        const flushed = vi.fn()
        const all = pipeline.flushAll().then(flushed)
        await settle()
        // A full flush also drains the view, so quiescence still means "shown".
        expect(flushed).not.toHaveBeenCalled()
        blocked.resolve()
        await all
        expect(flushed).toHaveBeenCalled()
    })

    it("notifies the view of every committed revision in order", async () => {
        const vault = new ControlledVault()
        const taskView = view()
        const pipeline = new CommitPipeline(vault, taskView)
        pipeline.commit(state(1), [])
        await settle()
        pipeline.commit(state(2), [])
        pipeline.commit(state(3), [])
        vault.release()
        await settle()
        vault.release()
        await pipeline.flushAll()

        expect(taskView.seen).toEqual([1, 2, 3])
    })

    it("records a failing view as a diagnostic and keeps committing", async () => {
        const vault = new ControlledVault()
        const diagnostics: RuntimeDiagnostic[] = []
        const pipeline = new CommitPipeline(
            vault,
            view(async (committed) => {
                if (committed.revision === 1) throw new Error("webview gone")
            }),
            { record: (entry) => diagnostics.push(entry) },
        )
        const first = pipeline.commit(state(1), [])
        await settle()
        vault.release()
        await first.durable
        const second = pipeline.commit(state(2), [])
        await settle()
        vault.release()

        await expect(second.durable).resolves.toBeUndefined()
        await pipeline.flushAll()
        expect(pipeline.failed).toBe(false)
        expect(diagnostics).toEqual([
            expect.objectContaining({ source: "commit", code: "view_publish_failed", revision: 1, message: "webview gone" }),
        ])
    })

    it("keeps the durable frontier valid below a later failed revision", async () => {
        const vault = new ControlledVault()
        const pipeline = new CommitPipeline(vault, view())
        const first = pipeline.commit(state(1), [])
        await settle()
        vault.release()
        await first.durable

        vault.failNext = new Error("disk full")
        const second = pipeline.commit(state(2), [])
        await settle()
        vault.release()
        await expect(second.durable).rejects.toThrow("disk full")

        await expect(pipeline.flushThrough(1)).resolves.toBeUndefined()
        await expect(pipeline.flushThrough(2)).rejects.toThrow("disk full")
    })

    it("fails the batch and every later commit once a write fails", async () => {
        const vault = new ControlledVault()
        const diagnostics: RuntimeDiagnostic[] = []
        const taskView = view()
        const pipeline = new CommitPipeline(vault, taskView, { record: (entry) => diagnostics.push(entry) })
        vault.failNext = new Error("disk full")
        const first = pipeline.commit(state(1), [])
        await settle()
        vault.release()

        await expect(first.durable).rejects.toThrow("disk full")
        await expect(pipeline.flushThrough(1)).rejects.toThrow("disk full")
        await expect(pipeline.flushAll()).rejects.toThrow("disk full")
        expect(() => pipeline.commit(state(2), [])).toThrow("disk full")
        expect(pipeline.failed).toBe(true)
        expect(vault.gates).toHaveLength(0)
        expect(taskView.seen).toEqual([])
        expect(diagnostics.map((entry) => [entry.code, entry.revision])).toEqual([["durability_failed", 1]])
    })
})

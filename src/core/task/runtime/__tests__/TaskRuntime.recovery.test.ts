import { describe, expect, it } from "vitest"
import { createInitialTaskState } from "../../kernel"
import type { CommandPublicationStore, DurableTaskSnapshot, StateVault, TaskViewPort } from "../../stores/contracts"
import { TaskRuntime } from "../TaskRuntime"

class RecoveringVault implements StateVault {
    readonly saved: number[] = []
    private failNext = true

    async load(): Promise<DurableTaskSnapshot | undefined> {
        return undefined
    }

    async save(snapshot: DurableTaskSnapshot): Promise<void> {
        if (this.failNext) {
            this.failNext = false
            throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" })
        }
        this.saved.push(snapshot.state.revision)
    }
}

const view: TaskViewPort = {
    notifyCommitted: async () => undefined,
    notifyTransient: () => undefined,
}

const publications: CommandPublicationStore = {
    has: async () => false,
    mark: async () => undefined,
}

describe("TaskRuntime durability recovery", () => {
    it("retries the failed snapshot before accepting the next event", async () => {
        const vault = new RecoveringVault()
        const runtime = new TaskRuntime({
            initialState: createInitialTaskState("task-recovery"),
            vault,
            taskView: view,
            publications,
            executors: [],
        })

        const first = await runtime.submit({
            type: "user.submit",
            generation: 0,
            entryId: "first",
            payloadRef: "payload:first",
        })
        if (first.kind !== "accepted") throw new Error("expected the first event to be accepted")
        await expect(first.receipt.durable).rejects.toThrow("ENOSPC")

        const second = await runtime.submit({
            type: "background.ready",
            generation: 0,
            entryId: "second",
            payloadRef: "payload:second",
        })
        if (second.kind !== "accepted") throw new Error("expected the second event to be accepted after recovery")
        await expect(second.receipt.durable).resolves.toBeUndefined()

        expect(vault.saved).toEqual([1, 2])
        expect(runtime.getState()).toMatchObject({ revision: 2 })
    })
})

import { describe, expect, it, vi } from "vitest"
import { RoundCheckpointLedger } from "../RoundCheckpointLedger"
import type { TaskConfig } from "../types/TaskConfig"

type Callbacks = TaskConfig["callbacks"]

describe("RoundCheckpointLedger", () => {
    it("commits one restore point for a round that owes several", async () => {
        const commit = vi.fn(async () => {})
        const ledger = new RoundCheckpointLedger(commit)

        ledger.markOwed()
        ledger.markOwed()
        ledger.markOwed()
        await ledger.settle()
        await ledger.settle()

        expect(commit).toHaveBeenCalledOnce()
        expect(ledger.hasOwed).toBe(false)
    })

    it("commits nothing for a round that changed nothing", async () => {
        const commit = vi.fn(async () => {})
        const ledger = new RoundCheckpointLedger(commit)

        await ledger.settle()

        expect(commit).not.toHaveBeenCalled()
    })

    it("treats a later commit as settling what the round owed", async () => {
        const settleCommit = vi.fn(async () => {})
        const ledger = new RoundCheckpointLedger(settleCommit)
        const fileEditCommit = vi.fn(async () => {})

        ledger.markOwed()
        await ledger.commit(fileEditCommit)
        await ledger.settle()

        expect(fileEditCommit).toHaveBeenCalledOnce()
        expect(settleCommit).not.toHaveBeenCalled()
    })

    it("keeps an effect recorded during a commit owed for the next settle", async () => {
        let release: (() => void) | undefined
        const settleCommit = vi.fn(async () => {})
        const ledger = new RoundCheckpointLedger(settleCommit)

        const inFlight = ledger.commit(() => new Promise<void>((resolve) => (release = resolve)))
        await vi.waitFor(() => expect(release).toBeTypeOf("function"))
        // The snapshot is already being taken, so this effect may be missing from it.
        ledger.markOwed()
        release?.()
        await inFlight
        await ledger.settle()

        expect(settleCommit).toHaveBeenCalledOnce()
    })

    it("runs commits one at a time in call order", async () => {
        const order: string[] = []
        let release!: () => void
        const ledger = new RoundCheckpointLedger(async () => {
            order.push("settle")
        })

        const first = ledger.commit(
            () =>
                new Promise<void>((resolve) => {
                    order.push("edit:start")
                    release = () => {
                        order.push("edit:end")
                        resolve()
                    }
                }),
        )
        ledger.markOwed()
        const settled = ledger.settle()
        await Promise.resolve()
        release()
        await Promise.all([first, settled])

        expect(order).toEqual(["edit:start", "edit:end", "settle"])
    })

    it("keeps settling after a failed commit", async () => {
        const settleCommit = vi.fn(async () => {})
        const ledger = new RoundCheckpointLedger(settleCommit)

        await expect(ledger.commit(async () => Promise.reject(new Error("shadow git unavailable")))).rejects.toThrow()
        ledger.markOwed()
        await ledger.settle()

        expect(settleCommit).toHaveBeenCalledOnce()
    })

    describe("bind", () => {
        it("routes every checkpoint commit through the ledger and exposes the deferral", async () => {
            const saveCheckpoint = vi.fn(async () => {})
            const ledger = new RoundCheckpointLedger(() => saveCheckpoint())
            const bound = ledger.bind({ saveCheckpoint } as unknown as Callbacks)

            bound.deferCheckpoint?.()
            expect(ledger.hasOwed).toBe(true)
            // attempt_completion commits its own restore point, which covers the round.
            await bound.saveCheckpoint?.(true, 42)
            await ledger.settle()

            expect(saveCheckpoint).toHaveBeenCalledOnce()
            expect(saveCheckpoint).toHaveBeenCalledWith(true, 42)
        })

        it("leaves a surface without workspace history untouched", () => {
            const ledger = new RoundCheckpointLedger(async () => {})
            const callbacks = { say: vi.fn() } as unknown as Callbacks

            const bound = ledger.bind(callbacks)

            expect(bound).toBe(callbacks)
            expect(bound.deferCheckpoint).toBeUndefined()
        })
    })
})

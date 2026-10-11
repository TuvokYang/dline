import { describe, expect, it } from "vitest"
import { CONTEXT_BUDGET_YIELD_TOKENS, ContextBudgetLedger, type ContextBudgetReadings } from "../context-budget-ledger"

function readings(overrides: Partial<{ window: number; occupied: number; tokenPerByte: number }> = {}) {
    const state = { window: 100_000, occupied: 0, tokenPerByte: 0.25, ...overrides }
    const port: ContextBudgetReadings = {
        contextWindow: () => state.window,
        occupiedTokens: () => state.occupied,
        tokenPerByte: () => state.tokenPerByte,
    }
    return { state, port }
}

describe("ContextBudgetLedger", () => {
    it("budgets one round's tool results at 80% of the context left when the round starts", () => {
        const { port } = readings({ occupied: 30_000 })
        const snapshot = new ContextBudgetLedger(port).snapshot()

        expect(snapshot).toMatchObject({
            contextWindowTokens: 100_000,
            remainingTokens: 70_000,
            roundBudgetTokens: 56_000,
            roundStagedTokens: 0,
            shareTokens: 56_000,
            mustYield: false,
        })
    })

    it("never caps the conversation itself: what remains is measured to the window", () => {
        const { port } = readings({ occupied: 90_000 })
        const snapshot = new ContextBudgetLedger(port).snapshot()

        expect(snapshot.remainingTokens).toBe(10_000)
        expect(snapshot.roundBudgetTokens).toBe(8_000)
    })

    it("splits the round's budget among the consumers still working", () => {
        const ledger = new ContextBudgetLedger(readings({ occupied: 20_000 }).port)
        const leases = [ledger.begin(), ledger.begin(), ledger.begin()]

        expect(ledger.snapshot().activeConsumers).toBe(3)
        expect(leases[0].snapshot().shareTokens).toBe(21_333)

        leases[0].end()
        expect(leases[1].snapshot().shareTokens).toBe(32_000)
    })

    it("counts a returned result against the round at once, keeping the round's base", () => {
        const ledger = new ContextBudgetLedger(readings({ occupied: 20_000 }).port)
        const first = ledger.begin()
        const second = ledger.begin()

        first.end(40_000)

        expect(ledger.snapshot()).toMatchObject({
            stagedTokens: 10_000,
            roundStagedTokens: 10_000,
            remainingTokens: 70_000,
            roundBudgetTokens: 64_000,
        })
        expect(second.snapshot().shareTokens).toBe(54_000)
    })

    it("ignores a second end of the same lease", () => {
        const ledger = new ContextBudgetLedger(readings().port)
        const lease = ledger.begin()
        ledger.begin()

        lease.end(4_000)
        lease.end(4_000)

        expect(ledger.snapshot().stagedTokens).toBe(1_000)
        expect(ledger.snapshot().activeConsumers).toBe(1)
    })

    it("keeps 32 parallel reads of one round within the round's budget", () => {
        const ledger = new ContextBudgetLedger(readings({ occupied: 10_000 }).port)
        const leases = Array.from({ length: 32 }, () => ledger.begin())
        const granted = leases.map((lease) => lease.shareBytes(64 * 1024))

        for (const [index, lease] of leases.entries()) lease.end(granted[index])

        expect(granted.every((bytes) => bytes === Math.floor(Math.floor(72_000 / 32) / 0.25))).toBe(true)
        expect(ledger.snapshot().roundStagedTokens).toBeLessThanOrEqual(ledger.snapshot().roundBudgetTokens)
    })

    it("leaves the absolute byte cap in place when the window has room", () => {
        const ledger = new ContextBudgetLedger(readings({ window: 1_000_000 }).port)

        expect(ledger.begin().shareBytes(64 * 1024)).toBe(64 * 1024)
    })

    it("converts tokens to bytes with the learned ratio and falls back when none is known", () => {
        const learned = new ContextBudgetLedger(readings({ window: 10_000, tokenPerByte: 0.5 }).port)
        const unknown = new ContextBudgetLedger(readings({ window: 10_000, tokenPerByte: Number.NaN }).port)

        expect(learned.shareBytes(1_000_000)).toBe(16_000)
        expect(unknown.shareBytes(1_000_000)).toBe(32_000)
    })

    it("asks consumers to yield once less than 3K tokens of context remain", () => {
        const { state, port } = readings({ occupied: 100_000 - CONTEXT_BUDGET_YIELD_TOKENS })
        const ledger = new ContextBudgetLedger(port)

        expect(ledger.snapshot().mustYield).toBe(false)
        ledger.stageTokens(1)
        expect(ledger.snapshot().mustYield).toBe(true)

        state.occupied = 100_000
        ledger.clearStaged()
        expect(ledger.snapshot()).toMatchObject({ remainingTokens: 0, shareTokens: 0, mustYield: true })
    })

    it("counts the subagents of a fan-out instead of the call that started them", () => {
        const ledger = new ContextBudgetLedger(readings({ occupied: 20_000 }).port)
        const fanOut = ledger.begin()
        ledger.begin()
        const subagents = [fanOut.child(), fanOut.child(), fanOut.child()]

        expect(ledger.snapshot().activeConsumers).toBe(4)
        expect(subagents[0].snapshot().shareTokens).toBe(16_000)

        for (const subagent of subagents) subagent.end()
        expect(ledger.snapshot().activeConsumers).toBe(2)
    })

    it("stages a fan-out's results once, when its subagents return them", () => {
        const ledger = new ContextBudgetLedger(readings({ occupied: 20_000 }).port)
        const fanOut = ledger.begin()
        const [first, second] = [fanOut.child(), fanOut.child()]

        first.end(40_000)
        second.end(40_000)
        expect(ledger.snapshot().stagedTokens).toBe(20_000)

        // The combined result repeats what the subagents returned, so it still
        // fits even though the round's unused budget no longer covers it a second time.
        expect(fanOut.shareBytes(1_000_000)).toBe(80_000 + 44_000 * 4)
        fanOut.end(82_000)
        expect(ledger.snapshot().stagedTokens).toBe(20_500)
    })

    it("keeps a background subagent drawing a share but leaves its result to background delivery", () => {
        const ledger = new ContextBudgetLedger(readings().port)
        const call = ledger.begin()
        const subagent = call.child()

        call.end(400)
        expect(ledger.snapshot()).toMatchObject({ activeConsumers: 1, stagedTokens: 100 })

        // Background delivery counts the result when it delivers it.
        subagent.end(4_000)
        expect(ledger.snapshot()).toMatchObject({ activeConsumers: 0, stagedTokens: 100 })
    })

    it("counts the images and documents a result carries on top of its text", () => {
        const ledger = new ContextBudgetLedger(readings().port)

        ledger.begin().end(400, 1_600)

        expect(ledger.snapshot().stagedTokens).toBe(1_700)
    })

    it("stops counting staged results once the indicator carries them", () => {
        const ledger = new ContextBudgetLedger(readings().port)
        ledger.stageTokens(5_000)

        ledger.clearStaged()

        expect(ledger.snapshot()).toMatchObject({ stagedTokens: 0, roundStagedTokens: 0, remainingTokens: 100_000 })
    })

    it("starts a new round at the checkpoint and keeps the composed round counted until its request opens", () => {
        const ledger = new ContextBudgetLedger(readings().port)
        ledger.stageTokens(5_000)

        ledger.checkpoint()
        // Compose or compaction may still stop: the round is not carried yet,
        // but its results no longer draw on the next round's budget.
        expect(ledger.snapshot()).toMatchObject({ stagedTokens: 5_000, roundStagedTokens: 0, roundBudgetTokens: 76_000 })

        ledger.stageTokens(1_000)
        ledger.retireCheckpoint()
        expect(ledger.snapshot()).toMatchObject({ stagedTokens: 1_000, roundStagedTokens: 1_000 })

        ledger.retireCheckpoint()
        expect(ledger.snapshot().stagedTokens).toBe(1_000)
    })

    it("never lets the shares of a wide fan-out exceed the round's budget", () => {
        const ledger = new ContextBudgetLedger(readings({ occupied: 99_000 }).port)
        const leases = Array.from({ length: 32 }, () => ledger.begin())

        const shares = leases.map((lease) => lease.shareBytes(Number.MAX_SAFE_INTEGER))

        expect(shares[0]).toBe(100)
        expect(shares.reduce((total, bytes) => total + bytes, 0) * 0.25).toBeLessThanOrEqual(ledger.snapshot().roundBudgetTokens)
    })

    it("leaves no body for a call once the context is full", () => {
        const lease = new ContextBudgetLedger(readings({ occupied: 100_000 }).port).begin()

        expect(lease.shareBytes(Number.MAX_SAFE_INTEGER)).toBe(0)
    })

    it("reserves only the room above the yield floor, outside the round's budget, and gives it back on release", () => {
        const { state, port } = readings({ occupied: 90_000 })
        const ledger = new ContextBudgetLedger(port)

        // 10K of context left, 7K of it above the yield floor: 28K bytes.
        const reservation = ledger.reserveBytes(40_000)
        expect(reservation?.bytes).toBe(28_000)
        expect(ledger.snapshot()).toMatchObject({ stagedTokens: 7_000, roundStagedTokens: 0 })
        expect(ledger.reserveBytes(1)).toBeUndefined()

        reservation?.release()
        reservation?.release()
        expect(ledger.snapshot().stagedTokens).toBe(0)

        state.occupied = 98_000
        expect(ledger.reserveBytes(1)).toBeUndefined()
    })
})

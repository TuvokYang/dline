import { describe, expect, it } from "vitest"
import { TODO_ROUND_BUCKETS, validateTodos } from "../../contracts/usageExecution"
import { applyTodoObservation, createMemoryTodoLedger, createTodoCounters, mergeTodoCounters, sealTodos } from "../todoProjection"

describe("todo ledger", () => {
    it("counts a declaration once even when the model repeats it", () => {
        const counters = createTodoCounters()
        const ledger = createMemoryTodoLedger()

        expect(applyTodoObservation(counters, ledger, { itemId: "a", transition: "declared", round: 1, at: 1_000 })).toEqual({
            sampled: false,
            unknownFirstSeen: false,
        })
        applyTodoObservation(counters, ledger, { itemId: "a", transition: "declared", round: 2, at: 2_000 })

        expect(counters.declared).toBe(1)
    })

    it("samples the rounds and active time between first sight and completion", () => {
        const counters = createTodoCounters()
        const ledger = createMemoryTodoLedger()

        applyTodoObservation(counters, ledger, { itemId: "a", transition: "declared", round: 1, at: 10_000 })
        const result = applyTodoObservation(counters, ledger, {
            itemId: "a",
            transition: "completed",
            round: 3,
            at: 40_000,
        })

        expect(result).toEqual({ sampled: true, unknownFirstSeen: false })
        expect(counters.rounds).toMatchObject({ count: 1, sum: 3, min: 3, max: 3 })
        expect(counters.activeMs).toMatchObject({ count: 1, sum: 30_000, min: 30_000, max: 30_000 })
    })

    it("counts a completion without inventing a round sample when first sight is gone", () => {
        const counters = createTodoCounters()
        const ledger = createMemoryTodoLedger()

        const result = applyTodoObservation(counters, ledger, {
            itemId: "lost",
            transition: "completed",
            round: 9,
            at: 99_000,
        })

        expect(result).toEqual({ sampled: false, unknownFirstSeen: true })
        expect(counters.completed).toBe(1)
        expect(counters.rounds.count).toBe(0)
    })

    it("makes a reopen observable and keeps the original first sight", () => {
        const counters = createTodoCounters()
        const ledger = createMemoryTodoLedger()

        applyTodoObservation(counters, ledger, { itemId: "a", transition: "declared", round: 1, at: 1_000 })
        applyTodoObservation(counters, ledger, { itemId: "a", transition: "completed", round: 2, at: 2_000 })
        applyTodoObservation(counters, ledger, { itemId: "a", transition: "reopened", round: 3, at: 3_000 })
        applyTodoObservation(counters, ledger, { itemId: "a", transition: "completed", round: 5, at: 5_000 })

        expect(counters.reopened).toBe(1)
        expect(counters.completed).toBe(2)
        // The second completion measures from the original declaration, not the reopen.
        expect(counters.rounds).toMatchObject({ count: 2, sum: 2 + 5, min: 2, max: 5 })
    })

    it("drops the occurrence when an item is abandoned", () => {
        const counters = createTodoCounters()
        const ledger = createMemoryTodoLedger()

        applyTodoObservation(counters, ledger, { itemId: "a", transition: "declared", round: 1, at: 1_000 })
        applyTodoObservation(counters, ledger, { itemId: "a", transition: "abandoned", round: 2, at: 2_000 })

        expect(counters.abandoned).toBe(1)
        expect(ledger.read("a")).toBeUndefined()
    })

    it("produces counters the wire validator accepts", () => {
        const counters = createTodoCounters()
        const ledger = createMemoryTodoLedger()

        applyTodoObservation(counters, ledger, { itemId: "a", transition: "declared", round: 1, at: 1_000 })
        applyTodoObservation(counters, ledger, { itemId: "b", transition: "declared", round: 1, at: 1_000 })
        applyTodoObservation(counters, ledger, { itemId: "a", transition: "completed", round: 2, at: 5_000 })
        applyTodoObservation(counters, ledger, { itemId: "b", transition: "abandoned", round: 4, at: 9_000 })

        const sealed = sealTodos(counters)

        expect(sealed).toBeDefined()
        expect(validateTodos(sealed as NonNullable<typeof sealed>)).toEqual([])
    })

    it("omits the object entirely when nothing was reported", () => {
        expect(sealTodos(createTodoCounters())).toBeUndefined()
    })

    it("keeps an empty round distribution at zero rather than a measured zero", () => {
        const counters = createTodoCounters()
        const ledger = createMemoryTodoLedger()

        // A completion with no first sight: the object exists, the samples do not.
        applyTodoObservation(counters, ledger, { itemId: "lost", transition: "completed", round: 1, at: 1_000 })
        const sealed = sealTodos(counters)

        expect(sealed?.rounds_to_complete).toEqual({
            count: 0,
            sum: 0,
            min: 0,
            max: 0,
            buckets: Array(TODO_ROUND_BUCKETS).fill(0),
        })
        expect(validateTodos(sealed as NonNullable<typeof sealed>)).toEqual([])
    })

    it("counts the item as declared in this batch when only its completion is reported here", () => {
        // The declaration went out in an earlier batch; this batch only observes
        // the completion. Counting the item is required, otherwise the counters
        // would claim a completion of something that was never declared.
        const counters = createTodoCounters()
        const ledger = createMemoryTodoLedger()

        applyTodoObservation(counters, ledger, { itemId: "earlier", transition: "completed", round: 4, at: 8_000 })

        expect(counters.declared).toBe(1)
        expect(counters.completed).toBe(1)
        const sealed = sealTodos(counters)
        expect(sealed?.declared).toBe(1)
        expect(validateTodos(sealed as NonNullable<typeof sealed>)).toEqual([])
    })

    it("counts one declaration when two minutes both saw the item", () => {
        const left = createTodoCounters()
        const leftLedger = createMemoryTodoLedger()
        applyTodoObservation(left, leftLedger, { itemId: "shared", transition: "declared", round: 1, at: 0 })

        const right = createTodoCounters()
        const rightLedger = createMemoryTodoLedger()
        applyTodoObservation(right, rightLedger, { itemId: "shared", transition: "declared", round: 1, at: 0 })

        const merged = mergeTodoCounters(left, right)

        expect(merged.declared).toBe(1)
    })

    it("merges two minutes of the same fact without losing bucket counts", () => {
        const first = createTodoCounters()
        const firstLedger = createMemoryTodoLedger()
        applyTodoObservation(first, firstLedger, { itemId: "a", transition: "declared", round: 1, at: 0 })
        applyTodoObservation(first, firstLedger, { itemId: "a", transition: "completed", round: 1, at: 1_000 })

        const second = createTodoCounters()
        const secondLedger = createMemoryTodoLedger()
        applyTodoObservation(second, secondLedger, { itemId: "b", transition: "declared", round: 2, at: 0 })
        applyTodoObservation(second, secondLedger, { itemId: "b", transition: "completed", round: 6, at: 2_000 })

        const merged = mergeTodoCounters(first, second)
        const sealed = sealTodos(merged)

        expect(sealed?.declared).toBe(2)
        expect(sealed?.completed).toBe(2)
        expect(sealed?.rounds_to_complete).toMatchObject({ count: 2, sum: 1 + 5, min: 1, max: 5 })
        expect(sealed?.rounds_to_complete?.buckets.reduce((total, value) => total + value, 0)).toBe(2)
        expect(validateTodos(sealed as NonNullable<typeof sealed>)).toEqual([])
    })
})

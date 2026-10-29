import { describe, expect, it, vi } from "vitest"
import { KeyedMutationQueue } from "./keyed-mutation-queue"

describe("KeyedMutationQueue", () => {
    it("serializes operations for the same key", async () => {
        const queue = new KeyedMutationQueue()
        let releaseFirst: (() => void) | undefined
        const order: string[] = []
        const first = queue.enqueue(
            "global:subagent:reviewer",
            () =>
                new Promise<void>((resolve) => {
                    order.push("first-start")
                    releaseFirst = () => {
                        order.push("first-end")
                        resolve()
                    }
                }),
        )
        const second = queue.enqueue("global:subagent:reviewer", async () => {
            order.push("second")
        })

        expect(order).toEqual(["first-start"])
        releaseFirst?.()
        await Promise.all([first, second])
        expect(order).toEqual(["first-start", "first-end", "second"])
    })

    it("continues the same-key queue after an earlier failure", async () => {
        const queue = new KeyedMutationQueue()
        const second = vi.fn(async () => undefined)
        const firstWrite = queue.enqueue("global:rule:review.md", async () => {
            throw new Error("write failed")
        })
        const secondWrite = queue.enqueue("global:rule:review.md", second)

        await expect(firstWrite).rejects.toThrow("write failed")
        await secondWrite
        expect(second).toHaveBeenCalledOnce()
    })

    it("allows different resource keys to run independently", async () => {
        const queue = new KeyedMutationQueue()
        let releaseFirst: (() => void) | undefined
        const first = queue.enqueue(
            "global:rule:first.md",
            () =>
                new Promise<void>((resolve) => {
                    releaseFirst = resolve
                }),
        )
        const second = vi.fn(async () => undefined)

        await queue.enqueue("global:rule:second.md", second)
        expect(second).toHaveBeenCalledOnce()
        releaseFirst?.()
        await first
    })
})

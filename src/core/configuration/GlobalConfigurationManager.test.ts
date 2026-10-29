import assert from "node:assert/strict"
import { describe, it, vi } from "vitest"
import { GlobalConfigurationManager } from "./GlobalConfigurationManager"

describe("GlobalConfigurationManager", () => {
    it("captures one snapshot and applies it to every component in registration order", async () => {
        const snapshot = Object.freeze({ revision: 1 })
        const createSnapshot = vi.fn(() => snapshot)
        const received: Array<{ id: string; snapshot: typeof snapshot }> = []
        const manager = new GlobalConfigurationManager(createSnapshot)
        manager.register({
            id: "first",
            configure: (value) => {
                received.push({ id: "first", snapshot: value })
            },
        })
        manager.register({
            id: "second",
            configure: (value) => {
                received.push({ id: "second", snapshot: value })
            },
        })

        const result = await manager.configureAll()

        assert.equal(createSnapshot.mock.calls.length, 1)
        assert.deepEqual(received, [
            { id: "first", snapshot },
            { id: "second", snapshot },
        ])
        assert.deepEqual(
            result.components.map((component) => component.id),
            ["first", "second"],
        )
    })

    it("attempts every component before reporting aggregate failures", async () => {
        const second = vi.fn()
        const manager = new GlobalConfigurationManager(() => ({ revision: 1 }))
        manager.register({
            id: "failing",
            configure: () => {
                throw new Error("configuration failed")
            },
        })
        manager.register({ id: "second", configure: second })

        await assert.rejects(manager.configureAll(), AggregateError)
        assert.equal(second.mock.calls.length, 1)
    })

    it("serializes overlapping configuration runs", async () => {
        let releaseFirst!: () => void
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve
        })
        let revision = 0
        const createSnapshot = vi.fn(() => ({ revision: ++revision }))
        const applied: number[] = []
        const manager = new GlobalConfigurationManager(createSnapshot)
        manager.register({
            id: "terminal",
            configure: async (snapshot) => {
                if (snapshot.revision === 1) await firstGate
                applied.push(snapshot.revision)
            },
        })

        const first = manager.configureAll()
        await vi.waitFor(() => assert.equal(createSnapshot.mock.calls.length, 1))
        const second = manager.configureAll()
        await Promise.resolve()
        assert.equal(createSnapshot.mock.calls.length, 1)

        releaseFirst()
        await Promise.all([first, second])
        assert.deepEqual(applied, [1, 2])
    })
})

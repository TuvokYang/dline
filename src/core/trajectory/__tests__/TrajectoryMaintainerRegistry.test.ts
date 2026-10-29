import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { UiMessage } from "@/shared/ExtensionMessage"
import { closeInstanceStoragesUnder, ensureInstanceLayout } from "../../storage/instance"
import { openUiMessageRows, UI_MESSAGE_WRITER } from "../../storage/messages/openUiMessageRows"
import { openTrajectoryRows } from "../../storage/trajectory/openTrajectoryRows"
import { UIMessage } from "../../storage/UIMessage"
import type { CommittedUiMessages } from "../CommittedUiMessages"
import {
    type CatchUpOutcome,
    TRAJECTORY_SLICE_ROWS,
    TrajectoryMaintainer,
    type TrajectoryWriteAccess,
} from "../TrajectoryMaintainer"
import { type MaintainedTask, type TrajectoryAccess, TrajectoryMaintainerRegistry } from "../TrajectoryMaintainerRegistry"

const KEY = "task-instance-root"

/** A maintainer and message source that only record what the registry asks of them. */
function fakeTask() {
    let commitListener: (() => void) | undefined
    const catchUp = vi.fn(async (_access: TrajectoryWriteAccess): Promise<CatchUpOutcome> => "ready")
    const closeMaintainer = vi.fn(async () => undefined)
    const closeMessages = vi.fn(async () => undefined)
    const unsubscribe = vi.fn()
    const task: MaintainedTask = {
        maintainer: { catchUp, close: closeMaintainer } as unknown as TrajectoryMaintainer,
        messages: {
            signals: {
                subscribe: (listener: () => void) => {
                    commitListener = listener
                    return unsubscribe
                },
            },
            close: closeMessages,
        } as unknown as CommittedUiMessages,
    }
    return { task, catchUp, closeMaintainer, closeMessages, unsubscribe, commit: () => commitListener?.() }
}

function switchableAccess(initial: boolean): { readonly access: TrajectoryAccess; set(writable: boolean): void } {
    let writable = initial
    const listeners = new Set<() => void>()
    return {
        access: {
            writable: () => writable,
            onDidChange: (listener) => {
                listeners.add(listener)
                return () => listeners.delete(listener)
            },
        },
        set(next) {
            writable = next
            for (const listener of [...listeners]) listener()
        },
    }
}

describe("TrajectoryMaintainerRegistry", () => {
    let registry: TrajectoryMaintainerRegistry

    beforeEach(() => {
        vi.useFakeTimers()
        registry = new TrajectoryMaintainerRegistry()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it("catches up on acquire and once more after a burst of commits pauses", async () => {
        const fake = fakeTask()
        await registry.acquire(KEY, switchableAccess(true).access, async () => fake.task)
        await vi.advanceTimersByTimeAsync(0)
        expect(fake.catchUp).toHaveBeenCalledTimes(1)

        for (let commit = 0; commit < 5; commit++) {
            fake.commit()
            await vi.advanceTimersByTimeAsync(20)
        }
        expect(fake.catchUp).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(100)
        expect(fake.catchUp).toHaveBeenCalledTimes(2)
    })

    it("catches up at least once a second under a steady stream of commits", async () => {
        const fake = fakeTask()
        await registry.acquire(KEY, switchableAccess(true).access, async () => fake.task)
        await vi.advanceTimersByTimeAsync(0)

        // Each commit arrives inside the trailing window of the previous one.
        for (let elapsed = 0; elapsed < 1_000; elapsed += 50) {
            fake.commit()
            await vi.advanceTimersByTimeAsync(50)
        }

        expect(fake.catchUp).toHaveBeenCalledTimes(2)
    })

    it("shares one maintainer per key and lets it write while any lease may write", async () => {
        const fake = fakeTask()
        const create = vi.fn(async () => fake.task)
        const viewer = switchableAccess(false)
        const owner = switchableAccess(true)

        const first = await registry.acquire(KEY, viewer.access, create)
        await vi.advanceTimersByTimeAsync(0)
        const asked = fake.catchUp.mock.calls[0][0]
        expect(asked.writable()).toBe(false)

        const second = await registry.acquire(KEY, owner.access, create)
        expect(create).toHaveBeenCalledTimes(1)
        expect(second.maintainer).toBe(first.maintainer)
        expect(asked.writable()).toBe(true)

        // The answer is read at each write, so a lock lost mid-job stops the next write.
        owner.set(false)
        expect(asked.writable()).toBe(false)
        owner.set(true)
        await second.release()
        expect(asked.writable()).toBe(false)
    })

    it("catches up again when write access changes", async () => {
        const fake = fakeTask()
        const access = switchableAccess(false)
        await registry.acquire(KEY, access.access, async () => fake.task)
        await vi.advanceTimersByTimeAsync(0)

        access.set(true)
        await vi.advanceTimersByTimeAsync(100)

        expect(fake.catchUp).toHaveBeenCalledTimes(2)
    })

    it("closes the maintainer and the messages only when the last lease is released", async () => {
        const fake = fakeTask()
        const create = vi.fn(async () => fake.task)
        const first = await registry.acquire(KEY, switchableAccess(true).access, create)
        const second = await registry.acquire(KEY, switchableAccess(true).access, create)
        await vi.advanceTimersByTimeAsync(0)

        await first.release()
        expect(fake.closeMaintainer).not.toHaveBeenCalled()
        expect(fake.closeMessages).not.toHaveBeenCalled()

        await second.release()
        expect(fake.closeMaintainer).toHaveBeenCalledTimes(1)
        expect(fake.closeMessages).toHaveBeenCalledTimes(1)
        expect(fake.unsubscribe).toHaveBeenCalledTimes(1)

        const catchUps = fake.catchUp.mock.calls.length
        fake.commit()
        await vi.advanceTimersByTimeAsync(1_000)
        expect(fake.catchUp).toHaveBeenCalledTimes(catchUps)

        await registry.acquire(KEY, switchableAccess(true).access, create)
        expect(create).toHaveBeenCalledTimes(2)
    })

    it("creates no second maintainer for a key until the previous one has finished closing", async () => {
        const order: string[] = []
        let finishClose: () => void = () => undefined
        const first = fakeTask()
        first.closeMaintainer.mockImplementation(async () => {
            order.push("close begin 1")
            await new Promise<void>((resolve) => {
                finishClose = resolve
            })
            order.push("close end 1")
        })
        const second = fakeTask()
        const lease = await registry.acquire(KEY, switchableAccess(true).access, async () => {
            order.push("create 1")
            return first.task
        })

        const released = lease.release()
        const reacquired = registry.acquire(KEY, switchableAccess(true).access, async () => {
            order.push("create 2")
            return second.task
        })
        await vi.advanceTimersByTimeAsync(0)
        expect(order).toEqual(["create 1", "close begin 1"])

        finishClose()
        await released
        await reacquired
        expect(order).toEqual(["create 1", "close begin 1", "close end 1", "create 2"])
    })
})

describe("TrajectoryMaintainerRegistry with a running maintainer", () => {
    const taskId = "task-registry"
    let documentsRoot: string

    beforeEach(async () => {
        documentsRoot = await mkdtemp(path.join(os.tmpdir(), "dline-trajectory-registry-"))
        vi.stubEnv("DLINE_DOCS_DIR", documentsRoot)
    })

    afterEach(async () => {
        await closeInstanceStoragesUnder(documentsRoot)
        vi.unstubAllEnvs()
        await rm(documentsRoot, { recursive: true, force: true })
    })

    it("opens trajectory.db once when a catch-up and a stream's first read start together", async () => {
        const { root } = await ensureInstanceLayout({ taskId })
        const writer = await openUiMessageRows(root, UI_MESSAGE_WRITER)
        const prompt = { ts: 1_000, type: "say", say: "task", text: "prompt" } as UiMessage
        await writer.replaceAll([{ ordinal: 0, ts: prompt.ts, message: prompt }])
        await writer.close()
        const messages = await UIMessage.openCommittedUiMessages(taskId)
        const openStore = vi.fn(() => openTrajectoryRows(root))
        const maintainer = new TrajectoryMaintainer({ instanceId: taskId, messages, openStore })

        // A second handle would be a second writer, and the catch-up would fail on its first write.
        const [outcome] = await Promise.all([maintainer.catchUp({ writable: () => true }), maintainer.readSnapshot(-1)])

        expect(outcome).toBe("ready")
        expect(openStore).toHaveBeenCalledTimes(1)
        expect((await maintainer.readSnapshot(-1)).turns.map((turn) => turn.prompt)).toEqual(["prompt"])
        await maintainer.close()
        await messages.close()
    })

    it("publishes an error another maintainer wrote even when no local commit follows", async () => {
        const { root } = await ensureInstanceLayout({ taskId })
        const writer = await openUiMessageRows(root, UI_MESSAGE_WRITER)
        const prompt = { ts: 1_000, type: "say", say: "task", text: "prompt" } as UiMessage
        await writer.replaceAll([{ ordinal: 0, ts: prompt.ts, message: prompt }])
        await writer.close()
        const messages = await UIMessage.openCommittedUiMessages(taskId)
        const store = await openTrajectoryRows(root)
        const viewer = new TrajectoryMaintainer({ instanceId: taskId, messages, openStore: async () => store })
        const published: string[] = []
        viewer.onDidWrite((meta) => published.push(meta.state))
        expect(await viewer.catchUp({ writable: () => true })).toBe("ready")

        // A second maintainer sees a ts violation and persists the error through the shared store.
        const violating: CommittedUiMessages = {
            ...messages,
            log: { ...messages.log, head: async () => ({ ...(await messages.log.head()), violationTs: prompt.ts }) },
        }
        const other = new TrajectoryMaintainer({ instanceId: taskId, messages: violating, openStore: async () => store })
        expect(await other.catchUp({ writable: () => true })).toBe("error")

        expect(await viewer.catchUp({ writable: () => true })).toBe("error")
        expect(published.slice(-2)).toEqual(["ready", "error"])
        await store.close()
        await messages.close()
    })

    it("stops a running build at a slice boundary and closes both databases on the last release", async () => {
        const { root } = await ensureInstanceLayout({ taskId })
        const writer = await openUiMessageRows(root, UI_MESSAGE_WRITER)
        const rows = Array.from(
            { length: 2 * TRAJECTORY_SLICE_ROWS + 1 },
            (_, ordinal) =>
                ({
                    ts: 1_000 + ordinal,
                    type: "say",
                    say: ordinal === 0 ? "task" : "tool",
                    text: ordinal === 0 ? "prompt" : JSON.stringify({ tool: "readFile", path: "a.ts" }),
                }) as UiMessage,
        )
        await writer.replaceAll(rows.map((message, ordinal) => ({ ordinal, ts: message.ts, message })))
        await writer.close()

        const store = await openTrajectoryRows(root)
        const source = await UIMessage.openCommittedUiMessages(taskId)
        let reads = 0
        let resume: () => void = () => undefined
        const paused = new Promise<void>((resolve) => {
            resume = resolve
        })
        const messages: CommittedUiMessages = {
            ...source,
            rows: {
                readRange: async (start, end) => {
                    reads++
                    if (reads === 2) await paused
                    return source.rows.readRange(start, end)
                },
            },
        }
        const maintainer = new TrajectoryMaintainer({ instanceId: taskId, messages, openStore: async () => store })
        const access: TrajectoryAccess = { writable: () => true, onDidChange: () => () => undefined }
        const lease = await new TrajectoryMaintainerRegistry().acquire(KEY, access, async () => ({ maintainer, messages }))
        await vi.waitFor(() => expect(reads).toBe(2))

        const released = lease.release()
        resume()
        await released

        await expect(store.readMeta()).rejects.toThrow()
        await expect(source.rows.readRange(0, 1)).rejects.toThrow()
        // It wrote nothing for the slice it was reading, so the persisted job still ends after the first one.
        const inspect = await openTrajectoryRows(root)
        expect((await inspect.readMeta())?.job?.nextOrdinal).toBe(TRAJECTORY_SLICE_ROWS)
        await inspect.close()
    })
})

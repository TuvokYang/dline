import { describe, expect, it, vi } from "vitest"
import type { ComposeRoundCommand, TaskEvent } from "../../kernel"
import { ComposeCommandExecutor } from "./ComposeCommandExecutor"

const command: ComposeRoundCommand = {
    commandId: "compose:1",
    originRevision: 1,
    generation: 0,
    type: "compose.round",
    turnId: "turn-1",
    admittedEntryIds: ["entry-1"],
}

const queuedCommand: ComposeRoundCommand = {
    ...command,
    queueDelivery: {
        deliveryId: "delivery-1",
        point: "tool_round",
        ownerId: command.commandId,
        generation: command.generation,
    },
}

const queueAcceptance = {
    type: "input_queue.delivery_accepted",
    generation: 0,
    commandId: "compose:1",
    originRevision: 1,
    deliveryId: "delivery-1",
}

function recorder() {
    const events: TaskEvent[] = []
    return {
        events,
        sink: {
            submit: vi.fn(async (event: TaskEvent) => {
                events.push(event)
                return { kind: "accepted" as const }
            }),
        },
    }
}

describe("ComposeCommandExecutor", () => {
    it("emits compose.completed with only the durable draft reference", async () => {
        const recorded = recorder()
        const compose = vi.fn(async () => ({ draftRef: "draft:1" }))
        await new ComposeCommandExecutor({ compose }, recorded.sink).execute(command)
        expect(compose).toHaveBeenCalledWith({
            turnId: "turn-1",
            admittedEntryIds: ["entry-1"],
            signal: expect.any(AbortSignal),
            composeCommandId: "compose:1",
            freezeMaterial: expect.any(Function),
        })
        expect(recorded.events).toEqual([
            {
                type: "compose.completed",
                generation: 0,
                commandId: "compose:1",
                originRevision: 1,
                turnId: "turn-1",
                draftRef: "draft:1",
            },
        ])
    })

    it.each(["accepted", "rejected"] as const)("publishes retained input only after %s durable completion", async (outcome) => {
        const visibleInputs: string[] = []
        const events: TaskEvent[] = []
        let acknowledge!: () => void
        let persist!: () => void
        const acknowledged = new Promise<void>((resolve) => {
            acknowledge = resolve
        })
        const durable = new Promise<void>((resolve) => {
            persist = resolve
        })
        const executor = new ComposeCommandExecutor(
            {
                compose: async () => ({
                    draftRef: "draft:retained",
                    presentation: {
                        commit: async () => {
                            visibleInputs.push("steer")
                        },
                    },
                }),
                rollbackRetainedQueue: async () => "released",
            },
            {
                submit: async (event) => {
                    events.push(event)
                    if (event.type !== "compose.completed") return { kind: "accepted" }
                    acknowledge()
                    return outcome === "accepted" ? { kind: "accepted", durable } : { kind: "rejected" }
                },
            },
        )
        const execution = executor.execute(queuedCommand)
        await acknowledged
        expect(visibleInputs).toEqual([])
        persist()
        await execution
        expect(visibleInputs).toEqual(outcome === "accepted" ? ["steer"] : [])
        expect(events.find((event) => event.type === "compose.completed")).not.toHaveProperty("presentation")
    })

    // The message enters the conversation and keeps only the failure kind; the
    // chat's error box names the actual error, with credentials redacted.
    it("emits a sanitized failure event that the chat can still explain", async () => {
        const recorded = recorder()
        const executor = new ComposeCommandExecutor(
            {
                compose: vi.fn(async () =>
                    Promise.reject(new Error("Context file unreadable with Authorization: Bearer abc.def-secret")),
                ),
            },
            recorded.sink,
        )
        await executor.execute(command)
        expect(recorded.events).toEqual([
            {
                type: "compose.failed",
                generation: 0,
                commandId: "compose:1",
                originRevision: 1,
                turnId: "turn-1",
                message: "compose execution failed (Error)",
                presentation: JSON.stringify({
                    message: "Dline compose execution failed: Context file unreadable with Authorization: Bearer [REDACTED]",
                    code: "Error",
                }),
            },
        ])
        expect(JSON.stringify(recorded.events)).not.toContain("abc.def-secret")
    })

    it("fails a round whose owed work failed, carrying its domain's own explanation", async () => {
        const recorded = recorder()
        const rollbackRetainedQueue = vi.fn(async () => "released" as const)
        const executor = new ComposeCommandExecutor(
            {
                compose: vi.fn(async () => ({
                    failed: { reason: "automatic_compaction_failed", presentation: "Provider rejected the Pass" },
                })),
                rollbackRetainedQueue,
            },
            recorded.sink,
        )

        await executor.execute(queuedCommand)

        expect(rollbackRetainedQueue).toHaveBeenCalledTimes(1)
        expect(recorded.events).toEqual([
            queueAcceptance,
            {
                type: "compose.failed",
                generation: 0,
                commandId: "compose:1",
                originRevision: 1,
                turnId: "turn-1",
                message: "automatic_compaction_failed",
                presentation: "Provider rejected the Pass",
                queueDisposition: "released",
            },
        ])
    })

    it("retracts a retained batch before reporting a compose failure", async () => {
        const recorded = recorder()
        const rollbackRetainedQueue = vi.fn(async () => "released" as const)
        const executor = new ComposeCommandExecutor(
            {
                compose: vi.fn(async () => Promise.reject(new Error("after-stage"))),
                rollbackRetainedQueue,
            },
            recorded.sink,
        )

        await executor.execute(queuedCommand)

        expect(rollbackRetainedQueue).toHaveBeenCalledWith(
            expect.objectContaining({
                queueDelivery: queuedCommand.queueDelivery,
                signal: expect.any(AbortSignal),
            }),
        )
        expect(recorded.events).toEqual([
            queueAcceptance,
            expect.objectContaining({ type: "compose.failed", queueDisposition: "released" }),
        ])
    })

    it("withdraws a stale completed draft after atomically retracting its retained batch", async () => {
        const events: TaskEvent[] = []
        const rollbackRetainedQueue = vi.fn(async () => "released" as const)
        const sink = {
            submit: vi.fn(async (event: TaskEvent) => {
                events.push(event)
                return event.type === "compose.completed" ? { kind: "rejected" as const } : { kind: "accepted" as const }
            }),
        }

        await new ComposeCommandExecutor(
            { compose: async () => ({ draftRef: "draft:stale" }), rollbackRetainedQueue },
            sink,
        ).execute(queuedCommand)

        expect(rollbackRetainedQueue).toHaveBeenCalledTimes(1)
        expect(events).toEqual([
            queueAcceptance,
            expect.objectContaining({ type: "compose.completed", draftRef: "draft:stale" }),
            expect.objectContaining({
                type: "compose.withdrawn",
                reason: "compose_completion_rejected",
                queueDisposition: "released",
            }),
        ])
    })

    it("keeps a stale retained delivery uncertain when rollback cannot be proven", async () => {
        const events: TaskEvent[] = []
        const sink = {
            submit: vi.fn(async (event: TaskEvent) => {
                events.push(event)
                return event.type === "compose.completed" ? { kind: "rejected" as const } : { kind: "accepted" as const }
            }),
        }

        await new ComposeCommandExecutor(
            {
                compose: async () => ({ draftRef: "draft:stale" }),
                rollbackRetainedQueue: async () => {
                    throw new Error("tombstone unavailable")
                },
            },
            sink,
        ).execute(queuedCommand)

        expect(events[2]).toMatchObject({ type: "compose.withdrawn", queueDisposition: "uncertain" })
    })

    it("does not compose or freeze retained material before queue acceptance is durable", async () => {
        let release!: () => void
        const durable = new Promise<void>((resolve) => {
            release = resolve
        })
        let submitted!: () => void
        const accepted = new Promise<void>((resolve) => {
            submitted = resolve
        })
        const compose = vi.fn(async () => ({ draftRef: "draft:accepted" }))
        const executor = new ComposeCommandExecutor(
            { compose },
            {
                submit: async (event) => {
                    if (event.type === "input_queue.delivery_accepted") {
                        submitted()
                        return { kind: "accepted", durable }
                    }
                    return { kind: "accepted" }
                },
            },
        )
        const execution = executor.execute(queuedCommand)
        await accepted
        expect(compose).not.toHaveBeenCalled()
        release()
        await execution
        expect(compose).toHaveBeenCalledOnce()
    })

    it.each(["rejected", "persist_failed"] as const)("does not compose after queue acceptance is %s", async (outcome) => {
        const compose = vi.fn(async () => ({ draftRef: "unreachable" }))
        const executor = new ComposeCommandExecutor(
            { compose, rollbackRetainedQueue: async () => "released" },
            {
                submit: async (event) =>
                    event.type !== "input_queue.delivery_accepted"
                        ? { kind: "accepted" }
                        : outcome === "rejected"
                          ? { kind: "rejected" }
                          : { kind: "accepted", durable: Promise.reject(new Error("Vault unavailable")) },
            },
        )
        await executor.execute(queuedCommand)
        expect(compose).not.toHaveBeenCalled()
    })

    it("cancels without emitting a business failure", async () => {
        const recorded = recorder()
        let started!: () => void
        const ready = new Promise<void>((resolve) => (started = resolve))
        const executor = new ComposeCommandExecutor(
            {
                compose: async ({ signal }) => {
                    started()
                    await new Promise<void>((_resolve, reject) =>
                        signal.addEventListener(
                            "abort",
                            () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })),
                            { once: true },
                        ),
                    )
                    return { draftRef: "unreachable" }
                },
            },
            recorded.sink,
        )
        const execution = executor.execute(command)
        await ready
        expect(executor.cancel(command.commandId)).toBe(true)
        await execution
        expect(recorded.events).toEqual([])
    })
})

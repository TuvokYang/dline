import { describe, expect, it, vi } from "vitest"
import { InMemoryBackgroundDeliveryLedger } from "../stores"
import { decodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { BackgroundResultsEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import type { ActiveTaskSession } from "./ActiveTaskSession"
import { type BackgroundDeliveryBudget, TaskBackgroundIngressOwner } from "./TaskBackgroundIngressOwner"

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

function sessionFixture(input?: {
    readonly submission?: { readonly kind: "accepted"; readonly durable?: Promise<void> } | { readonly kind: "rejected" }
    readonly background?: readonly { readonly entryId: string; readonly payloadRef: string }[]
}) {
    let encoded: Uint8Array | undefined
    const ledger = new InMemoryBackgroundDeliveryLedger()
    const payloads = {
        put: vi.fn(async (payload: Uint8Array) => {
            encoded = payload
            return "payload-background-1"
        }),
    }
    const publish = vi.fn(async () => input?.submission ?? { kind: "accepted" as const })
    const session = {
        payloads,
        assembly: { background: { publish } },
        state: () => ({ intake: { background: input?.background ?? [] } }),
    } as unknown as ActiveTaskSession
    return {
        session,
        ledger,
        payloads,
        publish,
        readEnvelope: () => decodeTaskPayload<BackgroundResultsEnvelope>(encoded ?? new Uint8Array()),
    }
}

/** Room in bytes: a delivered result takes what fits of it, and a release gives it back. */
function budgetFixture(roomBytes: number) {
    const state = { roomBytes }
    const reserved: number[] = []
    const released = vi.fn()
    const budget: BackgroundDeliveryBudget = {
        reserveBytes: (textBytes) => {
            if (state.roomBytes <= 0) return undefined
            const bytes = Math.min(textBytes, state.roomBytes)
            state.roomBytes -= bytes
            reserved.push(bytes)
            return {
                bytes,
                release: () => {
                    released(bytes)
                    state.roomBytes += bytes
                },
            }
        },
    }
    return { state, reserved, released, budget }
}

function stageSubagentResult(ledger: InMemoryBackgroundDeliveryLedger, id: string, text: string) {
    return ledger.stage({
        entryId: `background:subagent:${id}:attempt:1`,
        producerKind: "subagent",
        producerId: id,
        attempt: 1,
        text,
    })
}

describe("TaskBackgroundIngressOwner", () => {
    it("acknowledges a producer only after canonical intake is durable", async () => {
        const durable = deferred()
        const fixture = sessionFixture({ submission: { kind: "accepted", durable: durable.promise } })
        const acknowledge = vi.fn()
        const owner = new TaskBackgroundIngressOwner(() => fixture.session, fixture.ledger)

        const publication = owner.publish({
            entryId: "background:command:command_1:attempt:1",
            producerKind: "command",
            producerId: "command_1",
            attempt: 1,
            text: "# Background Results\n## Background Command Results\n- command_1: completed",
            acknowledge,
        })
        await vi.waitFor(() => expect(fixture.publish).toHaveBeenCalledOnce())

        expect(await fixture.ledger.listPending()).toHaveLength(1)
        expect(acknowledge).not.toHaveBeenCalled()
        expect(fixture.readEnvelope()).toEqual({
            kind: "background_results",
            text: "# Background Results\n## Background Command Results\n- command_1: completed",
        })
        expect(fixture.publish).toHaveBeenCalledWith({
            entryId: "background:command:command_1:attempt:1",
            payloadRef: "payload-background-1",
        })

        durable.resolve()
        await publication
        expect(await fixture.ledger.listPending()).toEqual([])
        expect(acknowledge).toHaveBeenCalledOnce()
    })

    it("replays a producer result staged before process restart", async () => {
        const fixture = sessionFixture()
        await fixture.ledger.stage({
            entryId: "background:subagent:job_1:attempt:2",
            producerKind: "subagent",
            producerId: "job_1",
            attempt: 2,
            text: "# Background Results\n## Background Subagent Results\n- job_1: completed",
        })
        const owner = new TaskBackgroundIngressOwner(() => fixture.session, fixture.ledger)

        await owner.activate()

        expect(fixture.publish).toHaveBeenCalledWith({
            entryId: "background:subagent:job_1:attempt:2",
            payloadRef: "payload-background-1",
        })
        expect(await fixture.ledger.listPending()).toEqual([])
    })

    it("coalesces concurrent delivery of the same stable producer entry", async () => {
        const durable = deferred()
        const fixture = sessionFixture({ submission: { kind: "accepted", durable: durable.promise } })
        const acknowledge = vi.fn()
        const owner = new TaskBackgroundIngressOwner(() => fixture.session, fixture.ledger)
        const delivery = {
            entryId: "background:command:command_2:attempt:1",
            producerKind: "command" as const,
            producerId: "command_2",
            attempt: 1,
            text: "result",
            acknowledge,
        }

        const first = owner.publish(delivery)
        const second = owner.publish(delivery)
        expect(second).toBe(first)
        await vi.waitFor(() => expect(fixture.publish).toHaveBeenCalledOnce())
        durable.resolve()
        await Promise.all([first, second])

        expect(fixture.payloads.put).toHaveBeenCalledOnce()
        expect(acknowledge).toHaveBeenCalledOnce()
    })

    it("acknowledges a rejected duplicate only when canonical state owns the same payload", async () => {
        const fixture = sessionFixture({
            submission: { kind: "rejected" },
            background: [{ entryId: "background:command:command_3:attempt:1", payloadRef: "payload-background-1" }],
        })
        const acknowledge = vi.fn()
        const owner = new TaskBackgroundIngressOwner(() => fixture.session, fixture.ledger)

        await owner.publish({
            entryId: "background:command:command_3:attempt:1",
            producerKind: "command",
            producerId: "command_3",
            attempt: 1,
            text: "result",
            acknowledge,
        })

        expect(acknowledge).toHaveBeenCalledOnce()
    })

    it("fails closed without acknowledging a rejected non-duplicate", async () => {
        const fixture = sessionFixture({ submission: { kind: "rejected" } })
        const acknowledge = vi.fn()
        const owner = new TaskBackgroundIngressOwner(() => fixture.session, fixture.ledger)

        await expect(
            owner.publish({
                entryId: "background:command:command_4:attempt:1",
                producerKind: "command",
                producerId: "command_4",
                attempt: 1,
                text: "result",
                acknowledge,
            }),
        ).rejects.toThrow("BackgroundIngressRejected")
        expect(acknowledge).not.toHaveBeenCalled()
    })

    describe("context budget", () => {
        it("holds a result in the ledger while the conversation has no room", async () => {
            const fixture = sessionFixture()
            const { budget, reserved } = budgetFixture(0)
            const acknowledge = vi.fn()
            const owner = new TaskBackgroundIngressOwner(() => fixture.session, fixture.ledger, budget)

            await owner.publish({
                entryId: "background:subagent:job_1:attempt:1",
                producerKind: "subagent",
                producerId: "job_1",
                attempt: 1,
                text: "held result",
                acknowledge,
            })

            expect(fixture.publish).not.toHaveBeenCalled()
            expect(reserved).toEqual([])
            expect(acknowledge).toHaveBeenCalledOnce()
            expect((await fixture.ledger.listPending()).map((entry) => entry.entryId)).toEqual([
                "background:subagent:job_1:attempt:1",
            ])
        })

        it("releases held results while the budget admits them and keeps the rest waiting", async () => {
            const fixture = sessionFixture()
            const { budget, reserved, state } = budgetFixture(Buffer.byteLength("first result", "utf8"))
            await stageSubagentResult(fixture.ledger, "job_1", "first result")
            await stageSubagentResult(fixture.ledger, "job_2", "second")
            const owner = new TaskBackgroundIngressOwner(() => fixture.session, fixture.ledger, budget)

            await owner.releaseHeld()

            expect(fixture.publish).toHaveBeenCalledOnce()
            expect(fixture.publish).toHaveBeenCalledWith({
                entryId: "background:subagent:job_1:attempt:1",
                payloadRef: "payload-background-1",
            })
            expect(reserved).toEqual([Buffer.byteLength("first result", "utf8")])
            expect((await fixture.ledger.listPending()).map((entry) => entry.entryId)).toEqual([
                "background:subagent:job_2:attempt:1",
            ])

            state.roomBytes = 1_000
            await owner.releaseHeld()

            expect(fixture.publish).toHaveBeenCalledTimes(2)
            expect(await fixture.ledger.listPending()).toEqual([])
        })

        it("replays results staged before restart only through the budget", async () => {
            const fixture = sessionFixture()
            const { budget } = budgetFixture(0)
            await stageSubagentResult(fixture.ledger, "job_1", "result")
            const owner = new TaskBackgroundIngressOwner(() => fixture.session, fixture.ledger, budget)

            await owner.activate()

            expect(fixture.publish).not.toHaveBeenCalled()
            expect(await fixture.ledger.listPending()).toHaveLength(1)
        })

        it("publishes a held result once when releases overlap", async () => {
            const fixture = sessionFixture()
            const { budget } = budgetFixture(1_000)
            await stageSubagentResult(fixture.ledger, "job_1", "result")
            const owner = new TaskBackgroundIngressOwner(() => fixture.session, fixture.ledger, budget)

            await Promise.all([owner.releaseHeld(), owner.releaseHeld(), owner.activate()])

            expect(fixture.publish).toHaveBeenCalledOnce()
            expect(await fixture.ledger.listPending()).toEqual([])
        })

        it("cuts a result to the room left instead of overflowing the conversation", async () => {
            const fixture = sessionFixture()
            const { budget, reserved } = budgetFixture(200)
            const owner = new TaskBackgroundIngressOwner(() => fixture.session, fixture.ledger, budget)

            await owner.publish({
                entryId: "background:command:command_9:attempt:1",
                producerKind: "command",
                producerId: "command_9",
                attempt: 1,
                text: "x".repeat(1_000),
                acknowledge: vi.fn(),
            })

            const text = fixture.readEnvelope().text
            expect(reserved).toEqual([200])
            expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(200)
            expect(text.startsWith("xxxx")).toBe(true)
            expect(text.includes("[OUTPUT TRUNCATED:")).toBe(true)
        })

        it("gives the room back when the delivery fails", async () => {
            const fixture = sessionFixture({ submission: { kind: "rejected" } })
            const { budget, released, state } = budgetFixture(1_000)
            const owner = new TaskBackgroundIngressOwner(() => fixture.session, fixture.ledger, budget)

            await expect(
                owner.publish({
                    entryId: "background:command:command_10:attempt:1",
                    producerKind: "command",
                    producerId: "command_10",
                    attempt: 1,
                    text: "result",
                    acknowledge: vi.fn(),
                }),
            ).rejects.toThrow("BackgroundIngressRejected")

            expect(released).toHaveBeenCalledWith(Buffer.byteLength("result", "utf8"))
            expect(state.roomBytes).toBe(1_000)
        })
    })
})

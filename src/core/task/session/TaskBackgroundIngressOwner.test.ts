import { describe, expect, it, vi } from "vitest"
import { InMemoryBackgroundDeliveryLedger } from "../stores"
import { decodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { BackgroundResultsEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import type { ActiveTaskSession } from "./ActiveTaskSession"
import { TaskBackgroundIngressOwner } from "./TaskBackgroundIngressOwner"

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
})
